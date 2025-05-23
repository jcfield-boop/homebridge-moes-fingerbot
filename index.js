const noble = require('@abandonware/noble');
const crypto = require('crypto');

let Service, Characteristic;

module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory('homebridge-moes-fingerbot', 'MoesFingerbot', MoesFingerbotAccessory);
};

// Exact constants from Python
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

const DpAction = {
  ARM_DOWN_PERCENT: 9,
  ARM_UP_PERCENT: 15,
  CLICK_SUSTAIN_TIME: 10,
  TAP_ENABLE: 17,
  MODE: 8,
  INVERT_SWITCH: 11,
  TOGGLE_SWITCH: 2,
  CLICK: 101,
  PROG: 121
};

// FIXED: Exact CRC implementation from Python
class CrcUtils {
  static crc16(data) {
    let crc = 0xFFFF;
    for (const byte of data) {
      crc ^= byte & 255;  // Exact Python: byte & 255
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

// FIXED: Exact AES implementation from Python  
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

// FIXED: Exact packet preparation from Python
class TuyaDataPacket {
  static prepareCrc(snAck, ackSn, code, inp, inpLength) {
    // Exact Python struct: pack('>IIHH', sn_ack, ack_sn, code, inp_length)
    const raw = Buffer.alloc(12 + inp.length);
    raw.writeUInt32BE(snAck, 0);      // >I
    raw.writeUInt32BE(ackSn, 4);      // >I  
    raw.writeUInt16BE(code, 8);       // >H
    raw.writeUInt16BE(inpLength, 10); // >H
    inp.copy(raw, 12);
    
    const crc = CrcUtils.crc16(raw);
    const result = Buffer.alloc(raw.length + 2);
    raw.copy(result, 0);
    result.writeUInt16BE(crc, raw.length); // >H
    
    return result;
  }

  static getRandomIv() {
    return crypto.randomBytes(16);
  }

  static encryptPacket(secretKey, securityFlag, iv, data) {
    // Exact Python padding
    while (data.length % 16 !== 0) {
      data = Buffer.concat([data, Buffer.from([0x00])]);
    }

    const encryptedData = AesUtils.encrypt(data, iv, secretKey);
    
    // Exact Python structure: security_flag + iv + encrypted_data
    const output = Buffer.alloc(1 + 16 + encryptedData.length);
    let offset = 0;
    
    output.writeUInt8(securityFlag, offset); offset += 1;
    iv.copy(output, offset); offset += 16;
    encryptedData.copy(output, offset);
    
    return output;
  }
}

// FIXED: Exact packet splitting from Python
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

  // FIXED: Exact Python split_packet implementation
  splitPacket(protocolVersion, data) {
    const output = [];
    let packetNumber = 0;
    let pos = 0;
    const length = data.length;
    
    while (pos < length) {
      let packet = Buffer.alloc(0);
      
      // Add packet number (single byte)
      packet = Buffer.concat([packet, Buffer.from([packetNumber])]);
      
      if (packetNumber === 0) {
        // FIXED: Add length (single byte) - Python: pack('>B', length)
        packet = Buffer.concat([packet, Buffer.from([length])]);
        
        // FIXED: Add protocol version (LITTLE ENDIAN!) - Python: pack('<B', protocol_version << 4)
        const versionByte = Buffer.alloc(1);
        versionByte.writeUInt8(protocolVersion << 4, 0); // This is actually little endian for single byte
        packet = Buffer.concat([packet, versionByte]);
      }
      
      // Add data chunk
      const remainingMtu = this.gattMtu - packet.length;
      const dataChunk = data.slice(pos, pos + remainingMtu);
      packet = Buffer.concat([packet, dataChunk]);
      
      output.push(packet);
      
      pos += dataChunk.length;
      packetNumber += 1;
    }
    
    return output;
  }
}

// FIXED: Exact Python BleReceiver implementation  
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

  // FIXED: Exact Python unpack implementation
  unpack(arr) {
    let i = 0;
    let packetNumber = 0;
    
    // Parse packet number (variable length encoding)
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
      // Parse data length (variable length encoding)
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
      
      this.accessory.log(`🔓 Attempting decryption: security_flag=${securityFlag}, iv=${iv.toString('hex')}`);
      
      // Decrypt
      const decryptedData = AesUtils.decrypt(encryptedData, iv, secretKey);
      
      this.accessory.log(`🔓 Decrypted raw: ${decryptedData.toString('hex')}`);
      
      // FIXED: Validate CRC like Python
      if (decryptedData.length < 14) { // 12 bytes header + 2 bytes CRC
        throw new Error('Decrypted data too short');
      }
      
      const dataWithoutCrc = decryptedData.slice(0, -2);
      const receivedCrc = decryptedData.readUInt16BE(decryptedData.length - 2);
      const calculatedCrc = CrcUtils.crc16(dataWithoutCrc);
      
      if (receivedCrc !== calculatedCrc) {
        throw new Error(`CRC mismatch: received=${receivedCrc}, calculated=${calculatedCrc}`);
      }
      
      this.accessory.log(`✅ CRC validation passed`);
      
      // Parse decrypted data structure
      const sn = decryptedData.readUInt32BE(0);
      const snAck = decryptedData.readUInt32BE(4);
      const code = decryptedData.readUInt16BE(8);
      const length = decryptedData.readUInt16BE(10);
      const rawData = decryptedData.slice(12, 12 + length);
      
      this.accessory.log(`📋 Parsed: sn=${sn}, snAck=${snAck}, code=${code}, length=${length}`);
      
      let resp = null;
      
      if (code === Coder.FUN_SENDER_DEVICE_INFO) {
        resp = this.parseDeviceInfoResponse(rawData);
      } else if (code === Coder.FUN_SENDER_PAIR) {
        resp = { success: true };
      } else if (code === Coder.FUN_SENDER_DPS) {
        resp = this.parseDPResponse(rawData);
      }
      
      return {
        raw,
        version,
        securityFlag,
        code,
        sn,
        snAck,
        resp
      };
      
    } catch (error) {
      this.accessory.log(`❌ Response parsing failed: ${error.message}`);
      return null;
    }
  }

  parseDeviceInfoResponse(rawData) {
    this.accessory.log(`📱 Device info response: ${rawData.toString('hex')}`);
    
    if (rawData.length < 46) {
      this.accessory.log(`❌ Device info too short: ${rawData.length} bytes`);
      return { success: false };
    }
    
    try {
      // Exact Python parsing: unpack('>BBBBBB6sBB32s', raw[:46])
      const deviceVersionMajor = rawData.readUInt8(0);
      const deviceVersionMinor = rawData.readUInt8(1);
      const protocolVersionMajor = rawData.readUInt8(2);
      const protocolVersionMinor = rawData.readUInt8(3);
      const flag = rawData.readUInt8(4);
      const isBind = rawData.readUInt8(5);
      const srand = rawData.slice(6, 12); // 6 bytes
      const hardwareVersionMajor = rawData.readUInt8(12);
      const hardwareVersionMinor = rawData.readUInt8(13);
      const authKey = rawData.slice(14, 46); // 32 bytes
      
      const deviceVersion = `${deviceVersionMajor}.${deviceVersionMinor}`;
      const protocolVersion = `${protocolVersionMajor}.${protocolVersionMinor}`;
      
      this.accessory.log(`📱 Device: ${deviceVersion}, Protocol: ${protocolVersion}, Srand: ${srand.toString('hex')}`);
      
      const protocolNumber = protocolVersionMajor * 10 + protocolVersionMinor;
      if (protocolNumber < 20) {
        this.accessory.log(`❌ Protocol version too old: ${protocolNumber}`);
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
    this.accessory.log(`📦 DP Response: ${rawData.toString('hex')}`);
    return { dps: {} };
  }
}

// Secret Key Manager (exact Python implementation)
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

class MoesFingerbotAccessory {
  constructor(log, config) {
    this.log = log;
    this.name = config.name || 'MOES Fingerbot';
    this.address = config.address ? config.address.toLowerCase() : null;
    
    this.deviceId = config.deviceId;
    this.localKey = config.localKey;
    
    this.log(`🔧 Fixed Protocol: deviceId=${this.deviceId}, address=${this.address}`);
    
    if (!this.deviceId || !this.localKey || !this.address) {
      throw new Error('Missing required configuration');
    }

    // Exact Python initialization
    this.uuid = Buffer.from(this.deviceId, 'utf8');
    this.devId = Buffer.from(this.deviceId, 'utf8');  
    this.loginKey = Buffer.from(this.localKey.slice(0, 6), 'utf8');
    
    this.log(`🔑 Login key: "${this.localKey.slice(0, 6)}" -> ${this.loginKey.toString('hex')}`);
    
    this.secretKeyManager = new SecretKeyManager(this.loginKey);
    this.bleReceiver = new BleReceiver(this.secretKeyManager, this);
    
    // Device state
    this.isOn = false;
    this.batteryLevel = -1;
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

    this.setupBluetoothEvents();
    
    if (noble.state === 'poweredOn') {
      this.bluetoothReady = true;
      this.log('Starting FIXED protocol test in 3 seconds...');
      setTimeout(() => {
        this.testFixedProtocol();
      }, 3000);
    }
  }

  setupBluetoothEvents() {
    noble.on('stateChange', (state) => {
      this.log(`📡 Bluetooth state: ${state}`);
      if (state === 'poweredOn') {
        this.bluetoothReady = true;
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
      this.log('🔴 Testing fixed protocol...');
      this.testFixedProtocol()
        .then(() => {
          callback(null);
          setTimeout(() => {
            this.switchService.updateCharacteristic(Characteristic.On, false);
          }, 1000);
        })
        .catch(error => {
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

  async testFixedProtocol() {
    if (this.operationInProgress) {
      return;
    }

    try {
      this.operationInProgress = true;
      this.log('🔬 Testing FIXED protocol implementation...');
      
      const { writeChar, notifyChar } = await this.connectAndSetup();
      await this.runProtocolSequence(writeChar, notifyChar);
      
      this.log('✅ Fixed protocol test completed');
      
    } catch (error) {
      this.log(`❌ Fixed protocol test failed: ${error.message}`);
    } finally {
      this.operationInProgress = false;
      this.forceDisconnect();
    }
  }

  async connectAndSetup() {
    const peripheral = await this.scanAndConnect();
    
    return new Promise((resolve, reject) => {
      peripheral.discoverAllServicesAndCharacteristics((error, services, characteristics) => {
        if (error) return reject(error);

        const writeChar = characteristics.find(char => char.uuid.toLowerCase().includes('2b11'));
        const notifyChar = characteristics.find(char => char.uuid.toLowerCase().includes('2b10'));

        if (!writeChar || !notifyChar) {
          return reject(new Error('Characteristics not found'));
        }

        notifyChar.subscribe((error) => {
          if (error) return reject(error);
          
          notifyChar.on('data', (data) => {
            this.log(`📥 RX: ${data.toString('hex')}`);
            const result = this.bleReceiver.parseDataReceived(data);
            if (result) {
              this.log(`🎯 Parsed response: code=${result.code}, sn=${result.sn}`);
            }
          });
          
          this.log('🔔 Notifications enabled with FIXED receiver');
          resolve({ writeChar, notifyChar });
        });
      });
    });
  }

  async runProtocolSequence(writeChar, notifyChar) {
    this.bleReceiver.reset();
    this.resetSnAck();
    
    this.log('📤 Sending device info request with FIXED protocol...');
    
    // Send device info request
    const inp = Buffer.alloc(0);
    const iv = TuyaDataPacket.getRandomIv();
    const securityFlag = 4;
    const secretKey = this.secretKeyManager.get(securityFlag);
    const snAck = this.nextSnAck();
    
    const request = new XRequest(snAck, 0, Coder.FUN_SENDER_DEVICE_INFO, securityFlag, secretKey, iv, inp);
    this.sendRequest(writeChar, request);
    
    // Wait for response
    await this.delay(10000);
  }

  sendRequest(writeChar, xRequest) {
    const packets = xRequest.pack();
    this.log(`📦 Sending ${packets.length} packets`);
    
    for (let i = 0; i < packets.length; i++) {
      const packet = packets[i];
      this.log(`📤 TX[${i}]: ${packet.toString('hex')}`);
      this.writeCharacteristic(writeChar, packet);
    }
  }

  async writeCharacteristic(characteristic, data) {
    return new Promise((resolve, reject) => {
      characteristic.write(data, false, (error) => {
        if (error) {
          reject(error);
        } else {
          setTimeout(() => resolve(), 50);
        }
      });
    });
  }

  async scanAndConnect() {
    return new Promise((resolve, reject) => {
      this.forceDisconnect();
      
      const discoverHandler = async (peripheral) => {
        if (peripheral.address === this.address) {
          this.log(`📡 Found device: ${peripheral.address}`);
          
          noble.stopScanning();
          noble.removeListener('discover', discoverHandler);

          peripheral.connect((error) => {
            if (error) return reject(error);
            
            this.currentPeripheral = peripheral;
            this.log('✅ Connected with fixed protocol');
            resolve(peripheral);
          });
        }
      };

      noble.on('discover', discoverHandler);
      noble.startScanning([], true);

      setTimeout(() => {
        noble.stopScanning();
        noble.removeListener('discover', discoverHandler);
        reject(new Error('Device not found'));
      }, 15000);
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
    } catch (error) {}
    
    if (this.currentPeripheral) {
      try {
        if (this.currentPeripheral.state === 'connected') {
          this.currentPeripheral.disconnect();
        }
        this.currentPeripheral.removeAllListeners();
      } catch (error) {}
      this.currentPeripheral = null;
    }
    
    this.operationInProgress = false;
  }
}