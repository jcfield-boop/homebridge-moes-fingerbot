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
    this.log(`Configuration: deviceId=${this.deviceId}, address=${this.address}, localKey=${this.localKey ? `${this.localKey.length} chars` : 'MISSING'}`);
    
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
    this.scanDuration = config.scanDuration || 5000; // Reduced from 10000
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
      // Only log our target device or nearby strong signals for debugging
      if (peripheral.address === this.address || peripheral.rssi > -70) {
        this.log(`Discovered device: ${peripheral.address} (${peripheral.advertisement.localName || 'unnamed'}, RSSI: ${peripheral.rssi})`);
      }
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
          // Only log the target device discovery
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
          this.log(`BLE scanning active (${this.scanDuration/1000}s timeout)`);
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
    await this.authenticateDevice(writeChar, notifyChar);
    
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
            this.log(`Battery response received: ${data.toString('hex')}`);
            const parsedData = this.parseTuyaResponse(data);
            if (parsedData && parsedData.command === 0x08) {
              // Status response - look for battery DP (typically DP12)
              const battery = this.extractBatteryFromStatus(parsedData.payload);
              if (battery >= 0) {
                batteryLevel = battery;
                clearTimeout(responseTimeout);
                notifyChar.removeListener('data', notificationHandler);
                this.log(`Battery level found: ${battery}%`);
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
        await this.authenticateDevice(writeChar, notifyChar);
        
        // Request device status (includes battery)
        this.log('Requesting device status for battery level...');
        const statusPacket = this.createTuyaPacket(0x08, Buffer.alloc(0), false);
        await this.writeCharacteristic(writeChar, statusPacket);
        
        responseTimeout = setTimeout(() => {
          this.log('Battery status request timeout - no response received');
          if (notifyChar) {
            notifyChar.removeAllListeners('data');
          }
          resolve(-1); // Return -1 if no response
        }, 8000); // Increased timeout for battery reading
        
      } catch (error) {
        if (notifyChar) {
          notifyChar.removeAllListeners('data');
        }
        clearTimeout(responseTimeout);
        this.log(`Battery reading error: ${error.message}`);
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
  async authenticateDevice(writeChar, notifyChar) {
    return new Promise(async (resolve, reject) => {
      try {
        // Generate session key
        this.generateSessionKey();
        
        let authTimeout = null;
        let authenticated = false;
        
        // Setup response handler if notifications available
        if (notifyChar) {
          const authHandler = (data) => {
            try {
              this.log(`Auth response received: ${data.toString('hex')}`);
              const parsedData = this.parseTuyaResponse(data);
              
              if (parsedData) {
                this.log(`Auth response: cmd=${parsedData.command}, len=${parsedData.length}`);
                
                if (parsedData.command === 0x01 || parsedData.command === 0x02) {
                  // Authentication response received (0x01) or session start (0x02)
                  clearTimeout(authTimeout);
                  notifyChar.removeListener('data', authHandler);
                  authenticated = true;
                  this.deviceAuthenticated = true;
                  this.log('Device authentication confirmed by response');
                  resolve();
                }
              }
            } catch (error) {
              this.log(`Error parsing auth response: ${error.message}`);
            }
          };
          
          notifyChar.on('data', authHandler);
        }
        
        // Create proper authentication payload with device UUID
        // The device ID should be 16 bytes for Tuya BLE
        let deviceUuid = Buffer.alloc(16);
        const deviceIdBuffer = Buffer.from(this.deviceId, 'utf8');
        
        if (deviceIdBuffer.length <= 16) {
          deviceIdBuffer.copy(deviceUuid);
          // Null-terminate if shorter than 16 bytes
          if (deviceIdBuffer.length < 16) {
            deviceUuid.fill(0, deviceIdBuffer.length);
          }
        } else {
          // If device ID is longer, take first 16 bytes
          deviceIdBuffer.copy(deviceUuid, 0, 0, 16);
        }
        
        this.log(`Device UUID for auth (${deviceUuid.length} bytes): ${deviceUuid.toString('hex')}`);
        this.log(`Original device ID: "${this.deviceId}" (${this.deviceId.length} chars)`);
        
        // Send login packet with proper UUID
        this.log('Sending authentication packet...');
        const loginPacket = this.createTuyaPacket(0x01, deviceUuid, false);
        await this.writeCharacteristic(writeChar, loginPacket);
        
        // Wait a bit before sending session packet
        await this.delay(500);
        
        // Send a session initialization packet (required for some devices)
        this.log('Sending session initialization packet...');
        const sessionPacket = this.createTuyaPacket(0x02, Buffer.alloc(0), false);
        await this.writeCharacteristic(writeChar, sessionPacket);
        
        // Set timeout for authentication
        const authTimeoutMs = notifyChar ? 5000 : 3000;
        
        authTimeout = setTimeout(() => {
          if (notifyChar) {
            notifyChar.removeAllListeners('data');
          }
          
          if (!authenticated) {
            // For some devices, no response might be normal
            this.deviceAuthenticated = true;
            this.log('Device authentication completed (no response - assuming success)');
            resolve();
          }
        }, authTimeoutMs);
        
      } catch (error) {
        this.log(`Authentication failed: ${error.message}`);
        reject(error);
      }
    });
  }

  // Execute Fingerbot Plus specific press sequence
  async executeFingerbotPlusPress(writeChar) {
    this.log('Executing Fingerbot Plus press sequence...');
    
    try {
      // For Fingerbot Plus, use DP1 (button press)
      // Format: DP ID (1 byte) + Type (1 byte) + Length (2 bytes BE) + Data
      
      // Press command: DP1 = true (boolean type 0x01)
      const pressData = Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01]);
      const pressPacket = this.createTuyaPacket(0x06, pressData, true);
      this.log(`Sending press command: ${pressData.toString('hex')}`);
      await this.writeCharacteristic(writeChar, pressPacket);
      
      // Hold for specified duration
      await this.delay(this.pressTime);
      
      // Release command: DP1 = false
      const releaseData = Buffer.from([0x01, 0x01, 0x00, 0x01, 0x00]);
      const releasePacket = this.createTuyaPacket(0x06, releaseData, true);
      this.log(`Sending release command: ${releaseData.toString('hex')}`);
      await this.writeCharacteristic(writeChar, releasePacket);
      
    } catch (error) {
      this.log(`Fingerbot Plus press failed: ${error.message}`);
      throw error;
    }
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
        // Hex key - this is the correct format from Tuya IoT platform
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

  // Decrypt data using AES-128-ECB
  decryptData(encryptedData) {
    try {
      if (!this.sessionKey) {
        throw new Error('Session key not available for decryption');
      }
      
      const decipher = crypto.createDecipheriv('aes-128-ecb', this.sessionKey, null);
      decipher.setAutoPadding(false); // We handle padding manually
      
      const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
      
      // Remove PKCS7 padding
      const paddingLength = decrypted[decrypted.length - 1];
      if (paddingLength > 0 && paddingLength <= 16) {
        return decrypted.slice(0, decrypted.length - paddingLength);
      }
      
      return decrypted;
    } catch (error) {
      this.log(`Decryption failed: ${error.message}`);
      return encryptedData; // Return original data if decryption fails
    }
  }

  // Encrypt data using AES-128-ECB with proper Tuya BLE format
  encryptData(data) {
    try {
      if (!this.sessionKey) {
        throw new Error('Session key not available for encryption');
      }
      
      // For Tuya BLE, we need to add padding to make data 16-byte aligned
      let paddedData = data;
      const paddingNeeded = 16 - (data.length % 16);
      
      if (paddingNeeded !== 16) {
        // Add PKCS7 padding
        const padding = Buffer.alloc(paddingNeeded, paddingNeeded);
        paddedData = Buffer.concat([data, padding]);
      }
      
      this.log(`Encrypting ${data.length} bytes (padded to ${paddedData.length})`);
      
      const cipher = crypto.createCipheriv('aes-128-ecb', this.sessionKey, null);
      cipher.setAutoPadding(false); // We handle padding manually
      
      const encrypted = Buffer.concat([cipher.update(paddedData), cipher.final()]);
      this.log(`Encrypted result: ${encrypted.length} bytes`);
      
      return encrypted;
    } catch (error) {
      this.log(`Encryption failed: ${error.message}`);
      throw error;
    }
  }

  // Parse Tuya response packet
  parseTuyaResponse(data) {
    if (data.length < 7) {
      this.log(`Response too short: ${data.length} bytes`);
      return null;
    }
    
    try {
      const header = data.slice(0, 2);
      
      // Check for valid Tuya header
      if (header[0] !== 0x55 || header[1] !== 0xaa) {
        this.log(`Invalid header: ${header.toString('hex')}`);
        return null;
      }
      
      const sequence = data.readUInt16BE(2);
      const command = data[4];
      const length = data.readUInt16BE(5);
      
      if (data.length < 7 + length + 1) {
        this.log(`Incomplete packet: expected ${7 + length + 1}, got ${data.length}`);
        return null;
      }
      
      let payload = data.slice(7, 7 + length);
      const checksum = data[7 + length];
      
      this.log(`RX: ${data.toString('hex')}`);
      this.log(`Parsed: seq=${sequence}, cmd=0x${command.toString(16)}, len=${length}, payload=${payload.toString('hex')}`);
      
      // Try to decrypt payload if it looks encrypted and we have a session key
      if (this.sessionKey && payload.length > 0 && payload.length % 16 === 0 && command !== 0x01 && command !== 0x02) {
        try {
          const decryptedPayload = this.decryptData(payload);
          this.log(`Decrypted payload: ${decryptedPayload.toString('hex')}`);
          payload = decryptedPayload;
        } catch (error) {
          this.log(`Decryption failed, using raw payload: ${error.message}`);
        }
      }
      
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
    this.log(`Extracting battery from ${payload.length} byte payload: ${payload.toString('hex')}`);
    
    // Try different approaches to find battery data
    
    // Approach 1: Look for standard DP format (DP ID + Type + Length + Data)
    let offset = 0;
    while (offset < payload.length - 4) {
      try {
        const dpId = payload[offset];
        const dpType = payload[offset + 1];
        const dpLength = payload.readUInt16BE(offset + 2);
        
        this.log(`Found DP${dpId} type:${dpType} length:${dpLength} at offset:${offset}`);
        
        if (offset + 4 + dpLength > payload.length) {
          this.log(`DP${dpId} extends beyond payload, stopping`);
          break;
        }
        
        const dpData = payload.slice(offset + 4, offset + 4 + dpLength);
        this.log(`DP${dpId} data: ${dpData.toString('hex')}`);
        
        // Battery could be in various DPs - check multiple possibilities
        if ((dpId === 12 || dpId === 13 || dpId === 15 || dpId === 5) && dpType === 0x02) {
          // Integer type
          if (dpLength === 4) {
            const batteryLevel = dpData.readUInt32BE(0);
            this.log(`Found potential battery in DP${dpId}: ${batteryLevel}`);
            if (batteryLevel >= 0 && batteryLevel <= 100) {
              return batteryLevel;
            }
          } else if (dpLength === 1) {
            const batteryLevel = dpData[0];
            this.log(`Found potential battery in DP${dpId}: ${batteryLevel}`);
            if (batteryLevel >= 0 && batteryLevel <= 100) {
              return batteryLevel;
            }
          }
        }
        
        offset += 4 + dpLength;
      } catch (error) {
        this.log(`Error parsing DP at offset ${offset}: ${error.message}`);
        break;
      }
    }
    
    // Approach 2: Look for raw battery values in common positions
    if (payload.length >= 4) {
      for (let i = 0; i <= payload.length - 4; i++) {
        const value = payload.readUInt32BE(i);
        if (value >= 0 && value <= 100) {
          this.log(`Found potential battery value ${value} at offset ${i}`);
          // Additional validation - check if surrounding bytes make sense
          if (i > 0) {
            const prevByte = payload[i - 1];
            if (prevByte === 12 || prevByte === 13 || prevByte === 15) { // Common battery DP IDs
              this.log(`Battery value ${value} looks valid (preceded by DP${prevByte})`);
              return value;
            }
          }
        }
      }
    }
    
    // Approach 3: Look for single byte battery values
    for (let i = 0; i < payload.length; i++) {
      const value = payload[i];
      if (value >= 10 && value <= 100) { // Reasonable battery range
        // Check if this could be a battery value by looking at context
        if (i > 0 && (payload[i-1] === 12 || payload[i-1] === 13 || payload[i-1] === 15)) {
          this.log(`Found potential single-byte battery: ${value} at offset ${i}`);
          return value;
        }
      }
    }
    
    this.log('No battery information found in payload');
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
          this.log(`Write completed successfully`);
          // Small delay to allow device processing
          setTimeout(() => resolve(), 100);
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