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
    this.pressTime = config.pressTime || 1000; // Reduced from 3000ms
    this.scanDuration = config.scanDuration || 5000;
    this.scanRetries = config.scanRetries || 3;
    this.scanRetryCooldown = config.scanRetryCooldown || 1000;
    this.batteryCheckInterval = (config.batteryCheckInterval || 60) * 60 * 1000;

    // Tuya BLE protocol state
    this.sequenceNumber = Math.floor(Math.random() * 0xFFFF); // Start with random seq
    this.sessionKey = null;
    this.isAuthenticated = false;

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
      // Convert localKey to buffer - ensure it's exactly 16 bytes
      let keyBuffer;
      if (this.localKey.length === 32) {
        // Hex string
        keyBuffer = Buffer.from(this.localKey, 'hex');
      } else {
        // UTF8 string - pad or truncate to 16 bytes
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

  // Improved packet creation with proper Tuya BLE format
  createTuyaBLEPacket(commandType, data = Buffer.alloc(0)) {
    try {
      this.sequenceNumber = (this.sequenceNumber + 1) & 0xFFFF;
      
      // Tuya BLE packet format:
      // [header(2)] [seq(2)] [cmd(1)] [len(2)] [data(n)] [checksum(1)]
      const header = Buffer.from([0x55, 0xaa]);
      
      // Sequence number (2 bytes, little endian for BLE)
      const seqBuffer = Buffer.alloc(2);
      seqBuffer.writeUInt16LE(this.sequenceNumber, 0);
      
      // Command type (1 byte)
      const cmdBuffer = Buffer.from([commandType]);
      
      // Data length (2 bytes, little endian)
      const lengthBuffer = Buffer.alloc(2);
      lengthBuffer.writeUInt16LE(data.length, 0);
      
      // Build payload before encryption
      const payload = Buffer.concat([seqBuffer, cmdBuffer, lengthBuffer, data]);
      
      // Calculate checksum (simple sum of all bytes)
      const preChecksumData = Buffer.concat([header, payload]);
      let checksum = 0;
      for (let i = 0; i < preChecksumData.length; i++) {
        checksum = (checksum + preChecksumData[i]) & 0xFF;
      }
      
      // Final packet
      const packet = Buffer.concat([header, payload, Buffer.from([checksum])]);
      
      this.log(`[DEBUG] Tuya BLE packet (cmd 0x${commandType.toString(16)}): ${packet.toString('hex')}`);
      return packet;
      
    } catch (error) {
      this.log(`[DEBUG] Error creating Tuya BLE packet: ${error}`);
      return null;
    }
  }

  // Create pairing/auth packet
  createPairPacket() {
    // For Fingerbot Plus firmware 2.0, try pairing command first
    const pairData = Buffer.concat([
      Buffer.from(this.deviceId, 'utf8'),
      Buffer.from([0x00, 0x00]) // Additional padding
    ]);
    return this.createTuyaBLEPacket(0x01, pairData);
  }

  // Create simple switch command for Fingerbot Plus
  createSwitchCommand(state) {
    // Fingerbot Plus uses simple switch commands
    // DP 1 = switch state, DP 2 = direction (optional)
    const dpData = Buffer.from([
      0x01,        // DP ID 1 (main switch)
      0x01,        // DP type (BOOL) 
      0x00, 0x01,  // Data length (1 byte)
      state ? 0x01 : 0x00  // Value
    ]);
    return this.createTuyaBLEPacket(0x06, dpData);
  }

  // Create status query
  createStatusQuery() {
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
      }, 15000);

      peripheral.connect((error) => {
        if (error) {
          this.log(`[DEBUG] Connection error: ${error}`);
          cleanup();
          this.currentPeripheral = null;
          return reject(error);
        }

        this.log('[DEBUG] Connected, discovering services...');
        
        // Immediate service discovery
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

          this.log(`[DEBUG] Discovered ${services?.length || 0} services, ${characteristics?.length || 0} characteristics`);

          // Find the correct characteristics
          const writeChar = characteristics.find(char => char.uuid === '2b11');
          const notifyChar = characteristics.find(char => char.uuid === '2b10');

          if (!writeChar) {
            this.log('[DEBUG] No write characteristic (2b11) found');
            cleanup();
            this.forceDisconnect();
            return reject(new Error('No write characteristic found'));
          }

          this.log(`[DEBUG] Using write characteristic: ${writeChar.uuid}`);
          if (notifyChar) {
            this.log(`[DEBUG] Using notify characteristic: ${notifyChar.uuid}`);
          }

          this.executeFingerbot(writeChar, notifyChar, peripheral, cleanup, resolve, reject);
        });
      });
    });
  }

  executeFingerbot(writeChar, notifyChar, peripheral, cleanup, resolve, reject) {
    this.log('[DEBUG] Starting Fingerbot command sequence...');
    
    this.generateSessionKey();
    
    let commandStep = 0;
    let operationTimeout = null;
    let stepCompleted = false;

    // Set overall operation timeout
    operationTimeout = setTimeout(() => {
      this.log('[DEBUG] Overall operation timeout');
      cleanup();
      this.forceDisconnect();
      reject(new Error('Operation timeout'));
    }, 10000);

    // Set up notifications if available
    if (notifyChar) {
      notifyChar.subscribe((error) => {
        if (error) {
          this.log(`[DEBUG] Notification subscription error: ${error}`);
        } else {
          this.log('[DEBUG] Subscribed to notifications');
          
          notifyChar.on('data', (data) => {
            this.log(`[DEBUG] Notification received: ${data.toString('hex')}`);
            // Parse response for battery level, status, etc.
            this.parseNotificationData(data);
          });
        }
      });
    }

    const executeNextStep = () => {
      commandStep++;
      stepCompleted = false;
      
      if (peripheral.state !== 'connected') {
        cleanup();
        return reject(new Error('Device disconnected during command sequence'));
      }

      let packet = null;
      let stepDelay = 200; // Default delay between steps

      switch (commandStep) {
        case 1:
          this.log('[DEBUG] Step 1: Sending status query...');
          packet = this.createStatusQuery();
          stepDelay = 300;
          break;
          
        case 2:
          this.log('[DEBUG] Step 2: Sending switch ON command...');
          packet = this.createSwitchCommand(true);
          stepDelay = this.pressTime; // Hold for press duration
          break;
          
        case 3:
          this.log('[DEBUG] Step 3: Sending switch OFF command...');
          packet = this.createSwitchCommand(false);
          stepDelay = 300;
          break;
          
        case 4:
          this.log('[DEBUG] Step 4: Final status query...');
          packet = this.createStatusQuery();
          stepDelay = 200;
          break;
          
        default:
          this.log('[DEBUG] Command sequence completed successfully');
          clearTimeout(operationTimeout);
          cleanup();
          this.forceDisconnect();
          resolve();
          return;
      }

      if (packet) {
        const useResponse = writeChar.properties.includes('writeWithoutResponse');
        writeChar.write(packet, !useResponse, (error) => {
          if (error) {
            this.log(`[DEBUG] Error in step ${commandStep}: ${error}`);
            clearTimeout(operationTimeout);
            cleanup();
            this.forceDisconnect();
            return reject(error);
          } else {
            this.log(`[DEBUG] Step ${commandStep} sent successfully`);
            stepCompleted = true;
            
            // Schedule next step
            setTimeout(() => {
              if (stepCompleted) {
                executeNextStep();
              }
            }, stepDelay);
          }
        });
      }
    };

    // Start command sequence
    setTimeout(executeNextStep, 100);
  }

  parseNotificationData(data) {
    try {
      if (data.length >= 8) {
        // Basic Tuya BLE response parsing
        const header = data.readUInt16BE(0);
        if (header === 0x55aa || header === 0xaa55) {
          const cmdType = data[5]; // Command type usually at offset 5
          this.log(`[DEBUG] Response command type: 0x${cmdType.toString(16)}`);
          
          // Look for battery level in status responses
          if (cmdType === 0x08 && data.length > 10) {
            // Try to extract battery level from status response
            for (let i = 6; i < data.length - 2; i++) {
              if (data[i] === 0x02) { // DP ID 2 might be battery
                const dpType = data[i + 1];
                if (dpType === 0x02 && i + 5 < data.length) { // INTEGER type
                  const batteryLevel = data.readUInt32BE(i + 2) & 0xFF;
                  if (batteryLevel <= 100) {
                    this.batteryLevel = batteryLevel;
                    this.log(`[DEBUG] Battery level updated: ${batteryLevel}%`);
                    this.batteryService.updateCharacteristic(Characteristic.BatteryLevel, batteryLevel);
                  }
                }
              }
            }
          }
        }
      }
    } catch (error) {
      this.log(`[DEBUG] Error parsing notification: ${error}`);
    }
  }

  async validateDeviceOnStartup() {
    this.log('[DEBUG] Starting initial scan to validate Fingerbot services...');
    let found = false;
    let scanTimeout = null;

    const discoverHandler = async (peripheral) => {
      if (peripheral.address === this.address && !found) {
        found = true;
        noble.removeListener('discover', discoverHandler);
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
              
              // Try to read device info if available
              const deviceNameChar = characteristics.find(c => c.uuid === '2a00');
              if (deviceNameChar) {
                deviceNameChar.read((err, data) => {
                  if (!err && data) {
                    this.log(`[DEBUG] [Startup] Device name: ${data.toString()}`);
                  }
                });
              }
            }
            
            setTimeout(() => {
              peripheral.disconnect();
            }, 500);
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
      try {
        noble.stopScanning();
      } catch (e) {}
      noble.removeListener('discover', discoverHandler);
      if (!found) {
        this.log('[DEBUG] [Startup] Could not find Fingerbot during initial scan');
      }
    }, 8000);
  }
}