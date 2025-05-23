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
    this.scanDuration = config.scanDuration || 8000; // Increased for better discovery
    this.scanRetries = config.scanRetries || 3;
    this.connectionTimeout = config.connectionTimeout || 20000; // Increased
    
    // Protocol state
    this.sequenceNumber = Math.floor(Math.random() * 65535); // Random start
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
      setTimeout(() => this.updateBatteryLevel(), 5000);
    }
  }

  setupBluetoothEvents() {
    noble.on('stateChange', (state) => {
      this.log(`Bluetooth state changed to: ${state}`);
      if (state === 'poweredOn') {
        this.bluetoothReady = true;
        this.log('Bluetooth adapter ready');
        // Initial battery check when Bluetooth becomes ready
        setTimeout(() => this.updateBatteryLevel(), 5000);
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
      'plus': ['blliqpsj', 'ndvkgsrm', 'yiihr7zh', 'neq16kgd', 'bjcvqwh0', 'eb4507wa', '6jcvqwh0', 'mknd4lci'],
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
                  this.log(`Retrying connection in 3 seconds...`);
                  setTimeout(attemptConnection, 3000);
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
            this.log(`Retrying scan in 3 seconds...`);
            setTimeout(startScan, 3000);
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
            
            // Find required characteristics for Tuya BLE
            const writeChar = characteristics.find(char => 
              char.uuid === '2b11' || 
              char.uuid.includes('2b11') ||
              (char.properties.includes('write') || char.properties.includes('writeWithoutResponse'))
            );
            
            const notifyChar = characteristics.find(char => 
              char.uuid === '2b10' || 
              char.uuid.includes('2b10') ||
              char.properties.includes('notify') || 
              char.properties.includes('indicate')
            );

            if (!writeChar) {
              this.log('Available characteristics:', characteristics.map(c => `${c.uuid} (${c.properties.join(',')})`).join(', '));
              return reject(new Error('No suitable write characteristic found'));
            }

            this.log(`Using write characteristic: ${writeChar.uuid}`);
            if (notifyChar) {
              this.log(`Using notify characteristic: ${notifyChar.uuid}`);
            } else {
              this.log('No notify characteristic found - will work without notifications');
            }

            this.log('Service discovery completed successfully');
            resolve({ peripheral, writeChar, notifyChar });
          });
        }, 4000); // Increased wait time for stability
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
      await this.delay(500); // Allow notifications to settle
    }
    
    // Authenticate with device
    await this.authenticateDevice(writeChar, notifyChar);
    await this.delay(1000); // Wait after authentication
    
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
            if (parsedData && (parsedData.command === 0x08 || parsedData.command === 0x07)) {
              // Status response - look for battery DP
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
        await this.delay(500);
      }

      try {
        // Authenticate first
        await this.authenticateDevice(writeChar, notifyChar);
        await this.delay(1000);
        
        // Request device status (includes battery)
        this.log('Requesting device status for battery level...');
        const statusPacket = this.createTuyaPacket(0x08, Buffer.alloc(0));
        await this.writeCharacteristic(writeChar, statusPacket);
        
        responseTimeout = setTimeout(() => {
          this.log('Battery status request timeout - no response received');
          if (notifyChar) {
            notifyChar.removeAllListeners('data');
          }
          resolve(-1); // Return -1 if no response
        }, 10000); // Increased timeout for battery reading
        
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

  // Authenticate with Tuya device - Fixed for Fingerbot Plus
  async authenticateDevice(writeChar, notifyChar) {
    return new Promise(async (resolve, reject) => {
      try {
        // Generate session key first
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
                this.log(`Auth response: cmd=0x${parsedData.command.toString(16)}, len=${parsedData.length}`);
                
                if (parsedData.command === 0x01 || parsedData.command === 0x02 || parsedData.command === 0x03) {
                  // Authentication response received
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
        
        // Create proper authentication payload
        // For Tuya BLE, the device ID should be exactly 16 bytes
        let deviceUuid = Buffer.alloc(16, 0x00);
        const deviceIdBuffer = Buffer.from(this.deviceId, 'utf8');
        
        // Copy device ID to UUID buffer, truncating if necessary
        const copyLength = Math.min(deviceIdBuffer.length, 16);
        deviceIdBuffer.copy(deviceUuid, 0, 0, copyLength);
        
        this.log(`Device UUID for auth: ${deviceUuid.toString('hex')}`);
        this.log(`Original device ID: "${this.deviceId}"`);
        
        // Send authentication packet (0x01 - Login/Authentication)
        this.log('Sending authentication packet...');
        const loginPacket = this.createTuyaPacket(0x01, deviceUuid);
        await this.writeCharacteristic(writeChar, loginPacket);
        
        // Wait before next command
        await this.delay(1000);
        
        // Send session key exchange packet (0x02 - Key Exchange)  
        this.log('Sending session key exchange packet...');
        const sessionData = Buffer.concat([
          Buffer.from([0x00, 0x00, 0x00, 0x00]), // Timestamp placeholder
          this.sessionKey.slice(0, 16) // First 16 bytes of session key
        ]);
        const sessionPacket = this.createTuyaPacket(0x02, sessionData);
        await this.writeCharacteristic(writeChar, sessionPacket);
        
        // Set timeout for authentication
        const authTimeoutMs = notifyChar ? 8000 : 5000; // Increased timeout
        
        authTimeout = setTimeout(() => {
          if (notifyChar) {
            notifyChar.removeAllListeners('data');
          }
          
          if (!authenticated) {
            // For some devices, no response might be normal
            this.deviceAuthenticated = true;
            this.log('Device authentication timeout - assuming success');
            resolve();
          }
        }, authTimeoutMs);
        
      } catch (error) {
        this.log(`Authentication failed: ${error.message}`);
        reject(error);
      }
    });
  }

  // Execute Fingerbot Plus specific press sequence - Fixed
  async executeFingerbotPlusPress(writeChar) {
    this.log('Executing Fingerbot Plus press sequence...');
    
    try {
      // For Fingerbot Plus firmware 2.0, use proper Tuya DP format
      // DP1 = Switch/Button (boolean)
      // DP2 = Mode (enum: 0=click, 1=switch, 2=program)
      // DP3 = Down movement (0-100%)
      // DP4 = Sustain time (in 100ms units)
      
      // First ensure we're in click mode (DP2)
      this.log('Setting device to click mode...');
      const modeData = this.createDPPacket(2, 'enum', 0); // Click mode
      const modePacket = this.createTuyaPacket(0x06, modeData, true);
      await this.writeCharacteristic(writeChar, modePacket);
      await this.delay(500);
      
      // Set sustain time (DP4) - convert pressTime to 100ms units
      const sustainTime = Math.floor(this.pressTime / 100);
      this.log(`Setting sustain time to ${sustainTime} (${this.pressTime}ms)...`);
      const sustainData = this.createDPPacket(4, 'value', sustainTime);
      const sustainPacket = this.createTuyaPacket(0x06, sustainData, true);
      await this.writeCharacteristic(writeChar, sustainPacket);
      await this.delay(500);
      
      // Trigger press (DP1)
      this.log('Triggering button press...');
      const pressData = this.createDPPacket(1, 'bool', true);
      const pressPacket = this.createTuyaPacket(0x06, pressData, true);
      await this.writeCharacteristic(writeChar, pressPacket);
      
      // Wait for the device to complete the press cycle
      await this.delay(this.pressTime + 1000);
      
    } catch (error) {
      this.log(`Fingerbot Plus press failed: ${error.message}`);
      throw error;
    }
  }

  // Execute generic press sequence
  async executeGenericPress(writeChar) {
    this.log('Executing generic press sequence...');
    
    // Press
    const pressData = this.createDPPacket(1, 'bool', true);
    const pressPacket = this.createTuyaPacket(0x06, pressData, true);
    await this.writeCharacteristic(writeChar, pressPacket);
    await this.delay(this.pressTime);
    
    // Release  
    const releaseData = this.createDPPacket(1, 'bool', false);
    const releasePacket = this.createTuyaPacket(0x06, releaseData, true);
    await this.writeCharacteristic(writeChar, releasePacket);
  }

  // Create Tuya DP (Data Point) packet - Fixed format
  createDPPacket(dpId, type, value) {
    let dpType, dpData;
    
    switch(type) {
      case 'bool':
        dpType = 0x01;
        dpData = Buffer.from([value ? 0x01 : 0x00]);
        break;
      case 'value':
        dpType = 0x02;
        dpData = Buffer.alloc(4);
        dpData.writeUInt32BE(value, 0);
        break;
      case 'enum':
        dpType = 0x04;
        dpData = Buffer.from([value]);
        break;
      default:
        throw new Error(`Unknown DP type: ${type}`);
    }
    
    const dpPacket = Buffer.alloc(4 + dpData.length);
    dpPacket.writeUInt8(dpId, 0);        // DP ID
    dpPacket.writeUInt8(dpType, 1);      // DP Type
    dpPacket.writeUInt16BE(dpData.length, 2); // DP Length (big endian)
    dpData.copy(dpPacket, 4);            // DP Data
    
    this.log(`Created DP${dpId} packet: ${dpPacket.toString('hex')}`);
    return dpPacket;
  }

  // Generate session key for encryption - Fixed
  generateSessionKey() {
    try {
      let keyBuffer;
      
      // Handle different key formats
      if (this.localKey.length === 32 && /^[0-9a-fA-F]+$/.test(this.localKey)) {
        // Hex key - from Tuya IoT platform
        keyBuffer = Buffer.from(this.localKey, 'hex');
        this.log('Using hex format local key');
      } else {
        // UTF-8 key - pad/truncate to 16 bytes
        const keyString = this.localKey.toString();
        keyBuffer = Buffer.from(keyString, 'utf8');
        
        if (keyBuffer.length > 16) {
          keyBuffer = keyBuffer.slice(0, 16);
          this.log('Truncated key to 16 bytes');
        } else if (keyBuffer.length < 16) {
          const padded = Buffer.alloc(16, 0x00);
          keyBuffer.copy(padded);
          keyBuffer = padded;
          this.log('Padded key to 16 bytes');
        }
      }
      
      this.sessionKey = keyBuffer;
      this.log(`Session key generated (${keyBuffer.length} bytes): ${this.sessionKey.toString('hex')}`);
      
    } catch (error) {
      this.log(`Session key generation failed: ${error.message}`);
      throw error;
    }
  }

  // Create Tuya BLE packet - Fixed format
  createTuyaPacket(commandType, data = Buffer.alloc(0), encrypt = false) {
    try {
      this.sequenceNumber = (this.sequenceNumber + 1) & 0xFFFF;
      
      let finalData = data;
      
      // Encrypt if required and session key available
      if (encrypt && this.sessionKey && this.deviceAuthenticated) {
        finalData = this.encryptData(data);
      }
      
      // Tuya BLE packet format:
      // [0x55AA] [seq(2,BE)] [cmd(1)] [len(2,BE)] [data] [checksum(1)]
      const packet = Buffer.alloc(8 + finalData.length);
      let offset = 0;
      
      // Header
      packet.writeUInt16BE(0x55AA, offset); offset += 2;
      
      // Sequence number
      packet.writeUInt16BE(this.sequenceNumber, offset); offset += 2;
      
      // Command
      packet.writeUInt8(commandType, offset); offset += 1;
      
      // Data length
      packet.writeUInt16BE(finalData.length, offset); offset += 2;
      
      // Data
      if (finalData.length > 0) {
        finalData.copy(packet, offset); offset += finalData.length;
      }
      
      // Calculate checksum (sum of all bytes except checksum byte)
      let checksum = 0;
      for (let i = 0; i < packet.length - 1; i++) {
        checksum = (checksum + packet[i]) & 0xFF;
      }
      packet.writeUInt8(checksum, offset);
      
      this.log(`TX: ${packet.toString('hex')}`);
      return packet;
      
    } catch (error) {
      this.log(`Packet creation failed: ${error.message}`);
      throw error;
    }
  }

  // Encrypt data using AES-128-ECB - Fixed
  encryptData(data) {
    try {
      if (!this.sessionKey) {
        throw new Error('Session key not available for encryption');
      }
      
      // Pad data to 16-byte boundary using PKCS7
      let paddedData = Buffer.from(data);
      const paddingNeeded = 16 - (data.length % 16);
      
      if (paddingNeeded !== 16) {
        const padding = Buffer.alloc(paddingNeeded, paddingNeeded);
        paddedData = Buffer.concat([data, padding]);
      }
      
      this.log(`Encrypting ${data.length} bytes (padded to ${paddedData.length})`);
      
      const cipher = crypto.createCipheriv('aes-128-ecb', this.sessionKey, null);
      cipher.setAutoPadding(false);
      
      const encrypted = Buffer.concat([cipher.update(paddedData), cipher.final()]);
      this.log(`Encrypted result: ${encrypted.length} bytes`);
      
      return encrypted;
    } catch (error) {
      this.log(`Encryption failed: ${error.message}`);
      throw error;
    }
  }

  // Decrypt data using AES-128-ECB - Fixed
  decryptData(encryptedData) {
    try {
      if (!this.sessionKey) {
        throw new Error('Session key not available for decryption');
      }
      
      const decipher = crypto.createDecipheriv('aes-128-ecb', this.sessionKey, null);
      decipher.setAutoPadding(false);
      
      const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
      
      // Remove PKCS7 padding
      if (decrypted.length > 0) {
        const paddingLength = decrypted[decrypted.length - 1];
        if (paddingLength > 0 && paddingLength <= 16) {
          return decrypted.slice(0, decrypted.length - paddingLength);
        }
      }
      
      return decrypted;
    } catch (error) {
      this.log(`Decryption failed: ${error.message}`);
      return encryptedData; // Return original data if decryption fails
    }
  }

  // Parse Tuya response packet
  parseTuyaResponse(data) {
    if (data.length < 8) {
      this.log(`Response too short: ${data.length} bytes`);
      return null;
    }
    
    try {
      // Check for valid Tuya header (0x55AA)
      const header = data.readUInt16BE(0);
      if (header !== 0x55AA) {
        this.log(`Invalid header: 0x${header.toString(16).padStart(4, '0')}`);
        return null;
      }
      
      const sequence = data.readUInt16BE(2);
      const command = data.readUInt8(4);
      const length = data.readUInt16BE(5);
      
      if (data.length < 8 + length) {
        this.log(`Incomplete packet: expected ${8 + length}, got ${data.length}`);
        return null;
      }
      
      let payload = data.slice(7, 7 + length);
      const checksum = data.readUInt8(7 + length);
      
      this.log(`RX: ${data.toString('hex')}`);
      this.log(`Parsed: seq=${sequence}, cmd=0x${command.toString(16).padStart(2, '0')}, len=${length}`);
      
      // Try to decrypt payload if encrypted
      if (this.sessionKey && payload.length > 0 && payload.length % 16 === 0 && 
          command !== 0x01 && command !== 0x02 && command !== 0x03) {
        try {
          const decryptedPayload = this.decryptData(payload);
          this.log(`Decrypted payload: ${decryptedPayload.toString('hex')}`);
          payload = decryptedPayload;
        } catch (error) {
          this.log(`Decryption failed, using raw payload: ${error.message}`);
        }
      }
      
      return {
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

  // Extract battery level from status payload - Enhanced
  extractBatteryFromStatus(payload) {
    this.log(`Extracting battery from ${payload.length} byte payload: ${payload.toString('hex')}`);
    
    // Parse Tuya DP format
    let offset = 0;
    while (offset < payload.length - 4) {
      try {
        const dpId = payload.readUInt8(offset);
        const dpType = payload.readUInt8(offset + 1);
        const dpLength = payload.readUInt16BE(offset + 2);
        
        if (offset + 4 + dpLength > payload.length) {
          this.log(`DP${dpId} extends beyond payload, stopping`);
          break;
        }
        
        const dpData = payload.slice(offset + 4, offset + 4 + dpLength);
        this.log(`DP${dpId} type:${dpType} length:${dpLength} data:${dpData.toString('hex')}`);
        
        // Battery is typically in DP12, DP13, or DP15 as integer value
        if ((dpId === 12 || dpId === 13 || dpId === 15 || dpId === 5) && dpType === 0x02) {
          if (dpLength === 4) {
            const batteryLevel = dpData.readUInt32BE(0);
            if (batteryLevel >= 0 && batteryLevel <= 100) {
              this.log(`Found battery level in DP${dpId}: ${batteryLevel}%`);
              return batteryLevel;
            }
          } else if (dpLength === 1) {
            const batteryLevel = dpData.readUInt8(0);
            if (batteryLevel >= 0 && batteryLevel <= 100) {
              this.log(`Found battery level in DP${dpId}: ${batteryLevel}%`);
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
      
      // Prefer writeWithoutResponse for better reliability
      const useWriteWithoutResponse = characteristic.properties.includes('writeWithoutResponse');
      
      characteristic.write(data, !useWriteWithoutResponse, (error) => {
        if (error) {
          this.log(`Write error: ${error.message}`);
          reject(error);
        } else {
          this.log(`Write completed successfully`);
          // Small delay to allow device processing
          setTimeout(() => resolve(), 200);
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