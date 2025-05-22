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
    this.pressTime = config.pressTime || 1000;
    this.scanDuration = config.scanDuration || 8000; // Increased scan time
    this.scanRetries = config.scanRetries || 3;
    this.scanRetryCooldown = config.scanRetryCooldown || 2000; // Increased cooldown
    this.batteryCheckInterval = (config.batteryCheckInterval || 60) * 60 * 1000;

    // Tuya BLE protocol state
    this.sequenceNumber = Math.floor(Math.random() * 0xFFFF);
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
          this.getBatteryStatus();
        }, 3000);
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
      this.log(`[DEBUG] (Battery) Requesting fresh battery level...`);
      
      // Trigger battery check in background
      this.getBatteryStatus().catch(err => {
        this.log(`[DEBUG] (Battery) Background check failed: ${err.message}`);
      });
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

  // Generate proper session key from localKey
  generateSessionKey() {
    if (!this.localKey) {
      this.log('[DEBUG] Missing localKey for session key generation');
      return null;
    }

    try {
      let keyBuffer;
      
      // Handle hex string (32 chars = 16 bytes hex)
      if (this.localKey.length === 32 && /^[0-9a-fA-F]+$/.test(this.localKey)) {
        keyBuffer = Buffer.from(this.localKey, 'hex');
      } else {
        // Handle UTF-8 string - ensure exactly 16 bytes
        keyBuffer = Buffer.from(this.localKey, 'utf8');
        if (keyBuffer.length > 16) {
          keyBuffer = keyBuffer.slice(0, 16);
        } else if (keyBuffer.length < 16) {
          const padded = Buffer.alloc(16, 0);
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

  // Create Tuya BLE packet with proper authentication
  createTuyaBLEPacket(commandType, data = Buffer.alloc(0), encrypt = true) {
    try {
      this.sequenceNumber = (this.sequenceNumber + 1) & 0xFFFFFFFF;
      
      // Tuya BLE packet structure:
      // [0x55, 0xaa] [seq(4)] [cmd(1)] [len(2)] [data] [checksum(1)]
      const header = Buffer.from([0x55, 0xaa]);
      
      // Sequence number (4 bytes, big endian)
      const seqBuffer = Buffer.alloc(4);
      seqBuffer.writeUInt32BE(this.sequenceNumber, 0);
      
      // Command type (1 byte)
      const cmdBuffer = Buffer.from([commandType]);
      
      // Prepare data payload
      let finalData = data;
      
      // Encrypt data if we have session key and encryption is requested
      if (encrypt && this.sessionKey && data.length > 0) {
        try {
          // Add device ID to data for authentication
          const authData = Buffer.concat([
            Buffer.from(this.deviceId, 'utf8'),
            data
          ]);
          
          // Encrypt with AES-128-ECB
          const cipher = crypto.createCipher('aes-128-ecb', this.sessionKey);
          const encrypted = Buffer.concat([cipher.update(authData), cipher.final()]);
          finalData = encrypted;
          this.log(`[DEBUG] Encrypted payload: ${finalData.toString('hex')}`);
        } catch (encError) {
          this.log(`[DEBUG] Encryption failed, using raw data: ${encError}`);
          finalData = data;
        }
      }
      
      // Data length (2 bytes, big endian)
      const lengthBuffer = Buffer.alloc(2);
      lengthBuffer.writeUInt16BE(finalData.length, 0);
      
      // Build payload
      const payload = Buffer.concat([seqBuffer, cmdBuffer, lengthBuffer, finalData]);
      
      // Calculate checksum
      const preChecksum = Buffer.concat([header, payload]);
      let checksum = 0;
      for (let i = 0; i < preChecksum.length; i++) {
        checksum = (checksum + preChecksum[i]) & 0xFF;
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

  // Authentication packets
  createLoginPacket() {
    const loginData = Buffer.from(this.deviceId, 'utf8');
    return this.createTuyaBLEPacket(0x01, loginData, false);
  }

  createHeartbeatPacket() {
    const timestamp = Math.floor(Date.now() / 1000);
    const timestampBuffer = Buffer.alloc(4);
    timestampBuffer.writeUInt32BE(timestamp, 0);
    return this.createTuyaBLEPacket(0x02, timestampBuffer, true);
  }

  // Device command packets
  createStatusQueryPacket() {
    return this.createTuyaBLEPacket(0x08, Buffer.alloc(0), true);
  }

  createDPCommandPacket(dpId, dpType, value) {
    let valueBuffer;
    
    switch (dpType) {
      case 0x01: // BOOL
        valueBuffer = Buffer.from([value ? 0x01 : 0x00]);
        break;
      case 0x02: // INT (4 bytes)
        valueBuffer = Buffer.alloc(4);
        valueBuffer.writeUInt32BE(value, 0);
        break;
      case 0x03: // STRING
        valueBuffer = Buffer.from(value.toString(), 'utf8');
        break;
      default:
        valueBuffer = Buffer.from([value]);
    }
    
    const dpData = Buffer.concat([
      Buffer.from([dpId]),                           // DP ID
      Buffer.from([dpType]),                         // DP Type
      Buffer.alloc(2).fill(0).writeUInt16BE(valueBuffer.length, 0), // Length (2 bytes)
      valueBuffer                                    // Value
    ]);
    
    return this.createTuyaBLEPacket(0x06, dpData, true);
  }

  // Battery status reading
  async getBatteryStatus() {
    return new Promise((resolve, reject) => {
      this.log('[DEBUG] (Battery) Starting battery status check...');
      
      if (this.connecting || this.currentOperation) {
        this.log('[DEBUG] (Battery) Device busy, skipping battery check');
        return reject(new Error('Device busy'));
      }

      let scanTimeout = null;
      let found = false;

      const discoverHandler = async (peripheral) => {
        if (peripheral.address === this.address && !found) {
          found = true;
          this.log(`[DEBUG] (Battery) Found device: ${peripheral.address}`);
          
          try {
            noble.stopScanning();
          } catch (e) {}
          clearTimeout(scanTimeout);
          noble.removeListener('discover', discoverHandler);

          try {
            await this.connectForBattery(peripheral);
            resolve();
          } catch (error) {
            reject(error);
          }
        }
      };

      noble.on('discover', discoverHandler);
      
      try {
        noble.startScanning([], true);
      } catch (e) {
        this.log(`[DEBUG] (Battery) Error starting scan: ${e}`);
        noble.removeListener('discover', discoverHandler);
        return reject(new Error('Failed to start scanning'));
      }

      scanTimeout = setTimeout(() => {
        try {
          noble.stopScanning();
        } catch (e) {}
        noble.removeListener('discover', discoverHandler);
        
        if (!found) {
          this.log('[DEBUG] (Battery) Device not found during scan');
          reject(new Error('Device not found'));
        }
      }, 5000);
    });
  }

  async connectForBattery(peripheral) {
    return new Promise((resolve, reject) => {
      this.log('[DEBUG] (Battery) Connecting for battery check...');
      
      let connectionTimeout = setTimeout(() => {
        this.log('[DEBUG] (Battery) Connection timeout');
        try {
          peripheral.disconnect();
        } catch (e) {}
        reject(new Error('Connection timeout'));
      }, 10000);

      peripheral.connect((error) => {
        if (error) {
          clearTimeout(connectionTimeout);
          return reject(error);
        }

        peripheral.discoverAllServicesAndCharacteristics((error, services, characteristics) => {
          if (error) {
            clearTimeout(connectionTimeout);
            try {
              peripheral.disconnect();
            } catch (e) {}
            return reject(error);
          }

          const writeChar = characteristics.find(char => char.uuid === '2b11');
          const notifyChar = characteristics.find(char => char.uuid === '2b10');

          if (!writeChar) {
            clearTimeout(connectionTimeout);
            try {
              peripheral.disconnect();
            } catch (e) {}
            return reject(new Error('No write characteristic found'));
          }

          this.log('[DEBUG] (Battery) Requesting device status...');
          
          // Set up notifications for battery response
          if (notifyChar) {
            notifyChar.subscribe((err) => {
              if (!err) {
                notifyChar.on('data', (data) => {
                  this.log(`[DEBUG] (Battery) Status response: ${data.toString('hex')}`);
                  this.parseBatteryFromResponse(data);
                });
              }
            });
          }

          // Generate session key and send status query
          this.generateSessionKey();
          const statusPacket = this.createStatusQueryPacket();
          
          if (statusPacket) {
            writeChar.write(statusPacket, true, (writeError) => {
              clearTimeout(connectionTimeout);
              
              setTimeout(() => {
                try {
                  peripheral.disconnect();
                } catch (e) {}
              }, 2000);
              
              if (writeError) {
                this.log(`[DEBUG] (Battery) Write error: ${writeError}`);
                reject(writeError);
              } else {
                this.log('[DEBUG] (Battery) Status query sent');
                resolve();
              }
            });
          } else {
            clearTimeout(connectionTimeout);
            try {
              peripheral.disconnect();
            } catch (e) {}
            reject(new Error('Failed to create status packet'));
          }
        });
      });

      peripheral.once('disconnect', () => {
        this.log('[DEBUG] (Battery) Peripheral disconnected');
        clearTimeout(connectionTimeout);
      });
    });
  }

  parseBatteryFromResponse(data) {
    try {
      // Parse Tuya BLE response for battery level
      if (data.length >= 10) {
        // Look for DP response format
        for (let i = 0; i < data.length - 6; i++) {
          if (data[i] === 0x02) { // DP ID 2 (battery)
            const dpType = data[i + 1];
            if (dpType === 0x02) { // INTEGER type
              const dpLen = data.readUInt16BE(i + 2);
              if (dpLen === 4 && i + 8 <= data.length) {
                const batteryValue = data.readUInt32BE(i + 4);
                if (batteryValue <= 100) {
                  this.batteryLevel = batteryValue;
                  this.log(`[DEBUG] (Battery) Extracted battery level: ${batteryValue}%`);
                  this.batteryService.updateCharacteristic(Characteristic.BatteryLevel, batteryValue);
                  break;
                }
              }
            }
          }
        }
      }
    } catch (error) {
      this.log(`[DEBUG] (Battery) Parse error: ${error}`);
    }
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
        
        this.log(`[DEBUG] Starting scan attempt ${retryCount + 1}...`);
        
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
            this.log(`Scan attempt ${retryCount} failed, retrying in ${this.scanRetryCooldown}ms...`);
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
        this.log('[DEBUG] Peripheral disconnected during operation');
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
        
        peripheral.discoverAllServicesAndCharacteristics((error, services, characteristics) => {
          if (error) {
            this.log(`[DEBUG] Service discovery error: ${error}`);
            cleanup();
            this.forceDisconnect();
            return reject(error);
          }

          this.log(`[DEBUG] Discovered ${services?.length || 0} services, ${characteristics?.length || 0} characteristics`);

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
    this.log('[DEBUG] Starting Tuya BLE authentication and command sequence...');
    
    this.generateSessionKey();
    
    let authStep = 0;
    let operationTimeout = null;
    let authCompleted = false;

    operationTimeout = setTimeout(() => {
      this.log('[DEBUG] Overall operation timeout');
      cleanup();
      this.forceDisconnect();
      reject(new Error('Operation timeout'));
    }, 12000);

    // Set up notifications
    if (notifyChar) {
      notifyChar.subscribe((error) => {
        if (error) {
          this.log(`[DEBUG] Notification subscription error: ${error}`);
        } else {
          this.log('[DEBUG] Subscribed to notifications');
          
          notifyChar.on('data', (data) => {
            this.log(`[DEBUG] Notification: ${data.toString('hex')}`);
            this.handleAuthResponse(data);
            
            // Continue auth sequence
            if (!authCompleted) {
              setTimeout(nextAuthStep, 500);
            }
          });
        }
      });
    }

    const nextAuthStep = () => {
      if (authCompleted || peripheral.state !== 'connected') {
        return;
      }

      authStep++;
      let packet = null;
      
      switch (authStep) {
        case 1:
          this.log('[DEBUG] Auth Step 1: Sending login packet...');
          packet = this.createLoginPacket();
          break;
          
        case 2:
          this.log('[DEBUG] Auth Step 2: Sending heartbeat...');
          packet = this.createHeartbeatPacket();
          break;
          
        case 3:
          this.log('[DEBUG] Auth Step 3: Sending status query...');
          packet = this.createStatusQueryPacket();
          break;
          
        case 4:
          this.log('[DEBUG] Auth Step 4: Sending press command...');
          packet = this.createDPCommandPacket(0x01, 0x01, true); // DP1, BOOL, true
          setTimeout(() => {
            if (!authCompleted) {
              nextAuthStep(); // Move to release after press time
            }
          }, this.pressTime);
          break;
          
        case 5:
          this.log('[DEBUG] Auth Step 5: Sending release command...');
          packet = this.createDPCommandPacket(0x01, 0x01, false); // DP1, BOOL, false
          authCompleted = true;
          setTimeout(() => {
            this.log('[DEBUG] Command sequence completed');
            clearTimeout(operationTimeout);
            cleanup();
            this.forceDisconnect();
            resolve();
          }, 500);
          break;
          
        default:
          authCompleted = true;
          clearTimeout(operationTimeout);
          cleanup();
          this.forceDisconnect();
          resolve();
          return;
      }

      if (packet) {
        writeChar.write(packet, true, (error) => {
          if (error) {
            this.log(`[DEBUG] Error in auth step ${authStep}: ${error}`);
            if (!authCompleted) {
              setTimeout(nextAuthStep, 1000); // Continue anyway
            }
          } else {
            this.log(`[DEBUG] Auth step ${authStep} sent successfully`);
            if (!notifyChar && !authCompleted) {
              setTimeout(nextAuthStep, 800); // No notifications, proceed automatically
            }
          }
        });
      }
    };

    // Start auth sequence
    setTimeout(nextAuthStep, 200);
  }

  handleAuthResponse(data) {
    try {
      if (data.length >= 7) {
        const cmdType = data[6]; // Command type
        this.log(`[DEBUG] Auth response command type: 0x${cmdType.toString(16)}`);
        
        if (cmdType === 0x01) {
          this.log('[DEBUG] Login response - authentication progressing');
          this.isAuthenticated = true;
        } else if (cmdType === 0x08) {
          this.log('[DEBUG] Status response received');
          this.parseBatteryFromResponse(data);
        }
      }
    } catch (error) {
      this.log(`[DEBUG] Error parsing auth response: ${error}`);
    }
  }
}