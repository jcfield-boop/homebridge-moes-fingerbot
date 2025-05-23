const noble = require('@abandonware/noble');
const crypto = require('crypto');

let Service, Characteristic;

module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory('homebridge-moes-fingerbot', 'MoesFingerbot', MoesFingerbotAccessory);
};

// Tuya BLE Protocol Constants (from working Python code)
const Coder = {
  FUN_SENDER_DEVICE_INFO: 0,
  FUN_SENDER_PAIR: 1,
  FUN_SENDER_DPS: 2,
  FUN_SENDER_DEVICE_STATUS: 3,
  FUN_RECEIVE_TIME1_REQ: 32785,
  FUN_RECEIVE_DP: 32769
};

const DpType = {
  RAW: 0,
  BOOLEAN: 1,
  INT: 2,
  STRING: 3,
  ENUM: 4
};

// Working DP mappings from Python code
const DpAction = {
  ARM_DOWN_PERCENT: 9,      // Not 3!
  ARM_UP_PERCENT: 15,       // Not 7!
  CLICK_SUSTAIN_TIME: 10,   // Not 4!
  TAP_ENABLE: 17,
  MODE: 8,                  // Not 2!
  INVERT_SWITCH: 11,
  TOGGLE_SWITCH: 2,
  CLICK: 101,               // Not 1!
  PROG: 121
};

// Secret Key Manager (from Python)
class SecretKeyManager {
  constructor(loginKey) {
    this.loginKey = loginKey;
    this.keys = {
      4: crypto.createHash('md5').update(this.loginKey).digest()
    };
  }

  get(securityFlag) {
    return this.keys[securityFlag] || null;
  }

  setSrand(srand) {
    const combined = Buffer.concat([this.loginKey, srand]);
    this.keys[5] = crypto.createHash('md5').update(combined).digest();
  }
}

// CRC Utils (from Python)
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

// AES Utils (from Python)
class AesUtils {
  static decrypt(data, iv, key) {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  }

  static encrypt(data, iv, key) {
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    return Buffer.concat([cipher.update(data), cipher.final()]);
  }
}

// Tuya Data Packet (from Python)
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

  static getRandomIv() {
    return crypto.randomBytes(16);
  }

  static encryptPacket(secretKey, securityFlag, iv, data) {
    // Pad to 16-byte boundary
    while (data.length % 16 !== 0) {
      data = Buffer.concat([data, Buffer.from([0x00])]);
    }

    const encryptedData = AesUtils.encrypt(data, iv, secretKey);
    
    const output = Buffer.alloc(1 + 16 + encryptedData.length);
    let offset = 0;
    
    output.writeUInt8(securityFlag, offset); offset += 1;
    iv.copy(output, offset); offset += 16;
    encryptedData.copy(output, offset);
    
    return output;
  }
}

// XRequest (from Python)
class XRequest {
  constructor(snAck, ackSn, code, securityFlag, secretKey, iv, inp) {
    this.gattMtu = 20;
    this.snAck = snAck;
    this.ackSn = ackSn;
    this.code = code;
    this.securityFlag = securityFlag;
    this.secretKey = secretKey;
    this.iv = iv;
    this.inp = inp;
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

// BLE Receiver (from Python)
class BleReceiver {
  constructor(secretKeyManager, accessory) {
    this.secretKeyManager = secretKeyManager;
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

  parseDataReceived(arr) {
    const status = this.unpack(arr);
    
    if (status === 0) {
      // Complete packet received
      const securityFlag = this.raw[0];
      const secretKey = this.secretKeyManager.get(securityFlag);
      
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

  parseResponse(raw, version, secretKey) {
    try {
      const securityFlag = raw[0];
      const iv = raw.slice(1, 17);
      const encryptedData = raw.slice(17);
      
      // Decrypt
      const decryptedData = AesUtils.decrypt(encryptedData, iv, secretKey);
      
      // Parse decrypted data
      const sn = decryptedData.readUInt32BE(0);
      const snAck = decryptedData.readUInt32BE(4);
      const code = decryptedData.readUInt16BE(8);
      const length = decryptedData.readUInt16BE(10);
      const rawData = decryptedData.slice(12, 12 + length);
      
      this.accessory.log(`📋 Decrypted: sn=${sn}, snAck=${snAck}, code=${code}, length=${length}`);
      
      let resp = null;
      
      if (code === Coder.FUN_SENDER_DEVICE_INFO) {
        // Device info response
        resp = this.parseDeviceInfoResponse(rawData);
      } else if (code === Coder.FUN_SENDER_PAIR) {
        // Pair response
        resp = { success: true };
      } else if (code === Coder.FUN_SENDER_DPS) {
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
    // For now, just log the response
    return { dps: {} };
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
    
    this.log(`🔧 Python-based Configuration: deviceId=${this.deviceId}, address=${this.address}`);
    
    if (!this.deviceId || !this.localKey || !this.address) {
      this.log('❌ ERROR: deviceId, localKey, and address are all required');
      throw new Error('Missing required Tuya BLE credentials');
    }

    // Initialize like Python code
    this.uuid = Buffer.from(this.deviceId, 'utf8');
    this.devId = Buffer.from(this.deviceId, 'utf8');
    this.loginKey = Buffer.from(this.localKey.slice(0, 6), 'utf8');
    
    this.log(`🔑 Login key (first 6 chars): "${this.localKey.slice(0, 6)}" -> ${this.loginKey.toString('hex')}`);
    
    this.secretKeyManager = new SecretKeyManager(this.loginKey);
    this.bleReceiver = new BleReceiver(this.secretKeyManager, this);
    
    // Device state
    this.isOn = false;
    this.batteryLevel = -1;
    this.isConnected = false;
    this.currentPeripheral = null;
    this.bluetoothReady = false;
    this.operationInProgress = false;
    this.snAck = 0;
    
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

    // Setup Bluetooth
    this.setupBluetoothEvents();
    
    // Auto-test on startup
    if (noble.state === 'poweredOn') {
      this.bluetoothReady = true;
      this.log('Starting Python-based protocol test in 3 seconds...');
      setTimeout(() => {
        this.testPythonProtocol();
      }, 3000);
    }
  }

  setupBluetoothEvents() {
    noble.on('stateChange', (state) => {
      this.log(`📡 Bluetooth state: ${state}`);
      if (state === 'poweredOn') {
        this.bluetoothReady = true;
        this.log('✅ Bluetooth ready');
      } else {
        this.bluetoothReady = false;
        this.forceDisconnect();
      }
    });
  }

  getServices() {
    return [this.switchService, this.batteryService];
  }

  getOn(callback) {
    callback(null, false);
  }

  setOn(value, callback) {
    if (value) {
      this.log('🔴 Switch activated - executing fingerbot press...');
      this.pressFingerbotPython()
        .then(() => {
          callback(null);
          setTimeout(() => {
            this.switchService.updateCharacteristic(Characteristic.On, false);
          }, 1000);
        })
        .catch(error => {
          this.log(`❌ Press failed: ${error.message}`);
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

  nextSnAck() {
    this.snAck += 1;
    return this.snAck;
  }

  resetSnAck() {
    this.snAck = 0;
  }

  async testPythonProtocol() {
    if (this.operationInProgress) {
      this.log('⚠️ Test already in progress');
      return;
    }

    try {
      this.operationInProgress = true;
      this.log('🐍 Testing Python-based Tuya BLE protocol...');
      
      const connectionInfo = await this.scanAndConnect();
      await this.performPythonProtocolSequence(connectionInfo);
      
      this.log('✅ Python protocol test completed');
      
    } catch (error) {
      this.log(`❌ Python protocol test failed: ${error.message}`);
    } finally {
      this.operationInProgress = false;
      this.forceDisconnect();
    }
  }

  async pressFingerbotPython() {
    if (this.operationInProgress) {
      this.log('⚠️ Operation in progress');
      return;
    }

    try {
      this.operationInProgress = true;
      this.log('🤖 Executing fingerbot press via Python protocol...');
      
      const connectionInfo = await this.scanAndConnect();
      await this.performPythonProtocolSequence(connectionInfo, true);
      
      this.log('✅ Fingerbot press completed');
      
    } catch (error) {
      this.log(`❌ Fingerbot press failed: ${error.message}`);
      throw error;
    } finally {
      this.operationInProgress = false;
      this.forceDisconnect();
    }
  }

  async performPythonProtocolSequence(connectionInfo, executePress = false) {
    const { peripheral, writeChar, notifyChar } = connectionInfo;
    
    return new Promise(async (resolve, reject) => {
      let sequenceStep = 'device_info';
      let sequenceTimeout = null;
      let pressSent = false;
      
      this.bleReceiver.reset();
      this.resetSnAck();
      
      // Setup notification handler (like Python handle_notification)
      const notificationHandler = (data) => {
        this.log(`📥 RX: ${data.toString('hex')}`);
        
        const result = this.bleReceiver.parseDataReceived(data);
        if (!result) {
          return; // Incomplete packet
        }
        
        this.log(`📋 Response: code=${result.code}, step=${sequenceStep}`);
        
        if (sequenceStep === 'device_info' && result.code === Coder.FUN_SENDER_DEVICE_INFO) {
          // Device info response - like Python code
          if (result.resp && result.resp.success) {
            this.log(`✅ Device info: version=${result.resp.device_version}, protocol=${result.resp.protocol_version}`);
            this.secretKeyManager.setSrand(result.resp.srand);
            
            // Send pair request
            sequenceStep = 'pairing';
            this.log('📤 Sending pair request...');
            setTimeout(() => this.sendPairRequest(writeChar), 200);
          } else {
            reject(new Error('Device info request failed'));
          }
        } else if (sequenceStep === 'pairing' && result.code === Coder.FUN_SENDER_PAIR) {
          // Pairing response - like Python code
          this.log(`✅ Pairing successful`);
          
          if (executePress && !pressSent) {
            // Send fingerbot press (like Python send_dps)
            sequenceStep = 'fingerbot_press';
            pressSent = true;
            this.log('📤 Sending fingerbot press...');
            setTimeout(() => this.sendFingerbotDps(writeChar), 200);
          } else {
            // Just complete the test
            clearTimeout(sequenceTimeout);
            resolve();
          }
        } else if (sequenceStep === 'fingerbot_press' && result.code === Coder.FUN_SENDER_DPS) {
          // DP response
          this.log(`✅ Fingerbot press command acknowledged`);
          clearTimeout(sequenceTimeout);
          setTimeout(() => resolve(), 1000);
        }
      };

      try {
        // Subscribe to notifications
        await this.setupNotifications(notifyChar, notificationHandler);
        
        // Start sequence with device info request (like Python)
        this.log('📤 Sending device info request...');
        this.sendDeviceInfoRequest(writeChar);
        
        // Set overall timeout
        sequenceTimeout = setTimeout(() => {
          this.log(`⏰ Python protocol timeout at step: ${sequenceStep}`);
          reject(new Error(`Python protocol timeout at ${sequenceStep}`));
        }, 30000);
        
      } catch (error) {
        reject(error);
      }
    });
  }

  // Device info request (like Python)
  sendDeviceInfoRequest(writeChar) {
    const inp = Buffer.alloc(0);
    const iv = TuyaDataPacket.getRandomIv();
    const securityFlag = 4;
    const secretKey = this.secretKeyManager.get(securityFlag);
    const snAck = this.nextSnAck();
    
    const request = new XRequest(snAck, 0, Coder.FUN_SENDER_DEVICE_INFO, securityFlag, secretKey, iv, inp);
    this.sendRequest(writeChar, request);
  }

  // Pair request (like Python)
  sendPairRequest(writeChar) {
    const securityFlag = 5;
    const secretKey = this.secretKeyManager.get(securityFlag);
    const iv = TuyaDataPacket.getRandomIv();
    
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
    const request = new XRequest(snAck, 0, Coder.FUN_SENDER_PAIR, securityFlag, secretKey, iv, inp);
    
    this.sendRequest(writeChar, request);
  }

  // Send DPs (exactly like Python send_dps)
  sendFingerbotDps(writeChar) {
    const securityFlag = 5;
    const secretKey = this.secretKeyManager.get(securityFlag);
    const iv = TuyaDataPacket.getRandomIv();
    
    // Exact DPs from working Python code
    const dps = [
      [DpAction.MODE, DpType.ENUM, 0],                    // Mode = click
      [DpAction.ARM_DOWN_PERCENT, DpType.INT, 80],        // Down 80%
      [DpAction.ARM_UP_PERCENT, DpType.INT, 0],           // Up 0%
      [DpAction.CLICK_SUSTAIN_TIME, DpType.INT, 0],       // Sustain 0s
      [DpAction.CLICK, DpType.BOOLEAN, true],             // Trigger click
    ];
    
    let raw = Buffer.alloc(0);
    
    for (const dp of dps) {
      const [dpId, dpType, dpValue] = dp;
      
      // DP header: [DP_ID][DP_TYPE]
      const header = Buffer.alloc(2);
      header.writeUInt8(dpId, 0);
      header.writeUInt8(dpType, 1);
      
      let valueBuffer;
      
      if (dpType === DpType.BOOLEAN) {
        const length = 1;
        const val = dpValue ? 1 : 0;
        valueBuffer = Buffer.alloc(2);
        valueBuffer.writeUInt8(length, 0);
        valueBuffer.writeUInt8(val, 1);
      } else if (dpType === DpType.INT) {
        const length = 4;
        valueBuffer = Buffer.alloc(5);
        valueBuffer.writeUInt8(length, 0);
        valueBuffer.writeUInt32BE(dpValue, 1);
      } else if (dpType === DpType.ENUM) {
        const length = 1;
        valueBuffer = Buffer.alloc(2);
        valueBuffer.writeUInt8(length, 0);
        valueBuffer.writeUInt8(dpValue, 1);
      } else {
        continue;
      }
      
      raw = Buffer.concat([raw, header, valueBuffer]);
    }
    
    this.log(`📦 DP payload: ${raw.toString('hex')}`);
    
    const snAck = this.nextSnAck();
    const request = new XRequest(snAck, 0, Coder.FUN_SENDER_DPS, securityFlag, secretKey, iv, raw);
    
    this.sendRequest(writeChar, request);
  }

  sendRequest(writeChar, xRequest) {
    const packets = xRequest.pack();
    
    for (const packet of packets) {
      this.log(`📤 TX: ${packet.toString('hex')}`);
      this.writeCharacteristic(writeChar, packet);
    }
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

  async writeCharacteristic(characteristic, data) {
    return new Promise((resolve, reject) => {
      characteristic.write(data, false, (error) => {
        if (error) {
          this.log(`❌ Write error: ${error.message}`);
          reject(error);
        } else {
          setTimeout(() => resolve(), 20);
        }
      });
    });
  }

  async scanAndConnect() {
    return new Promise((resolve, reject) => {
      this.forceDisconnect();
      
      const discoverHandler = async (peripheral) => {
        if (peripheral.address === this.address) {
          this.log(`📡 Found device: ${peripheral.address} (RSSI: ${peripheral.rssi})`);
          
          noble.stopScanning();
          noble.removeListener('discover', discoverHandler);

          try {
            const connectionInfo = await this.connectToPeripheral(peripheral);
            resolve(connectionInfo);
          } catch (error) {
            reject(error);
          }
        }
      };

      noble.on('discover', discoverHandler);
      this.log('🔍 Scanning for device...');
      noble.startScanning([], true);

      setTimeout(() => {
        noble.stopScanning();
        noble.removeListener('discover', discoverHandler);
        reject(new Error('Device not found'));
      }, 15000);
    });
  }

  async connectToPeripheral(peripheral) {
    return new Promise((resolve, reject) => {
      this.currentPeripheral = peripheral;
      
      peripheral.connect((error) => {
        if (error) {
          return reject(error);
        }

        this.log('✅ Connected, discovering services...');
        
        peripheral.discoverAllServicesAndCharacteristics((error, services, characteristics) => {
          if (error) {
            return reject(error);
          }

          // Find Tuya BLE characteristics (from Python NOTIF_UUID and CHAR_UUID)
          const writeChar = characteristics.find(char => 
            char.uuid.toLowerCase() === '00002b11-0000-1000-8000-00805f9b34fb'
          );
          const notifyChar = characteristics.find(char => 
            char.uuid.toLowerCase() === '00002b10-0000-1000-8000-00805f9b34fb'
          );

          if (!writeChar || !notifyChar) {
            return reject(new Error('Required Tuya BLE characteristics not found'));
          }

          this.log('✅ Found Tuya BLE characteristics');
          resolve({ peripheral, writeChar, notifyChar });
        });
      });
    });
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  forceDisconnect() {
    try {
      if (noble.state === 'poweredOn') {
        noble.stopScanning();
      }
      noble.removeAllListeners('discover');
    } catch (error) {
      // Ignore cleanup errors
    }
    
    if (this.currentPeripheral) {
      try {
        if (this.currentPeripheral.state === 'connected') {
          this.currentPeripheral.disconnect();
        }
        this.currentPeripheral.removeAllListeners();
      } catch (error) {
        // Ignore cleanup errors
      }
      this.currentPeripheral = null;
    }
    
    this.operationInProgress = false;
    this.isConnected = false;
  }
}