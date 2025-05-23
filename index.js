const noble = require('@abandonware/noble');
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
    
    // Required Tuya BLE credentials
    this.deviceId = config.deviceId;
    this.localKey = config.localKey;
    
    if (!this.deviceId || !this.localKey) {
      this.log('ERROR: deviceId and localKey are required for Tuya BLE devices');
      throw new Error('Missing required Tuya BLE credentials');
    }

    // Configuration
    this.pressTime = config.pressTime || 3000;
    this.scanDuration = config.scanDuration || 10000;
    this.scanRetries = config.scanRetries || 3;
    this.connectionTimeout = config.connectionTimeout || 15000;
    
    // Protocol state
    this.sequenceNumber = 1;
    this.sessionKey = null;
    this.deviceAuthenticated = false;
    
    // Device state
    this.isOn = false;
    this.batteryLevel = -1;
    this.connecting = false;
    this.currentPeripheral = null;
    
    // Detect device model
    this.deviceModel = this.detectDeviceModel();
    this.log(`Detected device model: ${this.deviceModel}`);

    // Setup HomeKit services
    this.switchService = new Service.Switch(this.name);
    this.switchService
      .getCharacteristic(Characteristic.On)
      .on('get', this.getOn.bind(this))
      .on('set', this.setOn.bind(this));

    this.batteryService = new Service.BatteryService(this.name);
    this.batteryService
      .getCharacteristic(Characteristic.BatteryLevel)
      .on('get', this.getBatteryLevel.bind(this));

    // Setup Noble BLE events
    noble.on('stateChange', (state) => {
      if (state === 'poweredOn') {
        this.log('Bluetooth adapter ready');
      } else {
        this.log('Bluetooth adapter not available');
        this.forceDisconnect();
      }
    });
    
    // Initial battery check
    this.updateBatteryLevel();
  }

  detectDeviceModel() {
    const deviceIdPatterns = {
      'plus': ['blliqpsj', 'ndvkgsrm', 'yiihr7zh', 'neq16kgd'],
      'original': ['ltak7e1p', 'y6kttvd6', 'yrnk7mnn', 'nvr2rocq', 'bnt7wajf', 'rvdceqjh', '5xhbk964'],
      'cubetouch1s': ['3yqdo5yt'],
      'cubetouch2': ['xhf790if']
    };

    for (const [model, patterns] of Object.entries(deviceIdPatterns)) {
      if (patterns.some(pattern => this.deviceId.startsWith(pattern))) {
        return model;
      }
    }
    return 'unknown';
  }

  getServices() {
    return [this.switchService, this.batteryService];
  }

  getOn(callback) {
    callback(null, this.isOn);
  }

  setOn(value, callback) {
    if (value) {
      this.pressButton()
        .then(() => {
          this.isOn = true;
          callback(null);
          
          // Reset switch after press time
          setTimeout(() => {
            this.isOn = false;
            this.switchService.updateCharacteristic(Characteristic.On, false);
          }, this.pressTime);
        })
        .catch(error => {
          this.log(`Error pressing button: ${error.message}`);
          callback(error);
        });
    } else {
      callback(null);
    }
  }

  getBatteryLevel(callback) {
    const level = this.batteryLevel >= 0 && this.batteryLevel <= 100 ? this.batteryLevel : 0;
    callback(null, level);
  }

  // Main entry point for button press
  async pressButton() {
    return new Promise((resolve, reject) => {
      if (this.connecting) {
        return reject(new Error('Already connecting'));
      }
      
      this.log('Activating Fingerbot...');
      this.scanAndConnect()
        .then(peripheral => this.executeButtonPress(peripheral))
        .then(() => {
          this.log('Button press completed successfully');
          resolve();
        })
        .catch(error => {
          this.log(`Button press failed: ${error.message}`);
          reject(error);
        })
        .finally(() => {
          this.forceDisconnect();
        });
    });
  }

  // Battery level update
  async updateBatteryLevel() {
    try {
      this.log('Checking battery level...');
      const peripheral = await this.scanAndConnect();
      const batteryLevel = await this.readBatteryLevel(peripheral);
      
      if (batteryLevel >= 0) {
        this.batteryLevel = batteryLevel;
        this.batteryService.updateCharacteristic(Characteristic.BatteryLevel, batteryLevel);
        this.log(`Battery level: ${batteryLevel}%`);
      }
    } catch (error) {
      this.log(`Battery check failed: ${error.message}`);
    } finally {
      this.forceDisconnect();
    }
  }

  // Scan for and connect to device
  async scanAndConnect() {
    return new Promise((resolve, reject) => {
      this.forceDisconnect();
      this.connecting = true;
      
      let retryCount = 0;
      let scanTimeout = null;
      let peripheralFound = false;

      const startScan = () => {
        peripheralFound = false;
        noble.removeAllListeners('discover');
        
        const discoverHandler = async (peripheral) => {
          if (peripheral.address === this.address && !peripheralFound) {
            peripheralFound = true;
            this.log(`Found device: ${peripheral.address}`);
            
            clearTimeout(scanTimeout);
            noble.stopScanning();
            noble.removeListener('discover', discoverHandler);

            try {
              await this.connectToPeripheral(peripheral);
              resolve(peripheral);
            } catch (error) {
              reject(error);
            }
          }
        };

        noble.on('discover', discoverHandler);
        
        this.log(`Scanning for device (attempt ${retryCount + 1}/${this.scanRetries + 1})...`);
        noble.startScanning([], true);

        scanTimeout = setTimeout(() => {
          noble.stopScanning();
          noble.removeListener('discover', discoverHandler);

          if (!peripheralFound && retryCount < this.scanRetries) {
            retryCount++;
            setTimeout(startScan, 2000);
          } else if (!peripheralFound) {
            this.connecting = false;
            reject(new Error('Device not found after multiple scan attempts'));
          }
        }, this.scanDuration);
      };

      startScan();
    });
  }

  // Connect to peripheral and discover services
  async connectToPeripheral(peripheral) {
    return new Promise((resolve, reject) => {
      this.currentPeripheral = peripheral;
      
      const connectionTimeout = setTimeout(() => {
        this.log('Connection timeout');
        reject(new Error('Connection timeout'));
      }, this.connectionTimeout);

      const disconnectHandler = () => {
        clearTimeout(connectionTimeout);
        this.currentPeripheral = null;
        reject(new Error('Device disconnected during connection'));
      };

      peripheral.once('disconnect', disconnectHandler);

      peripheral.connect((error) => {
        if (error) {
          clearTimeout(connectionTimeout);
          peripheral.removeListener('disconnect', disconnectHandler);
          this.currentPeripheral = null;
          return reject(error);
        }

        this.log('Connected, discovering services...');
        
        // Wait for services to be ready
        setTimeout(() => {
          peripheral.discoverAllServicesAndCharacteristics((error, services, characteristics) => {
            clearTimeout(connectionTimeout);
            peripheral.removeListener('disconnect', disconnectHandler);
            
            if (error) {
              return reject(error);
            }

            // Find required characteristics
            const writeChar = characteristics.find(char => char.uuid === '2b11');
            const notifyChar = characteristics.find(char => char.uuid === '2b10');

            if (!writeChar) {
              return reject(new Error('Write characteristic not found'));
            }

            this.log('Service discovery completed');
            resolve({ peripheral, writeChar, notifyChar });
          });
        }, 2000);
      });
    });
  }

  // Execute button press sequence
  async executeButtonPress(connectionInfo) {
    const { peripheral, writeChar, notifyChar } = connectionInfo;
    
    // Setup notifications if available
    if (notifyChar) {
      await this.setupNotifications(notifyChar);
    }
    
    // Authenticate with device
    await this.authenticateDevice(writeChar);
    
    // Execute press based on device model
    if (this.deviceModel === 'plus' && this.deviceId.startsWith('blliqpsj')) {
      await this.executeFingerbotPlusPress(writeChar);
    } else {
      await this.executeGenericPress(writeChar);
    }
  }

  // Read battery level from device
  async readBatteryLevel(connectionInfo) {
    const { peripheral, writeChar, notifyChar } = connectionInfo;
    
    return new Promise(async (resolve, reject) => {
      let responseTimeout = null;
      let batteryLevel = -1;

      if (notifyChar) {
        // Setup notification handler for battery response
        const notificationHandler = (data) => {
          try {
            const parsedData = this.parseTuyaResponse(data);
            if (parsedData && parsedData.command === 0x08) {
              // Status response - look for battery DP (typically DP12)
              const battery = this.extractBatteryFromStatus(parsedData.payload);
              if (battery >= 0) {
                batteryLevel = battery;
                clearTimeout(responseTimeout);
                notifyChar.removeListener('data', notificationHandler);
                resolve(batteryLevel);
              }
            }
          } catch (error) {
            this.log(`Error parsing battery response: ${error.message}`);
          }
        };

        notifyChar.on('data', notificationHandler);
        await this.setupNotifications(notifyChar);
      }

      try {
        // Authenticate first
        await this.authenticateDevice(writeChar);
        
        // Request device status (includes battery)
        const statusPacket = this.createTuyaPacket(0x08, Buffer.alloc(0), true);
        await this.writeCharacteristic(writeChar, statusPacket);
        
        responseTimeout = setTimeout(() => {
          if (notifyChar) {
            notifyChar.removeAllListeners('data');
          }
          resolve(-1); // Return -1 if no response
        }, 5000);
        
      } catch (error) {
        if (notifyChar) {
          notifyChar.removeAllListeners('data');
        }
        clearTimeout(responseTimeout);
        reject(error);
      }
    });
  }

  // Setup BLE notifications
  async setupNotifications(notifyChar) {
    return new Promise((resolve, reject) => {
      notifyChar.subscribe((error) => {
        if (error) {
          this.log(`Notification setup failed: ${error.message}`);
          reject(error);
        } else {
          this.log('Notifications enabled');
          resolve();
        }
      });
    });
  }

  // Authenticate with Tuya device
  async authenticateDevice(writeChar) {
    return new Promise(async (resolve, reject) => {
      try {
        // Generate session key
        this.generateSessionKey();
        
        // Send login packet
        const loginPacket = this.createTuyaPacket(0x01, Buffer.from(this.deviceId, 'utf8'), false);
        await this.writeCharacteristic(writeChar, loginPacket);
        
        // Wait for authentication
        setTimeout(() => {
          this.deviceAuthenticated = true;
          this.log('Device authenticated');
          resolve();
        }, 1000);
        
      } catch (error) {
        reject(error);
      }
    });
  }

  // Execute Fingerbot Plus specific press sequence
  async executeFingerbotPlusPress(writeChar) {
    this.log('Executing Fingerbot Plus press sequence...');
    
    // Set to Click mode
    const clickModePacket = this.createTuyaPacket(0x06, 
      Buffer.from([0x02, 0x04, 0x00, 0x04, 0x43, 0x6C, 0x69, 0x63]), true);
    await this.writeCharacteristic(writeChar, clickModePacket);
    await this.delay(500);
    
    // Trigger press
    const pressPacket = this.createTuyaPacket(0x06, 
      Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01]), true);
    await this.writeCharacteristic(writeChar, pressPacket);
    await this.delay(this.pressTime);
    
    // Release
    const releasePacket = this.createTuyaPacket(0x06, 
      Buffer.from([0x01, 0x01, 0x00, 0x01, 0x00]), true);
    await this.writeCharacteristic(writeChar, releasePacket);
  }

  // Execute generic press sequence
  async executeGenericPress(writeChar) {
    this.log('Executing generic press sequence...');
    
    const dpId = this.deviceModel === 'plus' ? 0x01 : 0x02;
    
    // Press
    const pressPacket = this.createTuyaPacket(0x06, 
      Buffer.from([dpId, 0x01, 0x00, 0x01, 0x01]), true);
    await this.writeCharacteristic(writeChar, pressPacket);
    await this.delay(this.pressTime);
    
    // Release  
    const releasePacket = this.createTuyaPacket(0x06, 
      Buffer.from([dpId, 0x01, 0x00, 0x01, 0x00]), true);
    await this.writeCharacteristic(writeChar, releasePacket);
  }

  // Generate session key for encryption
  generateSessionKey() {
    try {
      let keyBuffer;
      if (this.localKey.length === 32 && /^[0-9a-fA-F]+$/.test(this.localKey)) {
        keyBuffer = Buffer.from(this.localKey, 'hex');
      } else {
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
      this.log(`Session key generated: ${this.sessionKey.toString('hex')}`);
    } catch (error) {
      this.log(`Session key generation failed: ${error.message}`);
      throw error;
    }
  }

  // Create Tuya BLE packet
  createTuyaPacket(commandType, data = Buffer.alloc(0), encrypt = false) {
    try {
      this.sequenceNumber = (this.sequenceNumber + 1) & 0xFFFF;
      
      // Tuya BLE format: [0x55, 0xaa] [seq(2, BE)] [cmd(1)] [len(2, BE)] [data] [checksum(1)]
      const header = Buffer.from([0x55, 0xaa]);
      const seqBuffer = Buffer.alloc(2);
      seqBuffer.writeUInt16BE(this.sequenceNumber, 0);
      const cmdBuffer = Buffer.from([commandType]);
      
      let finalData = data;
      
      // Encrypt if required and session key available
      if (encrypt && this.sessionKey) {
        finalData = this.encryptData(data);
      }
      
      const lengthBuffer = Buffer.alloc(2);
      lengthBuffer.writeUInt16BE(finalData.length, 0);
      
      const payload = Buffer.concat([seqBuffer, cmdBuffer, lengthBuffer, finalData]);
      const preChecksum = Buffer.concat([header, payload]);
      
      // Calculate checksum
      let checksum = 0;
      for (let i = 0; i < preChecksum.length; i++) {
        checksum = (checksum + preChecksum[i]) & 0xFF;
      }
      
      const packet = Buffer.concat([header, payload, Buffer.from([checksum])]);
      this.log(`TX: ${packet.toString('hex')}`);
      return packet;
      
    } catch (error) {
      this.log(`Packet creation failed: ${error.message}`);
      throw error;
    }
  }

  // Encrypt data using AES-128-ECB
  encryptData(data) {
    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const deviceIdBuffer = Buffer.from(this.deviceId, 'utf8').slice(0, 16);
      const timestampBuffer = Buffer.alloc(4);
      timestampBuffer.writeUInt32BE(timestamp, 0);
      
      // Pad device ID to 16 bytes
      const paddedDeviceId = Buffer.alloc(16, 0);
      deviceIdBuffer.copy(paddedDeviceId);
      
      const authData = Buffer.concat([paddedDeviceId, timestampBuffer, data]);
      
      // PKCS7 padding
      const paddingNeeded = 16 - (authData.length % 16);
      const paddedData = Buffer.concat([authData, Buffer.alloc(paddingNeeded, paddingNeeded)]);
      
      const cipher = crypto.createCipheriv('aes-128-ecb', this.sessionKey, null);
      cipher.setAutoPadding(false);
      return Buffer.concat([cipher.update(paddedData), cipher.final()]);
      
    } catch (error) {
      this.log(`Encryption failed: ${error.message}`);
      throw error;
    }
  }

  // Parse Tuya response packet
  parseTuyaResponse(data) {
    if (data.length < 7) {
      return null;
    }
    
    try {
      const header = data.slice(0, 2);
      const sequence = data.readUInt16BE(2);
      const command = data[4];
      const length = data.readUInt16BE(5);
      const payload = data.slice(7, 7 + length);
      
      this.log(`RX: ${data.toString('hex')}`);
      
      return {
        header,
        sequence,
        command,
        length,
        payload
      };
    } catch (error) {
      this.log(`Response parsing failed: ${error.message}`);
      return null;
    }
  }

  // Extract battery level from status payload
  extractBatteryFromStatus(payload) {
    // Look for DP12 (battery) or similar battery indicators
    let offset = 0;
    while (offset < payload.length - 4) {
      try {
        const dpId = payload[offset];
        const dpType = payload[offset + 1];
        const dpLength = payload.readUInt16BE(offset + 2);
        const dpData = payload.slice(offset + 4, offset + 4 + dpLength);
        
        // Battery is typically DP12 with integer type
        if (dpId === 12 && dpType === 0x02 && dpLength === 4) {
          const batteryLevel = dpData.readUInt32BE(0);
          if (batteryLevel >= 0 && batteryLevel <= 100) {
            return batteryLevel;
          }
        }
        
        offset += 4 + dpLength;
      } catch (error) {
        break;
      }
    }
    return -1;
  }

  // Write to characteristic with promise wrapper
  async writeCharacteristic(characteristic, data) {
    return new Promise((resolve, reject) => {
      characteristic.write(data, true, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  // Utility delay function
  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Force disconnect and cleanup
  forceDisconnect() {
    if (this.currentPeripheral) {
      try {
        this.currentPeripheral.disconnect();
      } catch (error) {
        // Ignore disconnect errors
      }
      this.currentPeripheral = null;
    }
    
    this.connecting = false;
    this.deviceAuthenticated = false;
    
    try {
      noble.stopScanning();
      noble.removeAllListeners('discover');
    } catch (error) {
      // Ignore scanning cleanup errors
    }
  }
}