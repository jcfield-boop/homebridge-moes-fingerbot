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
    this.address = config.address ? config.address.toLowerCase() : null;
    
    // Required Tuya BLE credentials
    this.deviceId = config.deviceId;
    this.localKey = config.localKey;
    
    // Debug configuration info
    this.log(`Configuration: deviceId=${this.deviceId}, address=${this.address}, localKey=${this.localKey ? 'SET' : 'MISSING'}`);
    
    if (!this.deviceId || !this.localKey) {
      this.log('ERROR: deviceId and localKey are required for Tuya BLE devices');
      throw new Error('Missing required Tuya BLE credentials');
    }

    if (!this.address) {
      this.log('ERROR: BLE address is required');
      throw new Error('Missing BLE address');
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
    this.bluetoothReady = false;
    
    // Detect device model
    this.deviceModel = this.detectDeviceModel();
    this.log(`Detected device model: ${this.deviceModel} (deviceId: ${this.deviceId})`);

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
    this.setupBluetoothEvents();
    
    // Check initial Bluetooth state
    if (noble.state === 'poweredOn') {
      this.bluetoothReady = true;
      this.log('Bluetooth adapter already ready');
      // Initial battery check after a short delay
      setTimeout(() => this.updateBatteryLevel(), 2000);
    }
  }

  setupBluetoothEvents() {
    noble.on('stateChange', (state) => {
      this.log(`Bluetooth state changed to: ${state}`);
      if (state === 'poweredOn') {
        this.bluetoothReady = true;
        this.log('Bluetooth adapter ready');
        // Initial battery check when Bluetooth becomes ready
        setTimeout(() => this.updateBatteryLevel(), 2000);
      } else {
        this.bluetoothReady = false;
        this.log('Bluetooth adapter not available');
        this.forceDisconnect();
      }
    });

    noble.on('discover', (peripheral) => {
      // Log all discovered devices for debugging
      this.log(`Discovered device: ${peripheral.address} (${peripheral.advertisement.localName || 'unnamed'})`);
    });
  }

  detectDeviceModel() {
    const deviceIdPatterns = {
      'plus': ['blliqpsj', 'ndvkgsrm', 'yiihr7zh', 'neq16kgd', 'bjcvqwh0', 'eb4507wa'],
      'original': ['ltak7e1p', 'y6kttvd6', 'yrnk7mnn', 'nvr2rocq', 'bnt7wajf', 'rvdceqjh', '5xhbk964'],
      'cubetouch1s': ['3yqdo5yt'],
      'cubetouch2': ['xhf790if']
    };

    if (!this.deviceId) {
      this.log('No deviceId provided for model detection');
      return 'unknown';
    }

    for (const [model, patterns] of Object.entries(deviceIdPatterns)) {
      if (patterns.some(pattern => this.deviceId.startsWith(pattern))) {
        return model;
      }
    }
    
    this.log(`Unknown device pattern for deviceId: ${this.deviceId} - treating as Plus model`);
    return 'plus'; // Default to plus model for unknown devices
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

  // Check if we can perform BLE operations
  canPerformBLEOperation() {
    if (!this.bluetoothReady) {
      throw new Error('Bluetooth not ready');
    }
    if (this.connecting) {
      throw new Error('Already connecting');
    }
    return true;
  }

  // Main entry point for button press
  async pressButton() {
    try {
      this.canPerformBLEOperation();
      
      this.log('Activating Fingerbot...');
      const peripheral = await this.scanAndConnect();
      await this.executeButtonPress(peripheral);
      this.log('Button press completed successfully');
    } catch (error) {
      this.log(`Button press failed: ${error.message}`);
      throw error;
    } finally {
      this.forceDisconnect();
    }
  }

  // Battery level update
  async updateBatteryLevel() {
    try {
      this.canPerformBLEOperation();
      
      this.log('Checking battery level...');
      const peripheral = await this.scanAndConnect();
      const batteryLevel = await this.readBatteryLevel(peripheral);
      
      if (batteryLevel >= 0) {
        this.batteryLevel = batteryLevel;
        this.batteryService.updateCharacteristic(Characteristic.BatteryLevel, batteryLevel);
        this.log(`Battery level: ${batteryLevel}%`);
      } else {
        this.log('Could not read battery level');
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
          this.log(`Checking device: ${peripheral.address} vs ${this.address}`);
          
          if (peripheral.address === this.address && !peripheralFound) {
            peripheralFound = true;
            this.log(`Found target device: ${peripheral.address} (RSSI: ${peripheral.rssi})`);
            
            clearTimeout(scanTimeout);
            noble.stopScanning();
            noble.removeListener('discover', discoverHandler);

            // Try to connect with retries
            let connectionAttempts = 0;
            const maxConnectionAttempts = 3;
            
            const attemptConnection = async () => {
              try {
                connectionAttempts++;
                this.log(`Connection attempt ${connectionAttempts}/${maxConnectionAttempts}`);
                
                const connectionInfo = await this.connectToPeripheral(peripheral);
                this.connecting = false;
                resolve(connectionInfo);
              } catch (error) {
                this.log(`Connection attempt ${connectionAttempts} failed: ${error.message}`);
                
                if (connectionAttempts < maxConnectionAttempts) {
                  this.log(`Retrying connection in 2 seconds...`);
                  setTimeout(attemptConnection, 2000);
                } else {
                  this.connecting = false;
                  reject(new Error(`Failed to connect after ${maxConnectionAttempts} attempts: ${error.message}`));
                }
              }
            };
            
            attemptConnection();
          }
        };

        noble.on('discover', discoverHandler);
        
        this.log(`Scanning for device (attempt ${retryCount + 1}/${this.scanRetries + 1})...`);
        
        // Start scanning - allow duplicates to ensure we see advertising devices
        noble.startScanning([], true, (error) => {
          if (error) {
            this.log(`Scan start error: ${error.message}`);
            this.connecting = false;
            reject(error);
            return;
          }
          this.log('Bluetooth scanning started');
        });

        scanTimeout = setTimeout(() => {
          this.log(`Scan timeout reached for attempt ${retryCount + 1}`);
          noble.stopScanning();
          noble.removeListener('discover', discoverHandler);

          if (!peripheralFound && retryCount < this.scanRetries) {
            retryCount++;
            this.log(`Retrying scan in 2 seconds...`);
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
        this.cleanupConnection(peripheral);
        reject(new Error('Connection timeout'));
      }, this.connectionTimeout);

      const disconnectHandler = (error) => {
        this.log('Device disconnected during connection:', error);
        clearTimeout(connectionTimeout);
        this.currentPeripheral = null;
        reject(new Error('Device disconnected during connection'));
      };

      peripheral.once('disconnect', disconnectHandler);

      this.log('Attempting to connect...');
      peripheral.connect((error) => {
        if (error) {
          this.log(`Connection error: ${error.message}`);
          clearTimeout(connectionTimeout);
          peripheral.removeListener('disconnect', disconnectHandler);
          this.currentPeripheral = null;
          return reject(error);
        }

        this.log('Connected successfully, waiting for stability...');
        
        // Wait longer for connection to stabilize
        setTimeout(() => {
          this.log('Discovering services and characteristics...');
          
          peripheral.discoverAllServicesAndCharacteristics((error, services, characteristics) => {
            clearTimeout(connectionTimeout);
            peripheral.removeListener('disconnect', disconnectHandler);
            
            if (error) {
              this.log(`Service discovery error: ${error.message}`);
              return reject(error);
            }

            this.log(`Found ${services.length} services and ${characteristics.length} characteristics`);
            
            // Log all services and characteristics for debugging
            services.forEach(service => {
              this.log(`Service: ${service.uuid}`);
            });
            
            characteristics.forEach(char => {
              this.log(`Characteristic: ${char.uuid} (properties: ${char.properties.join(', ')})`);
            });

            // Find required characteristics
            const writeChar = characteristics.find(char => char.uuid === '2b11');
            const notifyChar = characteristics.find(char => char.uuid === '2b10');

            // Also look for alternate UUIDs that might be used
            const altWriteChar = characteristics.find(char => 
              char.uuid.includes('2b11') || 
              char.properties.includes('write') || 
              char.properties.includes('writeWithoutResponse')
            );
            
            const altNotifyChar = characteristics.find(char => 
              char.uuid.includes('2b10') || 
              char.properties.includes('notify') || 
              char.properties.includes('indicate')
            );

            const finalWriteChar = writeChar || altWriteChar;
            const finalNotifyChar = notifyChar || altNotifyChar;

            if (!finalWriteChar) {
              this.log('Available characteristics:', characteristics.map(c => `${c.uuid} (${c.properties.join(',')})`).join(', '));
              return reject(new Error('No suitable write characteristic found'));
            }

            this.log(`Using write characteristic: ${finalWriteChar.uuid}`);
            if (finalNotifyChar) {
              this.log(`Using notify characteristic: ${finalNotifyChar.uuid}`);
            } else {
              this.log('No notify characteristic found - will work without notifications');
            }

            this.log('Service discovery completed successfully');
            resolve({ peripheral, writeChar: finalWriteChar, notifyChar: finalNotifyChar });
          });
        }, 3000); // Increased wait time for stability
      });
    });
  }

  // Helper method to clean up connections
  cleanupConnection(peripheral) {
    try {
      if (peripheral && peripheral.state === 'connected') {
        peripheral.disconnect();
      }
    } catch (error) {
      this.log(`Cleanup error: ${error.message}`);
    }
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
    if (this.deviceModel === 'plus') {
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
            this.log(`Received notification data: ${data.toString('hex')}`);
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
        this.log('Requesting device status...');
        const statusPacket = this.createTuyaPacket(0x08, Buffer.alloc(0), false);
        await this.writeCharacteristic(writeChar, statusPacket);
        
        responseTimeout = setTimeout(() => {
          this.log('Battery status request timeout');
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
        this.log('Sending authentication packet...');
        const loginPacket = this.createTuyaPacket(0x01, Buffer.from(this.deviceId, 'utf8'), false);
        await this.writeCharacteristic(writeChar, loginPacket);
        
        // Wait for authentication - increased time for reliability
        setTimeout(() => {
          this.deviceAuthenticated = true;
          this.log('Device authentication completed');
          resolve();
        }, 2000);
        
      } catch (error) {
        this.log(`Authentication failed: ${error.message}`);
        reject(error);
      }
    });
  }

  // Execute Fingerbot Plus specific press sequence
  async executeFingerbotPlusPress(writeChar) {
    this.log('Executing Fingerbot Plus press sequence...');
    
    // Trigger press (DP1 = true)
    const pressPacket = this.createTuyaPacket(0x06, 
      Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01]), true);
    await this.writeCharacteristic(writeChar, pressPacket);
    await this.delay(this.pressTime);
    
    // Release (DP1 = false)
    const releasePacket = this.createTuyaPacket(0x06, 
      Buffer.from([0x01, 0x01, 0x00, 0x01, 0x00]), true);
    await this.writeCharacteristic(writeChar, releasePacket);
  }

  // Execute generic press sequence
  async executeGenericPress(writeChar) {
    this.log('Executing generic press sequence...');
    
    const dpId = 0x01; // Use DP1 for button press
    
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
        // Hex key
        keyBuffer = Buffer.from(this.localKey, 'hex');
      } else {
        // UTF-8 key, pad to 16 bytes
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
      this.log(`Session key generated (${keyBuffer.length} bytes): ${this.sessionKey.toString('hex')}`);
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
      const cipher = crypto.createCipheriv('aes-128-ecb', this.sessionKey, null);
      cipher.setAutoPadding(true);
      return Buffer.concat([cipher.update(data), cipher.final()]);
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
    this.log(`Extracting battery from payload: ${payload.toString('hex')}`);
    
    // Look for DP12 (battery) or similar battery indicators
    let offset = 0;
    while (offset < payload.length - 4) {
      try {
        const dpId = payload[offset];
        const dpType = payload[offset + 1];
        const dpLength = payload.readUInt16BE(offset + 2);
        
        this.log(`Found DP${dpId} type:${dpType} length:${dpLength}`);
        
        if (offset + 4 + dpLength > payload.length) {
          break;
        }
        
        const dpData = payload.slice(offset + 4, offset + 4 + dpLength);
        
        // Battery could be DP12, or other DPs - check various possibilities
        if ((dpId === 12 || dpId === 13 || dpId === 15) && dpType === 0x02 && dpLength === 4) {
          const batteryLevel = dpData.readUInt32BE(0);
          this.log(`Found potential battery DP${dpId}: ${batteryLevel}`);
          if (batteryLevel >= 0 && batteryLevel <= 100) {
            return batteryLevel;
          }
        }
        
        offset += 4 + dpLength;
      } catch (error) {
        this.log(`Error parsing DP at offset ${offset}: ${error.message}`);
        break;
      }
    }
    return -1;
  }

  // Write to characteristic with promise wrapper
  async writeCharacteristic(characteristic, data) {
    return new Promise((resolve, reject) => {
      if (!characteristic) {
        return reject(new Error('Characteristic is null'));
      }
      
      if (!data || data.length === 0) {
        return reject(new Error('No data to write'));
      }
      
      this.log(`Writing ${data.length} bytes to characteristic ${characteristic.uuid}`);
      
      // Use writeWithoutResponse if available, otherwise write
      const useWriteWithoutResponse = characteristic.properties.includes('writeWithoutResponse');
      
      characteristic.write(data, !useWriteWithoutResponse, (error) => {
        if (error) {
          this.log(`Write error: ${error.message}`);
          reject(error);
        } else {
          this.log('Write completed successfully');
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
    this.log('Forcing disconnect and cleanup...');
    
    if (this.currentPeripheral) {
      try {
        this.log(`Disconnecting from peripheral (state: ${this.currentPeripheral.state})`);
        if (this.currentPeripheral.state === 'connected' || this.currentPeripheral.state === 'connecting') {
          this.currentPeripheral.disconnect();
        }
      } catch (error) {
        this.log(`Disconnect error: ${error.message}`);
      }
      this.currentPeripheral = null;
    }
    
    this.connecting = false;
    this.deviceAuthenticated = false;
    
    try {
      if (noble.state === 'poweredOn') {
        noble.stopScanning();
      }
      noble.removeAllListeners('discover');
    } catch (error) {
      this.log(`Cleanup error: ${error.message}`);
    }
    
    this.log('Cleanup completed');
  }
}