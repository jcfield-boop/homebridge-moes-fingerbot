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
    this.scanDuration = config.scanDuration || 10000;
    this.scanRetries = config.scanRetries || 3;
    this.connectionTimeout = config.connectionTimeout || 25000;
    
    // Protocol state
    this.sequenceNumber = Math.floor(Math.random() * 65535);
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
      setTimeout(() => this.updateBatteryLevel(), 5000);
    }
  }

  setupBluetoothEvents() {
    noble.on('stateChange', (state) => {
      this.log(`Bluetooth state changed to: ${state}`);
      if (state === 'poweredOn') {
        this.bluetoothReady = true;
        this.log('Bluetooth adapter ready');
        setTimeout(() => this.updateBatteryLevel(), 5000);
      } else {
        this.bluetoothReady = false;
        this.log('Bluetooth adapter not available');
        this.forceDisconnect();
      }
    });

    noble.on('discover', (peripheral) => {
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
    return 'plus';
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

  canPerformBLEOperation() {
    if (!this.bluetoothReady) {
      throw new Error('Bluetooth not ready');
    }
    if (this.connecting) {
      throw new Error('Already connecting');
    }
    return true;
  }

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
            this.log(`Found target device: ${peripheral.address} (RSSI: ${peripheral.rssi})`);
            
            clearTimeout(scanTimeout);
            noble.stopScanning();
            noble.removeListener('discover', discoverHandler);

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
            
            // Find Tuya BLE characteristics
            let writeChar = characteristics.find(char =>
              char.uuid.replace(/^0+/, '') === '2b11'
            );
            if (!writeChar) {
              writeChar = characteristics.find(char =>
                char.properties.includes('write') || char.properties.includes('writeWithoutResponse')
              );
            }

            let notifyChar = characteristics.find(char =>
              char.uuid.replace(/^0+/, '') === '2b10'
            );
            if (!notifyChar) {
              notifyChar = characteristics.find(char =>
                char.properties.includes('notify') || char.properties.includes('indicate')
              );
            }

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
        }, 4000);
      });
    });
  }

  cleanupConnection(peripheral) {
    try {
      if (peripheral && peripheral.state === 'connected') {
        peripheral.disconnect();
      }
    } catch (error) {
      this.log(`Cleanup error: ${error.message}`);
    }
  }

  async executeButtonPress(connectionInfo) {
    const { peripheral, writeChar, notifyChar } = connectionInfo;
    
    if (notifyChar) {
      await this.setupNotifications(notifyChar);
      await this.delay(500);
    }
    
    await this.authenticateDevice(writeChar, notifyChar);
    await this.delay(1000);
    
    if (this.deviceModel === 'plus') {
      await this.executeFingerbotPlusPress(writeChar);
    } else {
      await this.executeGenericPress(writeChar);
    }
  }

  async readBatteryLevel(connectionInfo) {
    const { peripheral, writeChar, notifyChar } = connectionInfo;
    
    return new Promise(async (resolve, reject) => {
      let responseTimeout = null;
      let batteryLevel = -1;

      if (notifyChar) {
        const notificationHandler = (data) => {
          try {
            this.log(`Battery response received: ${data.toString('hex')}`);
            const parsedData = this.parseTuyaResponse(data);
            if (parsedData && (parsedData.command === 0x08 || parsedData.command === 0x07)) {
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
        await this.authenticateDevice(writeChar, notifyChar);
        await this.delay(1000);
        
        this.log('Requesting device status for battery level...');
        const statusPacket = this.createTuyaPacket(0x08, Buffer.alloc(0));
        await this.writeCharacteristic(writeChar, statusPacket);
        
        responseTimeout = setTimeout(() => {
          this.log('Battery status request timeout - no response received');
          if (notifyChar) {
            notifyChar.removeAllListeners('data');
          }
          resolve(-1);
        }, 10000);
        
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

  async authenticateDevice(writeChar, notifyChar) {
    return new Promise(async (resolve, reject) => {
      try {
        this.generateSessionKey();
        
        let authTimeout = null;
        let authenticated = false;
        
        if (notifyChar) {
          const authHandler = (data) => {
            try {
              this.log(`Auth response received: ${data.toString('hex')}`);
              const parsedData = this.parseTuyaResponse(data);
              
              if (parsedData) {
                this.log(`Auth response: cmd=0x${parsedData.command.toString(16).padStart(2, '0')}, len=${parsedData.length}`);
                
                if (parsedData.command === 0x01 || parsedData.command === 0x02 || parsedData.command === 0x03) {
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
        
        // Step 1: Send login packet with device UUID
        const deviceUuid = this.createDeviceUUID();
        this.log('Sending authentication packet...');
        const loginPacket = this.createTuyaPacket(0x01, deviceUuid);
        await this.writeCharacteristic(writeChar, loginPacket);
        await this.delay(1000);
        
        // Step 2: Send session key exchange packet
        this.log('Sending session key exchange packet...');
        const timestamp = Math.floor(Date.now() / 1000);
        const sessionData = Buffer.concat([
          Buffer.alloc(4),
          this.sessionKey.slice(0, 16)
        ]);
        sessionData.writeUInt32BE(timestamp, 0);
        
        const sessionPacket = this.createTuyaPacket(0x02, sessionData);
        await this.writeCharacteristic(writeChar, sessionPacket);
        
        const authTimeoutMs = notifyChar ? 10000 : 8000;
        
        authTimeout = setTimeout(() => {
          if (notifyChar) {
            notifyChar.removeAllListeners('data');
          }
          
          if (!authenticated) {
            this.deviceAuthenticated = true;
            this.log('Authentication timeout - assuming success for Fingerbot device');
            resolve();
          }
        }, authTimeoutMs);
        
      } catch (error) {
        this.log(`Authentication failed: ${error.message}`);
        reject(error);
      }
    });
  }

  createDeviceUUID() {
    const deviceUuid = Buffer.alloc(16, 0x00);
    const deviceIdBuffer = Buffer.from(this.deviceId, 'utf8');
    
    const copyLength = Math.min(deviceIdBuffer.length, 16);
    deviceIdBuffer.copy(deviceUuid, 0, 0, copyLength);
    
    this.log(`Device UUID for auth: ${deviceUuid.toString('hex')}`);
    this.log(`Original device ID: "${this.deviceId}"`);
    
    return deviceUuid;
  }

  generateSessionKey() {
    try {
      let keyBuffer;
      const localKey = this.localKey.toString();
      
      this.log(`Local key length: ${localKey.length}, content: "${localKey}"`);
      
      if (localKey.length === 32 && /^[0-9a-fA-F]+$/.test(localKey)) {
        keyBuffer = Buffer.from(localKey, 'hex');
        this.log('Using hex format local key');
      } else {
        const keyBytes = Buffer.from(localKey, 'utf8');
        
        if (keyBytes.length === 16) {
          keyBuffer = keyBytes;
          this.log('Using UTF-8 key (exact 16 bytes)');
        } else if (keyBytes.length < 16) {
          keyBuffer = Buffer.alloc(16, 0x00);
          keyBytes.copy(keyBuffer, 0);
          this.log(`Padded UTF-8 key from ${keyBytes.length} to 16 bytes`);
        } else {
          keyBuffer = keyBytes.slice(0, 16);
          this.log(`Truncated UTF-8 key from ${keyBytes.length} to 16 bytes`);
        }
      }
      
      this.sessionKey = keyBuffer;
      this.log(`Session key generated (${keyBuffer.length} bytes): ${this.sessionKey.toString('hex')}`);
      
      if (this.sessionKey.length !== 16) {
        throw new Error(`Invalid session key length: ${this.sessionKey.length}, expected 16`);
      }
      
    } catch (error) {
      this.log(`Session key generation failed: ${error.message}`);
      throw error;
    }
  }

  async executeFingerbotPlusPress(writeChar) {
    this.log('Executing Fingerbot Plus press sequence...');
    try {
      // Step 1: Set mode to click (DP2, enum 0)
      this.log('Setting mode to click...');
      const modeDP = this.createDPEnumPacket(2, 0);
      const modePacket = this.createTuyaPacket(0x06, [modeDP], true);
      await this.writeCharacteristic(writeChar, modePacket);
      await this.delay(800);

      // Step 2: Set sustain time (DP4, in 100ms units)
      const sustainTime = Math.floor(this.pressTime / 100);
      this.log(`Setting sustain time to ${sustainTime} (${this.pressTime}ms)...`);
      const sustainDP = this.createDPIntPacket(4, sustainTime);
      const sustainPacket = this.createTuyaPacket(0x06, [sustainDP], true);
      await this.writeCharacteristic(writeChar, sustainPacket);
      await this.delay(800);

      // Step 3: Trigger press (DP1, bool true)
      this.log('Triggering press...');
      const pressDP = this.createDPBooleanPacket(1, true);
      const pressPacket = this.createTuyaPacket(0x06, [pressDP], true);
      await this.writeCharacteristic(writeChar, pressPacket);

      const totalWaitTime = this.pressTime + 2000;
      this.log(`Waiting ${totalWaitTime}ms for press cycle completion...`);
      await this.delay(totalWaitTime);
      
    } catch (error) {
      this.log(`Fingerbot Plus press failed: ${error.message}`);
      throw error;
    }
  }

  async executeGenericPress(writeChar) {
    this.log('Executing generic press sequence...');
    
    const pressData = this.createDPBooleanPacket(1, true);
    const pressPacket = this.createTuyaPacket(0x06, pressData, true);
    await this.writeCharacteristic(writeChar, pressPacket);
    await this.delay(this.pressTime);
    
    const releaseData = this.createDPBooleanPacket(1, false);
    const releasePacket = this.createTuyaPacket(0x06, releaseData, true);
    await this.writeCharacteristic(writeChar, releasePacket);
  }

  createDPBooleanPacket(dpId, value) {
    const buffer = Buffer.alloc(5);
    let offset = 0;
    
    buffer.writeUInt8(dpId, offset++);
    buffer.writeUInt8(0x01, offset++);
    buffer.writeUInt16BE(0x0001, offset);
    offset += 2;
    buffer.writeUInt8(value ? 0x01 : 0x00, offset);
    
    this.log(`Created DP${dpId} boolean packet (${value}): ${buffer.toString('hex')}`);
    return buffer;
  }

  createDPEnumPacket(dpId, enumValue) {
    const buffer = Buffer.alloc(5);
    let offset = 0;
    
    buffer.writeUInt8(dpId, offset++);
    buffer.writeUInt8(0x04, offset++);
    buffer.writeUInt16BE(0x0001, offset);
    offset += 2;
    buffer.writeUInt8(enumValue, offset);
    
    this.log(`Created DP${dpId} enum packet (${enumValue}): ${buffer.toString('hex')}`);
    return buffer;
  }

  createDPIntPacket(dpId, intValue) {
    const buffer = Buffer.alloc(8);
    let offset = 0;
    
    buffer.writeUInt8(dpId, offset++);
    buffer.writeUInt8(0x02, offset++);
    buffer.writeUInt16BE(0x0004, offset);
    offset += 2;
    buffer.writeUInt32BE(intValue, offset);
    
    this.log(`Created DP${dpId} integer packet (${intValue}): ${buffer.toString('hex')}`);
    return buffer;
  }

  createTuyaPacket(commandType, dpBuffers = [], encrypt = false) {
    try {
      this.sequenceNumber = (this.sequenceNumber + 1) & 0xFFFF;

      let payload = Buffer.isBuffer(dpBuffers) 
        ? dpBuffers 
        : (Array.isArray(dpBuffers) ? Buffer.concat(dpBuffers) : Buffer.alloc(0));

      let finalData = payload;
      let securityFlag = 0x00;

      if (encrypt && this.sessionKey && this.deviceAuthenticated) {
        if (this.deviceModel === 'plus') {
          const encResult = this.encryptDataCBC(payload);
          securityFlag = 0x05;
          finalData = Buffer.concat([
            Buffer.from([securityFlag]), 
            encResult.iv, 
            encResult.encrypted
          ]);
          this.log(`Using CBC encryption with security flag 0x05`);
        } else {
          const encrypted = this.encryptDataECB(payload);
          securityFlag = 0x03;
          finalData = Buffer.concat([
            Buffer.from([securityFlag]), 
            encrypted
          ]);
          this.log(`Using ECB encryption with security flag 0x03`);
        }
      } else if (encrypt) {
        this.log('Encryption requested but conditions not met - sending unencrypted');
      }

      const packet = Buffer.alloc(8 + finalData.length);
      let offset = 0;

      packet.writeUInt16BE(0x55AA, offset); offset += 2;
      packet.writeUInt16BE(this.sequenceNumber, offset); offset += 2;
      packet.writeUInt8(commandType, offset); offset += 1;
      packet.writeUInt16BE(finalData.length, offset); offset += 2;
      if (finalData.length > 0) {
        finalData.copy(packet, offset); 
        offset += finalData.length;
      }
      
      let checksum = 0;
      for (let i = 0; i < packet.length - 1; i++) {
        checksum = (checksum + packet[i]) & 0xFF;
      }
      packet.writeUInt8(checksum, offset);

      this.log(`TX (${encrypt ? 'encrypted' : 'plain'}): ${packet.toString('hex')}`);
      return packet;
    } catch (error) {
      this.log(`Packet creation failed: ${error.message}`);
      throw error;
    }
  }

  encryptDataCBC(data) {
    try {
      if (!this.sessionKey) {
        throw new Error('Session key not available for encryption');
      }
      
      const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const iv = crypto.randomBytes(16);
      
      const paddingLength = 16 - (dataBuffer.length % 16);
      const paddedData = Buffer.concat([
        dataBuffer, 
        Buffer.alloc(paddingLength, paddingLength)
      ]);
      
      this.log(`Encrypting ${dataBuffer.length} bytes (padded to ${paddedData.length}) with CBC`);
      
      const cipher = crypto.createCipheriv('aes-128-cbc', this.sessionKey, iv);
      cipher.setAutoPadding(false);
      
      const encrypted = Buffer.concat([cipher.update(paddedData), cipher.final()]);
      this.log(`CBC encrypted result: ${encrypted.length} bytes, IV: ${iv.toString('hex')}`);
      
      return { encrypted, iv };
    } catch (error) {
      this.log(`CBC encryption failed: ${error.message}`);
      throw error;
    }
  }

  encryptDataECB(data) {
    try {
      if (!this.sessionKey) {
        throw new Error('Session key not available for encryption');
      }
      
      const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      
      const paddingLength = 16 - (dataBuffer.length % 16);
      const paddedData = Buffer.concat([
        dataBuffer, 
        Buffer.alloc(paddingLength, paddingLength)
      ]);
      
      this.log(`Encrypting ${dataBuffer.length} bytes (padded to ${paddedData.length}) with ECB`);
      
      const cipher = crypto.createCipheriv('aes-128-ecb', this.sessionKey, null);
      cipher.setAutoPadding(false);
      
      const encrypted = Buffer.concat([cipher.update(paddedData), cipher.final()]);
      this.log(`ECB encrypted result: ${encrypted.length} bytes`);
      
      return encrypted;
    } catch (error) {
      this.log(`ECB encryption failed: ${error.message}`);
      throw error;
    }
  }

  parseTuyaResponse(data) {
    if (data.length < 8) {
      this.log(`Response too short: ${data.length} bytes`);
      return null;
    }
    
    try {
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
      
      if (this.sessionKey && payload.length > 0 && this.deviceAuthenticated) {
        payload = this.decryptPayload(payload, command);
      }
      
      return {
        sequence,
        command,
        length,
        payload,
        checksum
      };
    } catch (error) {
      this.log(`Response parsing failed: ${error.message}`);
      return null;
    }
  }

  decryptPayload(payload, command) {
    try {
      if (command === 0x01 || command === 0x02 || command === 0x03) {
        return payload;
      }
      
      if (payload.length === 0) {
        return payload;
      }
      
      const securityFlag = payload.readUInt8(0);
      this.log(`Security flag: 0x${securityFlag.toString(16).padStart(2, '0')}`);
      
      if (securityFlag === 0x05) {
        if (payload.length < 17) {
          this.log('Payload too short for CBC decryption');
          return payload;
        }
        
        const iv = payload.slice(1, 17);
        const encryptedData = payload.slice(17);
        
        this.log(`CBC decryption: IV=${iv.toString('hex')}, data=${encryptedData.length} bytes`);
        
        const decrypted = this.decryptDataCBC(encryptedData, iv);
        this.log(`Decrypted payload: ${decrypted.toString('hex')}`);
        return decrypted;
        
      } else if (securityFlag === 0x03) {
        const encryptedData = payload.slice(1);
        
        this.log(`ECB decryption: data=${encryptedData.length} bytes`);
        
        const decrypted = this.decryptDataECB(encryptedData);
        this.log(`Decrypted payload: ${decrypted.toString('hex')}`);
        return decrypted;
        
      } else if (securityFlag === 0x00) {
        return payload.slice(1);
      } else {
        this.log(`Unknown security flag: 0x${securityFlag.toString(16)}, treating as unencrypted`);
        return payload;
      }
      
    } catch (error) {
      this.log(`Decryption failed: ${error.message}, returning original payload`);
      return payload;
    }
  }

  decryptDataCBC(encryptedData, iv) {
    try {
      if (!this.sessionKey) {
        throw new Error('Session key not available for decryption');
      }
      
      const decipher = crypto.createDecipheriv('aes-128-cbc', this.sessionKey, iv);
      decipher.setAutoPadding(false);
      
      const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
      
      return this.removePKCS7Padding(decrypted);
      
    } catch (error) {
      this.log(`CBC decryption failed: ${error.message}`);
      throw error;
    }
  }

  decryptDataECB(encryptedData) {
    try {
      if (!this.sessionKey) {
        throw new Error('Session key not available for decryption');
      }
      
      const decipher = crypto.createDecipheriv('aes-128-ecb', this.sessionKey, null);
      decipher.setAutoPadding(false);
      
      const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
      
      return this.removePKCS7Padding(decrypted);
      
    } catch (error) {
      this.log(`ECB decryption failed: ${error.message}`);
      throw error;
    }
  }

  removePKCS7Padding(data) {
    if (data.length === 0) {
      return data;
    }
    
    const paddingLength = data[data.length - 1];
    
    if (paddingLength > 0 && paddingLength <= 16 && paddingLength <= data.length) {
      let validPadding = true;
      for (let i = data.length - paddingLength; i < data.length; i++) {
        if (data[i] !== paddingLength) {
          validPadding = false;
          break;
        }
      }
      
      if (validPadding) {
        return data.slice(0, data.length - paddingLength);
      }
    }
    
    this.log('Invalid PKCS7 padding detected, returning original data');
    return data;
  }

  extractBatteryFromStatus(payload) {
    this.log(`Extracting battery from ${payload.length} byte payload: ${payload.toString('hex')}`);
    
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

  async writeCharacteristic(characteristic, data) {
    return new Promise((resolve, reject) => {
      if (!characteristic) {
        return reject(new Error('Characteristic is null'));
      }
      
      if (!data || data.length === 0) {
        return reject(new Error('No data to write'));
      }
      
      this.log(`Writing ${data.length} bytes to characteristic ${characteristic.uuid}`);
      
      const useWriteWithoutResponse = characteristic.properties.includes('writeWithoutResponse');
      
      characteristic.write(data, !useWriteWithoutResponse, (error) => {
        if (error) {
          this.log(`Write error: ${error.message}`);
          reject(error);
        } else {
          this.log(`Write completed successfully`);
          setTimeout(() => resolve(), 200);
        }
      });
    });
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

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