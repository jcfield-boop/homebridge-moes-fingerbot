const noble = require('@abandonware/noble');
const debug = require('debug')('homebridge-moes-fingerbot');
const crypto = require('crypto');

let Service, Characteristic;

module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory('homebridge-moes-fingerbot', 'MoesFingerbot', MoesFingerbotAccessory);
};

class MoesFingerbotAccessory {
  constructor(log, config) {
    this.log = log;
    this.name = config.name || 'MOES Fingerbot';
    this.address = config.address.toLowerCase();

    // REQUIRED: Tuya BLE credentials
    this.deviceId = config.deviceId;
    this.localKey = config.localKey;
    
    if (!this.deviceId || !this.localKey) {
      this.log('ERROR: deviceId and localKey are required for Tuya BLE devices');
      this.log('Use tuya-local-key-extractor to get these values');
      throw new Error('Missing required Tuya BLE credentials');
    }

    // Optional configuration
    this.pressTime = config.pressTime || 3000;
    this.scanDuration = config.scanDuration || 5000;
    this.scanRetries = config.scanRetries || 3;
    this.scanRetryCooldown = config.scanRetryCooldown || 1000;
    this.batteryCheckInterval = (config.batteryCheckInterval || 60) * 60 * 1000;

    // Tuya BLE protocol state
    this.sequenceNumber = 0;
    this.sessionKey = null;
    this.isAuthenticated = false;
    this.tuyaTimestamp = 0;

    // Device state
    this.isOn = false;
    this.batteryLevel = -1;
    this.lastBatteryCheck = 0;
    this.connecting = false;
    this.currentOperation = null;
    this.currentPeripheral = null;

    this.switchService = new Service.Switch(this.name);
    this.switchService
      .getCharacteristic(Characteristic.On)
      .on('get', this.getOn.bind(this))
      .on('set', this.setOn.bind(this));

    this.batteryService = new Service.BatteryService(this.name);
    this.batteryService
      .getCharacteristic(Characteristic.BatteryLevel)
      .on('get', this.getBatteryLevel.bind(this));

    noble.on('stateChange', (state) => {
      if (state === 'poweredOn') {
        this.log('Bluetooth adapter is powered on');
        setTimeout(() => {
          this.validateDeviceOnStartup();
        }, 2000);
      } else {
        this.log('Bluetooth adapter is powered off or unavailable');
        this.forceDisconnect();
      }
    });
  }

  getServices() {
    return [this.switchService, this.batteryService];
  }

  getOn(callback) {
    this.log(`Getting power state: ${this.isOn}`);
    callback(null, this.isOn);
  }

  setOn(value, callback) {
    this.log(`Setting power state to: ${value}`);

    if (value) {
      if (this.currentOperation) {
        this.log('[DEBUG] Operation already in progress, ignoring new request');
        callback(new Error('Operation in progress'));
        return;
      }

      this.currentOperation = this.pressButton()
        .then(() => {
          this.isOn = true;
          callback(null);

          setTimeout(() => {
            this.isOn = false;
            this.switchService.updateCharacteristic(Characteristic.On, false);
          }, this.pressTime);
        })
        .catch(error => {
          this.log(`Error pressing button: ${error}`);
          callback(error);
        })
        .finally(() => {
          this.currentOperation = null;
        });
    } else {
      callback(null);
    }
  }

  getBatteryLevel(callback) {
    const now = Date.now();
    if (now - this.lastBatteryCheck > this.batteryCheckInterval) {
      this.lastBatteryCheck = now;
      this.log(`[DEBUG] (Battery) Polled device for battery level: ${this.batteryLevel}`);
    } else {
      this.log(`[DEBUG] (Battery) Returning cached battery level: ${this.batteryLevel}`);
    }
    callback(null, this.batteryLevel >= 0 && this.batteryLevel <= 100 ? this.batteryLevel : 0);
  }

  forceDisconnect() {
    if (this.currentPeripheral) {
      try {
        this.log('[DEBUG] Force disconnecting existing peripheral');
        this.currentPeripheral.disconnect();
      } catch (e) {
        this.log(`[DEBUG] Error force disconnecting: ${e}`);
      }
      this.currentPeripheral = null;
    }
    this.connecting = false;
    this.isAuthenticated = false;
    this.sessionKey = null;
  }

  // Tuya BLE protocol implementation
  generateSessionKey() {
    if (!this.localKey || !this.deviceId) {
      this.log('[DEBUG] Missing localKey or deviceId for session key generation');
      return null;
    }

    try {
      // Convert localKey to buffer if it's hex
      let keyBuffer;
      if (this.localKey.length === 32) {
        keyBuffer = Buffer.from(this.localKey, 'hex');
      } else {
        keyBuffer = Buffer.from(this.localKey, 'utf8');
        if (keyBuffer.length > 16) {
          keyBuffer = keyBuffer.slice(0, 16);
        } else if (keyBuffer.length < 16) {
          const padded = Buffer.alloc(16);
          keyBuffer.copy(padded);
          keyBuffer = padded;
        }
      }

      this.sessionKey = keyBuffer;
      this.log(`[DEBUG] Generated session key: ${this.sessionKey.toString('hex')}`);
      return this.sessionKey;
    } catch (error) {
      this.log(`[DEBUG] Error generating session key: ${error}`);
      return null;
    }
  }

  // Tuya BLE packet structure
  createTuyaBLEPacket(commandType, data = Buffer.alloc(0)) {
    try {
      this.sequenceNumber = (this.sequenceNumber + 1) & 0xFFFFFFFF;
      
      // Tuya BLE header: [0x55, 0xaa]
      const header = Buffer.from([0x55, 0xaa]);
      
      // Sequence number (4 bytes, big endian)
      const seqBuffer = Buffer.alloc(4);
      seqBuffer.writeUInt32BE(this.sequenceNumber, 0);
      
      // Command type (1 byte)
      const cmdBuffer = Buffer.from([commandType]);
      
      // Data length (2 bytes, big endian)
      const lengthBuffer = Buffer.alloc(2);
      lengthBuffer.writeUInt16BE(data.length, 0);
      
      // Build payload (everything except header and checksum)
      const payload = Buffer.concat([seqBuffer, cmdBuffer, lengthBuffer, data]);
      
      // If we have a session key, encrypt the payload
      let finalPayload = payload;
      if (this.sessionKey) {
        try {
          const cipher = crypto.createCipheriv('aes-128-ecb', this.sessionKey, null);
          cipher.setAutoPadding(true);
          finalPayload = Buffer.concat([cipher.update(payload), cipher.final()]);
          this.log(`[DEBUG] Encrypted payload: ${finalPayload.toString('hex')}`);
        } catch (encError) {
          this.log(`[DEBUG] Encryption failed, using raw payload: ${encError}`);
          finalPayload = payload;
        }
      }
      
      // Calculate checksum
      const checksumData = Buffer.concat([header, finalPayload]);
      let checksum = 0;
      for (let i = 0; i < checksumData.length; i++) {
        checksum += checksumData[i];
      }
      checksum = checksum & 0xFF;
      
      // Final packet
      const packet = Buffer.concat([header, finalPayload, Buffer.from([checksum])]);
      
      this.log(`[DEBUG] Tuya BLE packet (cmd ${commandType}): ${packet.toString('hex')}`);
      return packet;
      
    } catch (error) {
      this.log(`[DEBUG] Error creating Tuya BLE packet: ${error}`);
      return null;
    }
  }

  // Tuya BLE authentication sequence
  createLoginPacket() {
    // Login command (0x01) with device ID
    const deviceIdBuffer = Buffer.from(this.deviceId, 'utf8');
    return this.createTuyaBLEPacket(0x01, deviceIdBuffer);
  }

  createHeartbeatPacket() {
    // Heartbeat command (0x02)
    const timestamp = Math.floor(Date.now() / 1000);
    const timestampBuffer = Buffer.alloc(4);
    timestampBuffer.writeUInt32BE(timestamp, 0);
    return this.createTuyaBLEPacket(0x02, timestampBuffer);
  }

  // Fingerbot control commands
  createPressDPCommand() {
    // DP command (0x06) - Fingerbot switch DP is usually 1
    // DPS format: {dp_id: 1, dp_type: BOOL, dp_data: true}
    const dpData = Buffer.from([
      0x01,        // DP ID (1 = switch)
      0x01,        // DP type (BOOL)
      0x00, 0x01,  // Data length
      0x01         // Value (true)
    ]);
    return this.createTuyaBLEPacket(0x06, dpData);
  }

  createReleaseDPCommand() {
    // DP command (0x06) - Fingerbot switch DP off
    const dpData = Buffer.from([
      0x01,        // DP ID (1 = switch)
      0x01,        // DP type (BOOL)
      0x00, 0x01,  // Data length
      0x00         // Value (false)
    ]);
    return this.createTuyaBLEPacket(0x06, dpData);
  }

  createStatusQueryPacket() {
    // Query device status (0x08)
    return this.createTuyaBLEPacket(0x08, Buffer.alloc(0));
  }

  async pressButton() {
    return new Promise((resolve, reject) => {
      this.log('Scanning for Fingerbot...');

      this.forceDisconnect();

      let retryCount = 0;
      let scanTimeout = null;
      let peripheralFound = false;

      const discoverHandler = async (peripheral) => {
        if (peripheral.address === this.address && !peripheralFound) {
          peripheralFound = true;
          this.log(`Found Fingerbot: ${peripheral.address}`);
          
          try {
            noble.stopScanning();
          } catch (e) {
            this.log(`[DEBUG] Error stopping scan: ${e}`);
          }
          
          clearTimeout(scanTimeout);
          noble.removeListener('discover', discoverHandler);

          try {
            await this.connectAndPress(peripheral);
            resolve();
          } catch (error) {
            reject(error);
          }
        }
      };

      const startScan = () => {
        peripheralFound = false;
        noble.removeAllListeners('discover');
        noble.on('discover', discoverHandler);
        
        try {
          noble.startScanning([], true);
        } catch (e) {
          this.log(`[DEBUG] Error starting scan: ${e}`);
          noble.removeListener('discover', discoverHandler);
          reject(new Error('Failed to start scanning'));
          return;
        }

        scanTimeout = setTimeout(() => {
          try {
            noble.stopScanning();
          } catch (e) {
            this.log(`[DEBUG] Error stopping scan: ${e}`);
          }
          noble.removeListener('discover', discoverHandler);

          if (!peripheralFound && retryCount < this.scanRetries) {
            retryCount++;
            this.log(`Scan attempt ${retryCount} failed, retrying...`);
            setTimeout(startScan, this.scanRetryCooldown);
          } else if (!peripheralFound) {
            reject(new Error('Failed to find Fingerbot device after multiple attempts'));
          }
        }, this.scanDuration);
      };

      startScan();
    });
  }

  async connectAndPress(peripheral) {
    return new Promise((resolve, reject) => {
      this.log('Connecting to Fingerbot...');

      if (this.connecting) {
        return reject(new Error('Already connecting'));
      }

      if (peripheral.state === 'connected') {
        this.log('[DEBUG] Peripheral already connected, disconnecting first...');
        try {
          peripheral.disconnect();
          setTimeout(() => this.connectAndPress(peripheral).then(resolve).catch(reject), 1000);
          return;
        } catch (e) {
          this.log(`[DEBUG] Error disconnecting existing connection: ${e}`);
        }
      }

      this.connecting = true;
      this.currentPeripheral = peripheral;
      this.isAuthenticated = false;
      this.sequenceNumber = 0;
      this.sessionKey = null;

      let connectionTimeout = null;
      let disconnectHandler = null;

      const cleanup = () => {
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
        }
        if (disconnectHandler) {
          peripheral.removeListener('disconnect', disconnectHandler);
          disconnectHandler = null;
        }
        this.connecting = false;
      };

      disconnectHandler = () => {
        this.log('[DEBUG] Peripheral disconnected');
        this.currentPeripheral = null;
        cleanup();
        reject(new Error('Device disconnected during operation'));
      };

      peripheral.once('disconnect', disconnectHandler);

      connectionTimeout = setTimeout(() => {
        this.log('[DEBUG] Connection timeout');
        cleanup();
        this.forceDisconnect();
        reject(new Error('Connection timeout'));
      }, 20000);

      peripheral.connect((error) => {
        if (error) {
          this.log(`[DEBUG] Connection error: ${error}`);
          cleanup();
          this.currentPeripheral = null;
          return reject(error);
        }

        this.log('[DEBUG] Connected, discovering services...');
        
        setTimeout(() => {
          if (peripheral.state !== 'connected') {
            cleanup();
            return reject(new Error('Device disconnected before service discovery'));
          }

          peripheral.discoverAllServicesAndCharacteristics((error, services, characteristics) => {
            if (error) {
              this.log(`[DEBUG] Service discovery error: ${error}`);
              cleanup();
              this.forceDisconnect();
              return reject(error);
            }

            if (peripheral.state !== 'connected') {
              cleanup();
              return reject(new Error('Device disconnected during service discovery'));
            }

            clearTimeout(connectionTimeout);
            connectionTimeout = setTimeout(() => {
              this.log('[DEBUG] Operation timeout');
              cleanup();
              this.forceDisconnect();
              reject(new Error('Operation timeout'));
            }, 15000);

            this.handleTuyaBLESequence(services, characteristics, peripheral, () => {
              cleanup();
              resolve();
            }, (error) => {
              cleanup();
              reject(error);
            });
          });
        }, 1000);
      });
    });
  }

  handleTuyaBLESequence(services, characteristics, peripheral, resolve, reject) {
    this.log(`[DEBUG] Discovered ${services?.length || 0} services, ${characteristics?.length || 0} characteristics`);
    
    if (!characteristics || characteristics.length === 0) {
      this.forceDisconnect();
      return reject(new Error('No characteristics found'));
    }

    // Find Tuya BLE characteristics
    const writeChar = characteristics.find(char => char.uuid === '2b11') ||
                     characteristics.find(char => char.properties.includes('writeWithoutResponse')) ||
                     characteristics.find(char => char.properties.includes('write'));

    const notifyChar = characteristics.find(char => char.uuid === '2b10') ||
                      characteristics.find(char => char.properties.includes('notify'));

    if (!writeChar) {
      this.log('[DEBUG] No writable characteristic found');
      this.forceDisconnect();
      return reject(new Error('No writable characteristic found'));
    }

    this.log(`[DEBUG] Using write characteristic: ${writeChar.uuid}`);
    if (notifyChar) {
      this.log(`[DEBUG] Using notify characteristic: ${notifyChar.uuid}`);
    }

    this.executeTuyaBLEAuthentication(writeChar, notifyChar, peripheral, resolve, reject);
  }

  executeTuyaBLEAuthentication(writeChar, notifyChar, peripheral, resolve, reject) {
    this.log('[DEBUG] Starting Tuya BLE authentication sequence...');

    // Generate session key first
    this.generateSessionKey();

    let authStep = 0;
    let authTimeout = null;
    let responseReceived = false;

    const stepTimeout = () => {
      authTimeout = setTimeout(() => {
        if (!responseReceived) {
          this.log(`[DEBUG] Auth step ${authStep} timeout, proceeding anyway...`);
          nextStep();
        }
      }, 2000);
    };

    const nextStep = () => {
      if (authTimeout) {
        clearTimeout(authTimeout);
        authTimeout = null;
      }
      responseReceived = false;
      authStep++;
      executeAuthStep();
    };

    // Set up notification handler if available
    if (notifyChar) {
      const notifyHandler = (data) => {
        this.log(`[DEBUG] Auth response: ${data.toString('hex')}`);
        responseReceived = true;
        
        // Parse response if needed
        if (data.length >= 7) {
          const cmdType = data[6]; // Command type is usually at offset 6
          this.log(`[DEBUG] Response command type: 0x${cmdType.toString(16)}`);
          
          if (cmdType === 0x01) {
            this.log('[DEBUG] Login response received');
            this.isAuthenticated = true;
          } else if (cmdType === 0x06) {
            this.log('[DEBUG] DP command response received');
          }
        }
        
        nextStep();
      };

      notifyChar.subscribe((error) => {
        if (error) {
          this.log(`[DEBUG] Error subscribing to notifications: ${error}`);
        } else {
          this.log(`[DEBUG] Subscribed to notifications`);
          notifyChar.on('data', notifyHandler);
        }
      });
    }

    const executeAuthStep = () => {
      if (peripheral.state !== 'connected') {
        return reject(new Error('Device disconnected during authentication'));
      }

      let packet = null;
      
      switch (authStep) {
        case 1:
          this.log('[DEBUG] Step 1: Sending login packet...');
          packet = this.createLoginPacket();
          break;
          
        case 2:
          this.log('[DEBUG] Step 2: Sending heartbeat...');
          packet = this.createHeartbeatPacket();
          break;
          
        case 3:
          this.log('[DEBUG] Step 3: Sending status query...');
          packet = this.createStatusQueryPacket();
          break;
          
        case 4:
          this.log('[DEBUG] Step 4: Sending press command...');
          packet = this.createPressDPCommand();
          // After sending the press command, wait pressTime before proceeding to release
          setTimeout(nextStep, this.pressTime);
          return; // Prevent automatic nextStep
        case 5:
          this.log('[DEBUG] Step 5: Sending release command...');
          packet = this.createReleaseDPCommand();
          setTimeout(() => {
            this.log('[DEBUG] Tuya BLE sequence completed');
            this.forceDisconnect();
            resolve();
          }, 300); // Short delay after release
          break;
          
        default:
          this.log('[DEBUG] Authentication sequence completed');
          this.forceDisconnect();
          resolve();
          return;
      }

      if (packet) {
        writeChar.write(packet, false, (error) => {
          if (error) {
            this.log(`[DEBUG] Error in auth step ${authStep}: ${error}`);
            // Continue anyway
            setTimeout(nextStep, 100);
          } else {
            this.log(`[DEBUG] Auth step ${authStep} sent successfully`);
            if (!notifyChar || authStep >= 4) {
              // No notifications or in control phase, proceed automatically
              setTimeout(nextStep, authStep >= 4 ? 200 : 500);
            } else {
              stepTimeout();
            }
          }
        });
      }
    };

    // Start authentication sequence
    executeAuthStep();
  }

  async validateDeviceOnStartup() {
    this.log('[DEBUG] Starting initial scan to validate Fingerbot services...');
    let found = false;
    let scanTimeout = null;

    const discoverHandler = async (peripheral) => {
      if (peripheral.address === this.address && !found) {
        found = true;
        noble.removeListener('discover', discoverHandler); // <-- Add this line
        this.log(`[DEBUG] [Startup] Found Fingerbot: ${peripheral.address}`);
        try {
          noble.stopScanning();
        } catch (e) {}
        clearTimeout(scanTimeout);

        peripheral.connect((error) => {
          if (error) {
            this.log(`[DEBUG] [Startup] Connection error: ${error}`);
            return;
          }
          this.log('[DEBUG] [Startup] Connected, discovering services...');
          peripheral.discoverAllServicesAndCharacteristics((err, services, characteristics) => {
            if (err) {
              this.log(`[DEBUG] [Startup] Service discovery error: ${err}`);
            } else {
              this.log(`[DEBUG] [Startup] Discovered ${services.length} services, ${characteristics.length} characteristics`);
              services.forEach(s => this.log(`[DEBUG] [Startup] Service: ${s.uuid}`));
              characteristics.forEach(c => this.log(`[DEBUG] [Startup] Characteristic: ${c.uuid}, properties: ${JSON.stringify(c.properties)}`));
            }
            peripheral.disconnect();
          });
        });

        peripheral.once('disconnect', () => {
          this.log('[DEBUG] [Startup] Peripheral disconnected');
        });
      }
    };

    noble.on('discover', discoverHandler);

    try {
      noble.startScanning([], true);
    } catch (e) {
      this.log(`[DEBUG] [Startup] Error starting scan: ${e}`);
      noble.removeListener('discover', discoverHandler);
      return;
    }

    scanTimeout = setTimeout(() => {
      noble.stopScanning();
      noble.removeListener('discover', discoverHandler);
      if (!found) {
        this.log('[DEBUG] [Startup] Could not find Fingerbot during initial scan');
      }
    }, 8000);
  }
}