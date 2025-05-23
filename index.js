const noble = require('@abandonware/noble');
const crypto = require('crypto');

let Service, Characteristic;

module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory('homebridge-moes-fingerbot', 'MoesFingerbot', MoesFingerbotAccessory);
};

// CRC16 utility class
class CrcUtils {
  static crc16(data) {
    let crc = 0xFFFF;
    
    for (const byte of data) {
      crc ^= byte & 0xFF;
      for (let i = 0; i < 8; i++) {
        const tmp = crc & 1;
        crc >>= 1;
        if (tmp !== 0) {
          crc ^= 0xA001;
        }
      }
    }
    
    return crc;
  }
}

// Tuya data packet builder
class TuyaDataPacket {
  static prepareCrc(snAck, ackSn, code, inp, inpLength) {
    const header = Buffer.alloc(12);
    header.writeUInt32BE(snAck, 0);
    header.writeUInt32BE(ackSn, 4);
    header.writeUInt16BE(code, 8);
    header.writeUInt16BE(inpLength, 10);
    
    const raw = Buffer.concat([header, inp]);
    const crc = CrcUtils.crc16(raw);
    const crcBuffer = Buffer.alloc(2);
    crcBuffer.writeUInt16BE(crc, 0);
    
    return Buffer.concat([raw, crcBuffer]);
  }

  static getRandomIV() {
    return crypto.randomBytes(16);
  }

  static encryptPacket(secretKey, securityFlag, iv, data) {
    // Pad to 16-byte boundary
    while (data.length % 16 !== 0) {
      data = Buffer.concat([data, Buffer.from([0x00])]);
    }

    const cipher = crypto.createCipheriv('aes-128-cbc', secretKey, iv);
    const encryptedData = Buffer.concat([cipher.update(data), cipher.final()]);
    
    const output = Buffer.alloc(1 + 16 + encryptedData.length);
    let offset = 0;
    
    output.writeUInt8(securityFlag, offset); offset += 1;
    iv.copy(output, offset); offset += 16;
    encryptedData.copy(output, offset);
    
    return output;
  }
}

// Request packet builder
class XRequest {
  constructor(snAck, ackSn, code, securityFlag, secretKey, iv, inp, gattMtu = 20) {
    this.snAck = snAck;
    this.ackSn = ackSn;
    this.code = code;
    this.securityFlag = securityFlag;
    this.secretKey = secretKey;
    this.iv = iv;
    this.inp = inp;
    this.gattMtu = gattMtu;
  }

  pack() {
    const data = TuyaDataPacket.prepareCrc(this.snAck, this.ackSn, this.code, this.inp, this.inp.length);
    const encryptedData = TuyaDataPacket.encryptPacket(this.secretKey, this.securityFlag, this.iv, data);
    
    return this.splitPacket(2, encryptedData);
  }

  splitPacket(protocolVersion, data) {
    const output = [];
    let packetNumber = 0;
    let pos = 0;
    const length = data.length;
    
    while (pos < length) {
      const packet = Buffer.alloc(this.gattMtu);
      let offset = 0;
      
      // Packet number
      packet.writeUInt8(packetNumber, offset); offset += 1;
      
      if (packetNumber === 0) {
        // First packet includes length and protocol version
        packet.writeUInt8(length, offset); offset += 1;
        packet.writeUInt8(protocolVersion << 4, offset); offset += 1;
      }
      
      // Data
      const remainingSpace = this.gattMtu - offset;
      const dataToWrite = Math.min(remainingSpace, length - pos);
      data.copy(packet, offset, pos, pos + dataToWrite);
      
      // Create final packet with actual length
      const finalPacket = packet.slice(0, offset + dataToWrite);
      output.push(finalPacket);
      
      pos += dataToWrite;
      packetNumber += 1;
    }
    
    return output;
  }
}

// BLE receiver for parsing responses  
class BleReceiver {
  constructor(accessory) {
    this.accessory = accessory;
    this.reset();
  }

  reset() {
    this.lastIndex = 0;
    this.dataLength = 0;
    this.currentLength = 0;
    this.raw = Buffer.alloc(0);
    this.version = 0;
  }

  parseDataReceived(arr) {
    const status = this.unpack(arr);
    
    if (status === 0) {
      // Complete packet received
      const securityFlag = this.raw[0];
      const secretKey = this.accessory.secretKeys[securityFlag];
      
      if (!secretKey) {
        this.accessory.log(`❌ No secret key for security flag: ${securityFlag}`);
        return null;
      }
      
      const result = this.parseResponse(this.raw, this.version, secretKey);
      this.reset(); // Reset for next packet
      return result;
    }
    
    return null; // Incomplete packet
  }

  unpack(arr) {
    let i = 0;
    let packetNumber = 0;
    
    // Parse packet number
    while (i < 4 && i < arr.length) {
      const b = arr[i];
      packetNumber |= (b & 255) << (i * 7);
      if (((b >> 7) & 1) === 0) {
        break;
      }
      i++;
    }
    
    let pos = i + 1;
    
    if (packetNumber === 0) {
      // First packet - parse length and version
      this.dataLength = 0;
      
      while (pos <= i + 4 && pos < arr.length) {
        const b2 = arr[pos];
        this.dataLength |= (b2 & 255) << (((pos - 1) - i) * 7);
        if (((b2 >> 7) & 1) === 0) {
          break;
        }
        pos++;
      }
      
      this.currentLength = 0;
      this.lastIndex = 0;
      
      if (pos === i + 5 || arr.length < pos + 2) {
        return 2; // Error
      }
      
      this.raw = Buffer.alloc(0);
      pos += 1;
      this.version = (arr[pos] >> 4) & 15;
      pos += 1;
    }
    
    if (packetNumber === 0 || packetNumber > this.lastIndex) {
      const data = arr.slice(pos);
      this.currentLength += data.length;
      this.lastIndex = packetNumber;
      this.raw = Buffer.concat([this.raw, data]);
      
      if (this.currentLength < this.dataLength) {
        return 1; // Need more data
      }
      
      return this.currentLength === this.dataLength ? 0 : 3; // Complete or error
    }
    
    return 1; // Need more data
  }

  parseResponse(raw, version, secretKey) {
    try {
      const securityFlag = raw[0];
      const iv = raw.slice(1, 17);
      const encryptedData = raw.slice(17);
      
      // Decrypt
      const decipher = crypto.createDecipheriv('aes-128-cbc', secretKey, iv);
      const decryptedData = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
      
      // Parse decrypted data
      const sn = decryptedData.readUInt32BE(0);
      const snAck = decryptedData.readUInt32BE(4);
      const code = decryptedData.readUInt16BE(8);
      const length = decryptedData.readUInt16BE(10);
      const rawData = decryptedData.slice(12, 12 + length);
      
      this.accessory.log(`📋 Decrypted: sn=${sn}, snAck=${snAck}, code=${code}, length=${length}`);
      
      let resp = null;
      
      if (code === 0) {
        // Device info response
        resp = this.parseDeviceInfoResponse(rawData);
      } else if (code === 2) {
        // DP response
        resp = this.parseDPResponse(rawData);
      }
      
      return {
        raw,
        version,
        securityFlag,
        code,
        resp
      };
      
    } catch (error) {
      this.accessory.log(`❌ Response parsing failed: ${error.message}`);
      return null;
    }
  }

  parseDeviceInfoResponse(rawData) {
    if (rawData.length < 46) {
      return { success: false };
    }
    
    try {
      const deviceVersionMajor = rawData.readUInt8(0);
      const deviceVersionMinor = rawData.readUInt8(1);
      const protocolVersionMajor = rawData.readUInt8(2);
      const protocolVersionMinor = rawData.readUInt8(3);
      const flag = rawData.readUInt8(4);
      const isBind = rawData.readUInt8(5);
      const srand = rawData.slice(6, 12);
      const hardwareVersionMajor = rawData.readUInt8(12);
      const hardwareVersionMinor = rawData.readUInt8(13);
      const authKey = rawData.slice(14, 46);
      
      const deviceVersion = `${deviceVersionMajor}.${deviceVersionMinor}`;
      const protocolVersion = `${protocolVersionMajor}.${protocolVersionMinor}`;
      
      const protocolNumber = protocolVersionMajor * 10 + protocolVersionMinor;
      if (protocolNumber < 20) {
        return { success: false };
      }
      
      return {
        success: true,
        device_version: deviceVersion,
        protocol_version: protocolVersion,
        flag,
        is_bind: isBind,
        srand
      };
      
    } catch (error) {
      this.accessory.log(`❌ Device info parsing failed: ${error.message}`);
      return { success: false };
    }
  }

  parseDPResponse(rawData) {
    this.accessory.log(`📦 DP Response data: ${rawData.toString('hex')}`);
    
    // Parse DP data to extract battery level if present
    let offset = 0;
    const dps = {};
    
    while (offset < rawData.length - 3) {
      try {
        const dpId = rawData.readUInt8(offset);
        const dpType = rawData.readUInt8(offset + 1);
        const dpLength = rawData.readUInt8(offset + 2);
        
        if (offset + 3 + dpLength > rawData.length) {
          break;
        }
        
        const dpData = rawData.slice(offset + 3, offset + 3 + dpLength);
        this.accessory.log(`📊 DP${dpId} type:${dpType} length:${dpLength} data:${dpData.toString('hex')}`);
        
        // Extract value based on type
        let value;
        if (dpType === 1 && dpLength === 1) { // Boolean
          value = dpData.readUInt8(0) === 1;
        } else if (dpType === 2 && dpLength === 4) { // Integer
          value = dpData.readUInt32BE(0);
        } else if (dpType === 4 && dpLength === 1) { // Enum
          value = dpData.readUInt8(0);
        }
        
        dps[dpId] = value;
        
        // Check for battery level (common DP IDs for battery)
        if ((dpId === 12 || dpId === 13 || dpId === 15 || dpId === 5) && dpType === 2) {
          if (value >= 0 && value <= 100) {
            this.accessory.log(`🔋 Found battery level in DP${dpId}: ${value}%`);
            this.accessory.batteryLevel = value;
          }
        }
        
        offset += 3 + dpLength;
      } catch (error) {
        this.accessory.log(`❌ Error parsing DP at offset ${offset}: ${error.message}`);
        break;
      }
    }
    
    return { dps };
  }
}

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

    // Configuration - adjusted for better stability
    this.pressTime = config.pressTime || 3000;
    this.scanDuration = config.scanDuration || 15000; // Increased
    this.scanRetries = config.scanRetries || 2; // Reduced
    this.connectionTimeout = config.connectionTimeout || 35000; // Increased
    this.minRssi = config.minRssi || -95; // Minimum signal strength
    
    // Tuya BLE Protocol state
    this.snAck = 0;
    this.secretKeys = {};
    this.srand = null;
    this.gattMtu = 20;
    
    // Initialize login key (first 6 chars only!)
    this.loginKey = Buffer.from(this.localKey.slice(0, 6), 'utf8');
    this.uuid = Buffer.from(this.deviceId, 'utf8');
    this.devId = Buffer.from(this.deviceId, 'utf8');
    
    this.log(`🔑 Login key (first 6 chars): "${this.localKey.slice(0, 6)}" -> ${this.loginKey.toString('hex')}`);
    
    // Generate initial secret key for device info (security flag 4)
    this.secretKeys[4] = crypto.createHash('md5').update(this.loginKey).digest();
    this.log(`🔐 Secret key (flag 4): ${this.secretKeys[4].toString('hex')}`);
    
    // Device state
    this.isOn = false;
    this.batteryLevel = -1;
    this.connecting = false;
    this.currentPeripheral = null;
    this.bluetoothReady = false;
    this.bleReceiver = new BleReceiver(this);
    this.operationInProgress = false; // Prevent race conditions
    
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
      // Don't auto-check battery on startup to avoid conflicts
    }
  }

  setupBluetoothEvents() {
    noble.on('stateChange', (state) => {
      this.log(`Bluetooth state changed to: ${state}`);
      if (state === 'poweredOn') {
        this.bluetoothReady = true;
        this.log('Bluetooth adapter ready');
        // Don't auto-check battery to avoid conflicts
      } else {
        this.bluetoothReady = false;
        this.log('Bluetooth adapter not available');
        this.forceDisconnect();
      }
    });

    noble.on('discover', (peripheral) => {
      if (peripheral.address === this.address) {
        this.log(`Discovered target device: ${peripheral.address} (RSSI: ${peripheral.rssi})`);
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
    if (this.connecting || this.operationInProgress) {
      throw new Error('Operation already in progress');
    }
    return true;
  }

  async pressButton() {
    let retryCount = 0;
    const maxRetries = 2;
    
    while (retryCount <= maxRetries) {
      try {
        this.canPerformBLEOperation();
        this.operationInProgress = true;
        
        if (retryCount > 0) {
          this.log(`🔄 Retry attempt ${retryCount}/${maxRetries}`);
        }
        
        this.log('🔴 Activating Fingerbot...');
        const connectionInfo = await this.scanAndConnect();
        await this.performTuyaBLESequence(connectionInfo, 'press');
        this.log('✅ Button press completed successfully');
        return; // Success - exit retry loop
        
      } catch (error) {
        this.log(`❌ Button press failed: ${error.message}`);
        
        // Retry for connection-related issues
        if ((error.message.includes('disconnected') || error.message.includes('timeout')) && retryCount < maxRetries) {
          retryCount++;
          this.operationInProgress = false;
          this.forceDisconnect();
          this.log(`⏳ Waiting 3 seconds before retry...`);
          await this.delay(3000);
          continue;
        }
        
        throw error; // Don't retry for other errors
      } finally {
        this.operationInProgress = false;
        this.forceDisconnect();
      }
    }
  }

  async updateBatteryLevel() {
    let retryCount = 0;
    const maxRetries = 2;
    
    while (retryCount <= maxRetries) {
      try {
        this.canPerformBLEOperation();
        this.operationInProgress = true;
        
        if (retryCount > 0) {
          this.log(`🔄 Battery check retry ${retryCount}/${maxRetries}`);
        }
        
        this.log('🔋 Checking battery level...');
        const connectionInfo = await this.scanAndConnect();
        await this.performTuyaBLESequence(connectionInfo, 'battery');
        
        if (this.batteryLevel >= 0) {
          this.batteryService.updateCharacteristic(Characteristic.BatteryLevel, this.batteryLevel);
          this.log(`Battery level: ${this.batteryLevel}%`);
        } else {
          this.log('Could not read battery level');
        }
        return; // Success
        
      } catch (error) {
        this.log(`Battery check failed: ${error.message}`);
        
        if ((error.message.includes('disconnected') || error.message.includes('timeout')) && retryCount < maxRetries) {
          retryCount++;
          this.operationInProgress = false;
          this.forceDisconnect();
          await this.delay(3000);
          continue;
        }
        
        // Don't throw error for battery check - just log it
        this.log(`❌ Battery check ultimately failed after retries`);
        return;
      } finally {
        this.operationInProgress = false;
        this.forceDisconnect();
      }
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
            
            // Check signal strength
            if (peripheral.rssi < this.minRssi) {
              this.log(`⚠️  Device found but signal too weak: ${peripheral.rssi} dBm (min: ${this.minRssi})`);
              return;
            }
            
            peripheralFound = true;
            this.log(`📡 Found target device: ${peripheral.address} (RSSI: ${peripheral.rssi})`);
            
            clearTimeout(scanTimeout);
            noble.stopScanning();
            noble.removeListener('discover', discoverHandler);

            try {
              // Wait a moment before connecting to ensure device is ready
              await this.delay(1000);
              const connectionInfo = await this.connectToPeripheral(peripheral);
              this.connecting = false;
              resolve(connectionInfo);
            } catch (error) {
              this.connecting = false;
              reject(error);
            }
          }
        };

        noble.on('discover', discoverHandler);
        
        this.log(`🔍 Scanning for device (attempt ${retryCount + 1}/${this.scanRetries + 1})...`);
        
        noble.startScanning([], true, (error) => {
          if (error) {
            this.log(`Scan start error: ${error.message}`);
            this.connecting = false;
            reject(error);
            return;
          }
        });

        scanTimeout = setTimeout(() => {
          this.log(`⏰ Scan timeout reached for attempt ${retryCount + 1}`);
          noble.stopScanning();
          noble.removeListener('discover', discoverHandler);

          if (!peripheralFound && retryCount < this.scanRetries) {
            retryCount++;
            this.log(`🔄 Retrying scan in 3 seconds...`);
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
        this.log('⏰ Connection timeout');
        this.cleanupConnection(peripheral);
        reject(new Error('Connection timeout'));
      }, this.connectionTimeout);

      const disconnectHandler = (error) => {
        this.log('❌ Device disconnected during connection setup');
        clearTimeout(connectionTimeout);
        peripheral.removeListener('disconnect', disconnectHandler);
        this.currentPeripheral = null;
        reject(new Error('Device disconnected during connection'));
      };

      peripheral.once('disconnect', disconnectHandler);

      this.log('🔌 Attempting to connect...');
      peripheral.connect((error) => {
        if (error) {
          this.log(`❌ Connection error: ${error.message}`);
          clearTimeout(connectionTimeout);
          peripheral.removeListener('disconnect', disconnectHandler);
          this.currentPeripheral = null;
          return reject(error);
        }

        this.log('✅ Connected successfully, starting protocol immediately...');
        
        // Don't wait - start service discovery immediately to keep device engaged
        this.log('🔍 Discovering services...');
        
        peripheral.discoverAllServicesAndCharacteristics((error, services, characteristics) => {
          clearTimeout(connectionTimeout);
          peripheral.removeListener('disconnect', disconnectHandler);
          
          if (error) {
            this.log(`❌ Service discovery error: ${error.message}`);
            return reject(error);
          }

          this.log(`📋 Found ${services.length} services and ${characteristics.length} characteristics`);
          this.log(`📋 Available characteristics: ${characteristics.map(c => c.uuid.replace('00002', '').replace('-0000-1000-8000-00805f9b34fb', '')).join(', ')}`);
          
          // Find Tuya BLE characteristics
          const writeChar = characteristics.find(char => char.uuid === '00002b11-0000-1000-8000-00805f9b34fb');
          const notifyChar = characteristics.find(char => char.uuid === '00002b10-0000-1000-8000-00805f9b34fb');

          if (!writeChar) {
            this.log('❌ Required write characteristic 2b11 not found');
            return reject(new Error('Required write characteristic not found'));
          }

          this.log(`✅ Using write characteristic: 2b11`);
          if (notifyChar) {
            this.log(`✅ Using notify characteristic: 2b10`);
            resolve({ peripheral, writeChar, notifyChar });
          } else {
            this.log('❌ Required notify characteristic 2b10 not found');
            reject(new Error('Required notify characteristic not found'));
          }
        });
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

  // Main Tuya BLE protocol sequence
  async performTuyaBLESequence(connectionInfo, action) {
    const { peripheral, writeChar, notifyChar } = connectionInfo;
    
    return new Promise(async (resolve, reject) => {
      let sequenceStep = 'device_info';
      let sequenceTimeout = null;
      
      this.bleReceiver.reset();
      this.resetSnAck();
      
      // Setup notification handler
      const notificationHandler = (data) => {
        this.log(`📥 RX: ${data.toString('hex')}`);
        
        const result = this.bleReceiver.parseDataReceived(data);
        if (!result) {
          return; // Incomplete packet
        }
        
        this.log(`📋 Parsed response: code=${result.code}, version=${result.version}`);
        
        if (sequenceStep === 'device_info' && result.code === 0) {
          // Device info response
          if (result.resp && result.resp.success) {
            this.log(`✅ Device info received: version=${result.resp.device_version}, protocol=${result.resp.protocol_version}`);
            this.srand = result.resp.srand;
            
            // Generate security flag 5 key with srand
            const combinedKey = Buffer.concat([this.loginKey, this.srand]);
            this.secretKeys[5] = crypto.createHash('md5').update(combinedKey).digest();
            this.log(`🔐 Secret key (flag 5): ${this.secretKeys[5].toString('hex')}`);
            
            // Send pair request
            sequenceStep = 'pairing';
            setTimeout(() => this.sendPairRequest(writeChar), 200); // Reduced delay
          } else {
            reject(new Error('Device info request failed'));
          }
        } else if (sequenceStep === 'pairing' && result.code === 1) {
          // Pairing response
          this.log(`✅ Pairing successful`);
          
          // Now send DP commands based on action
          sequenceStep = 'dp_commands';
          setTimeout(() => {
            if (action === 'press') {
              this.sendFingerbotPress(writeChar);
            } else if (action === 'battery') {
              this.sendBatteryRequest(writeChar);
            }
          }, 200); // Reduced delay
        } else if (sequenceStep === 'dp_commands' && result.code === 2) {
          // DP response
          this.log(`✅ DP command response received`);
          clearTimeout(sequenceTimeout);
          setTimeout(() => resolve(), 1000); // Give time for any additional responses
        }
      };

      try {
        // Subscribe to notifications
        await this.setupNotifications(notifyChar, notificationHandler);
        
        // Start sequence with device info request
        this.log('📤 Sending device info request...');
        this.sendDeviceInfoRequest(writeChar);
        
        // Set overall timeout
        sequenceTimeout = setTimeout(() => {
          this.log(`⏰ Sequence timeout at step: ${sequenceStep}`);
          reject(new Error(`Tuya BLE sequence timeout at ${sequenceStep}`));
        }, 30000);
        
      } catch (error) {
        reject(error);
      }
    });
  }

  async setupNotifications(notifyChar, handler) {
    return new Promise((resolve, reject) => {
      notifyChar.subscribe((error) => {
        if (error) {
          this.log(`❌ Notification setup failed: ${error.message}`);
          reject(error);
        } else {
          this.log('🔔 Notifications enabled');
          notifyChar.on('data', handler);
          resolve();
        }
      });
    });
  }

  // Reset sequence number
  resetSnAck() {
    this.snAck = 0;
  }

  nextSnAck() {
    this.snAck += 1;
    return this.snAck;
  }

  // Send device info request (step 1)
  sendDeviceInfoRequest(writeChar) {
    const inp = Buffer.alloc(0);
    const iv = TuyaDataPacket.getRandomIV();
    const securityFlag = 4;
    const secretKey = this.secretKeys[securityFlag];
    const snAck = this.nextSnAck();
    
    const request = new XRequest(snAck, 0, 0, securityFlag, secretKey, iv, inp, this.gattMtu);
    this.sendRequest(writeChar, request);
  }

  // Send pair request (step 2)
  sendPairRequest(writeChar) {
    const securityFlag = 5;
    const secretKey = this.secretKeys[securityFlag];
    const iv = TuyaDataPacket.getRandomIV();
    
    const inp = Buffer.alloc(16 + 6 + 22);
    let offset = 0;
    
    // UUID (16 bytes)
    this.uuid.copy(inp, offset, 0, Math.min(this.uuid.length, 16));
    offset += 16;
    
    // Login key (6 bytes)
    this.loginKey.copy(inp, offset);
    offset += 6;
    
    // Device ID (22 bytes, padded with zeros)
    this.devId.copy(inp, offset, 0, Math.min(this.devId.length, 22));
    
    const snAck = this.nextSnAck();
    const request = new XRequest(snAck, 0, 1, securityFlag, secretKey, iv, inp, this.gattMtu);
    
    this.log('📤 Sending pair request...');
    this.sendRequest(writeChar, request);
  }

  // Send fingerbot press DP commands (step 3)
  sendFingerbotPress(writeChar) {
    const securityFlag = 5;
    const secretKey = this.secretKeys[securityFlag];
    const iv = TuyaDataPacket.getRandomIV();
    
    // Create DP commands for fingerbot press
    const dps = [
      [8, 4, 0],        // Mode = click
      [9, 2, 80],       // ARM_DOWN_PERCENT
      [15, 2, 0],       // ARM_UP_PERCENT  
      [10, 2, Math.floor(this.pressTime / 100)], // CLICK_SUSTAIN_TIME (in 100ms units)
      [101, 1, true],   // CLICK = true
    ];
    
    const inp = this.createDPPayload(dps);
    const snAck = this.nextSnAck();
    const request = new XRequest(snAck, 0, 2, securityFlag, secretKey, iv, inp, this.gattMtu);
    
    this.log('📤 Sending fingerbot press command...');
    this.sendRequest(writeChar, request);
  }

  // Send battery request DP commands
  sendBatteryRequest(writeChar) {
    const securityFlag = 5;
    const secretKey = this.secretKeys[securityFlag];
    const iv = TuyaDataPacket.getRandomIV();
    
    // Request status - empty DP list typically requests all current values
    const dps = [];
    const inp = this.createDPPayload(dps);
    const snAck = this.nextSnAck();
    const request = new XRequest(snAck, 0, 2, securityFlag, secretKey, iv, inp, this.gattMtu);
    
    this.log('📤 Sending battery status request...');
    this.sendRequest(writeChar, request);
  }

  // Create DP payload in Tuya BLE format
  createDPPayload(dps) {
    let raw = Buffer.alloc(0);
    
    for (const dp of dps) {
      const [dpId, dpType, dpValue] = dp;
      
      // DP header: [DP_ID][DP_TYPE]
      const header = Buffer.alloc(2);
      header.writeUInt8(dpId, 0);
      header.writeUInt8(dpType, 1);
      
      let valueBuffer;
      
      if (dpType === 1) { // Boolean
        valueBuffer = Buffer.alloc(2);
        valueBuffer.writeUInt8(1, 0); // Length
        valueBuffer.writeUInt8(dpValue ? 1 : 0, 1); // Value
      } else if (dpType === 2) { // Integer  
        valueBuffer = Buffer.alloc(5);
        valueBuffer.writeUInt8(4, 0); // Length
        valueBuffer.writeUInt32BE(dpValue, 1); // Value
      } else if (dpType === 4) { // Enum
        valueBuffer = Buffer.alloc(2);
        valueBuffer.writeUInt8(1, 0); // Length
        valueBuffer.writeUInt8(dpValue, 1); // Value
      } else {
        throw new Error(`Unsupported DP type: ${dpType}`);
      }
      
      raw = Buffer.concat([raw, header, valueBuffer]);
    }
    
    this.log(`📦 Created DP payload: ${raw.toString('hex')}`);
    return raw;
  }

  sendRequest(writeChar, xRequest) {
    const packets = xRequest.pack();
    
    for (const packet of packets) {
      this.log(`📤 TX: ${packet.toString('hex')}`);
      this.writeCharacteristic(writeChar, packet);
    }
  }

  async writeCharacteristic(characteristic, data) {
    return new Promise((resolve, reject) => {
      characteristic.write(data, false, (error) => {
        if (error) {
          this.log(`❌ Write error: ${error.message}`);
          reject(error);
        } else {
          setTimeout(() => resolve(), 20); // Reduced from 50ms
        }
      });
    });
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  forceDisconnect() {
    this.log('🔌 Forcing disconnect and cleanup...');
    
    // Stop any ongoing scans first
    try {
      if (noble.state === 'poweredOn') {
        noble.stopScanning();
      }
      noble.removeAllListeners('discover');
    } catch (error) {
      this.log(`Scan cleanup error: ${error.message}`);
    }
    
    // Disconnect peripheral
    if (this.currentPeripheral) {
      try {
        this.log(`Disconnecting from peripheral (state: ${this.currentPeripheral.state})`);
        if (this.currentPeripheral.state === 'connected' || this.currentPeripheral.state === 'connecting') {
          this.currentPeripheral.disconnect();
        }
        this.currentPeripheral.removeAllListeners();
      } catch (error) {
        this.log(`Disconnect error: ${error.message}`);
      }
      this.currentPeripheral = null;
    }
    
    // Reset state
    this.connecting = false;
    this.operationInProgress = false;
    
    this.log('✅ Cleanup completed');
  }
}