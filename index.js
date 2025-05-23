const noble = require('@abandonware/noble');
const crypto = require('crypto');

let Service, Characteristic;

module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory('homebridge-moes-fingerbot-test', 'MoesFingerbotTest', MoesFingerbotTestAccessory);
};

// Simplified CRC16 utility
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

// Simplified Tuya BLE packet builder based on working implementations
class TuyaBLEPacket {
  static createPacket(seqNo, cmd, data) {
    // Create basic packet structure: [SeqNo][Cmd][Length][Data][CRC]
    const length = data.length;
    const packet = Buffer.alloc(4 + length + 2);
    
    packet.writeUInt8(seqNo, 0);
    packet.writeUInt8(cmd, 1);
    packet.writeUInt16BE(length, 2);
    data.copy(packet, 4);
    
    // Calculate CRC for everything except the CRC itself
    const crc = CrcUtils.crc16(packet.slice(0, 4 + length));
    packet.writeUInt16BE(crc, 4 + length);
    
    return packet;
  }

  static encryptData(key, iv, data) {
    // Pad to 16-byte boundary
    while (data.length % 16 !== 0) {
      data = Buffer.concat([data, Buffer.from([0x00])]);
    }

    const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
    cipher.setAutoPadding(false);
    return cipher.update(data);
  }

  static decryptData(key, encryptedData) {
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
    decipher.setAutoPadding(false);
    return decipher.update(encryptedData);
  }
}

// Simplified response parser
class ResponseParser {
  constructor(accessory) {
    this.accessory = accessory;
    this.buffer = Buffer.alloc(0);
  }

  reset() {
    this.buffer = Buffer.alloc(0);
  }

  addData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    this.accessory.log(`📥 Raw RX: ${data.toString('hex')}`);
    this.accessory.log(`📥 Total buffer: ${this.buffer.toString('hex')}`);
    
    // Try to parse complete packets
    return this.parsePackets();
  }

  parsePackets() {
    const results = [];
    
    while (this.buffer.length >= 6) { // Minimum packet size
      try {
        const seqNo = this.buffer.readUInt8(0);
        const cmd = this.buffer.readUInt8(1);
        const length = this.buffer.readUInt16BE(2);
        
        this.accessory.log(`📋 Parsing: seqNo=${seqNo}, cmd=${cmd}, length=${length}`);
        
        if (this.buffer.length < 4 + length + 2) {
          this.accessory.log(`📋 Incomplete packet: need ${4 + length + 2}, have ${this.buffer.length}`);
          break; // Wait for more data
        }
        
        const payload = this.buffer.slice(4, 4 + length);
        const receivedCrc = this.buffer.readUInt16BE(4 + length);
        
        // Verify CRC
        const calculatedCrc = CrcUtils.crc16(this.buffer.slice(0, 4 + length));
        if (receivedCrc !== calculatedCrc) {
          this.accessory.log(`❌ CRC mismatch: received=${receivedCrc}, calculated=${calculatedCrc}`);
          this.buffer = this.buffer.slice(1); // Skip one byte and try again
          continue;
        }
        
        this.accessory.log(`✅ Valid packet: seqNo=${seqNo}, cmd=${cmd}, payload=${payload.toString('hex')}`);
        
        results.push({
          seqNo,
          cmd,
          payload
        });
        
        // Remove processed packet from buffer
        this.buffer = this.buffer.slice(4 + length + 2);
        
      } catch (error) {
        this.accessory.log(`❌ Parse error: ${error.message}`);
        this.buffer = this.buffer.slice(1); // Skip one byte and try again
      }
    }
    
    return results;
  }
}

class MoesFingerbotTestAccessory {
  constructor(log, config) {
    this.log = log;
    this.name = config.name || 'MOES Fingerbot Test';
    this.address = config.address ? config.address.toLowerCase() : null;
    
    // Required Tuya BLE credentials
    this.deviceId = config.deviceId;
    this.localKey = config.localKey;
    
    this.log(`🔧 Test Configuration: deviceId=${this.deviceId}, address=${this.address}, localKey=${this.localKey ? `${this.localKey.length} chars` : 'MISSING'}`);
    
    if (!this.deviceId || !this.localKey || !this.address) {
      this.log('❌ ERROR: deviceId, localKey, and address are all required');
      throw new Error('Missing required configuration');
    }

    // Simplified key generation based on working implementations
    this.generateKeys();
    
    // Device state
    this.batteryLevel = -1;
    this.isConnected = false;
    this.currentPeripheral = null;
    this.bluetoothReady = false;
    this.operationInProgress = false;
    this.seqNo = 0;
    
    this.responseParser = new ResponseParser(this);
    
    // Setup HomeKit services
    this.batteryService = new Service.BatteryService(this.name);
    this.batteryService
      .getCharacteristic(Characteristic.BatteryLevel)
      .on('get', this.getBatteryLevel.bind(this));

    // Setup Bluetooth
    this.setupBluetoothEvents();
    
    // Auto-test on startup if Bluetooth is ready
    if (noble.state === 'poweredOn') {
      this.bluetoothReady = true;
      setTimeout(() => {
        this.testBatteryRead();
      }, 2000);
    }
  }

  generateKeys() {
    // Simplified key generation based on working implementations
    this.loginKey = Buffer.from(this.localKey.slice(0, 6), 'utf8');
    this.log(`🔑 Login key: "${this.localKey.slice(0, 6)}" -> ${this.loginKey.toString('hex')}`);
    
    // Basic encryption key from local key
    this.encryptionKey = crypto.createHash('md5').update(Buffer.from(this.localKey, 'utf8')).digest();
    this.log(`🔐 Encryption key: ${this.encryptionKey.toString('hex')}`);
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
    return [this.batteryService];
  }

  getBatteryLevel(callback) {
    const level = this.batteryLevel >= 0 && this.batteryLevel <= 100 ? this.batteryLevel : 0;
    callback(null, level);
  }

  async testBatteryRead() {
    if (this.operationInProgress) {
      this.log('⚠️ Operation already in progress');
      return;
    }

    try {
      this.operationInProgress = true;
      this.log('🔋 Starting battery test...');
      
      const connectionInfo = await this.scanAndConnect();
      await this.performSimpleBatteryRead(connectionInfo);
      
      this.log('✅ Battery test completed');
      
    } catch (error) {
      this.log(`❌ Battery test failed: ${error.message}`);
    } finally {
      this.operationInProgress = false;
      this.forceDisconnect();
    }
  }

  async scanAndConnect() {
    return new Promise((resolve, reject) => {
      this.forceDisconnect();
      
      let scanTimeout = null;
      let found = false;

      const discoverHandler = async (peripheral) => {
        if (peripheral.address === this.address && !found) {
          found = true;
          this.log(`📡 Found device: ${peripheral.address} (RSSI: ${peripheral.rssi})`);
          
          clearTimeout(scanTimeout);
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

      scanTimeout = setTimeout(() => {
        this.log('⏰ Scan timeout');
        noble.stopScanning();
        noble.removeListener('discover', discoverHandler);
        reject(new Error('Device not found'));
      }, 15000);
    });
  }

  async connectToPeripheral(peripheral) {
    return new Promise((resolve, reject) => {
      this.currentPeripheral = peripheral;
      
      const connectTimeout = setTimeout(() => {
        this.log('⏰ Connection timeout');
        reject(new Error('Connection timeout'));
      }, 20000);

      this.log('🔌 Connecting...');
      peripheral.connect((error) => {
        clearTimeout(connectTimeout);
        
        if (error) {
          this.log(`❌ Connection error: ${error.message}`);
          return reject(error);
        }

        this.log('✅ Connected, discovering services...');
        
        peripheral.discoverAllServicesAndCharacteristics((error, services, characteristics) => {
          if (error) {
            this.log(`❌ Service discovery error: ${error.message}`);
            return reject(error);
          }

          this.log(`📋 Found ${characteristics.length} characteristics`);
          
          // Find Tuya BLE characteristics
          let writeChar = characteristics.find(char => {
            const uuid = char.uuid.toLowerCase();
            return uuid.includes('2b11') || uuid === '00002b11-0000-1000-8000-00805f9b34fb';
          });
          
          let notifyChar = characteristics.find(char => {
            const uuid = char.uuid.toLowerCase();
            return uuid.includes('2b10') || uuid === '00002b10-0000-1000-8000-00805f9b34fb';
          });

          this.log(`🔍 Write char: ${writeChar ? 'FOUND' : 'MISSING'}`);
          this.log(`🔍 Notify char: ${notifyChar ? 'FOUND' : 'MISSING'}`);

          if (!writeChar || !notifyChar) {
            return reject(new Error('Required BLE characteristics not found'));
          }

          resolve({ peripheral, writeChar, notifyChar });
        });
      });
    });
  }

  async performSimpleBatteryRead(connectionInfo) {
    const { peripheral, writeChar, notifyChar } = connectionInfo;
    
    return new Promise(async (resolve, reject) => {
      this.responseParser.reset();
      this.seqNo = 1;
      
      // Setup notifications
      const notificationHandler = (data) => {
        const packets = this.responseParser.addData(data);
        
        for (const packet of packets) {
          this.log(`📦 Received packet: cmd=${packet.cmd}, payload=${packet.payload.toString('hex')}`);
          
          if (packet.cmd === 0x02) { // Assume cmd 2 is status response
            this.parseBatteryFromPayload(packet.payload);
          }
          
          // For now, resolve after any response
          setTimeout(() => resolve(), 1000);
        }
      };

      try {
        // Enable notifications
        await this.setupNotifications(notifyChar, notificationHandler);
        
        // Send simple status request
        this.log('📤 Sending status request...');
        await this.sendStatusRequest(writeChar);
        
        // Timeout if no response
        setTimeout(() => {
          this.log('⏰ Response timeout');
          reject(new Error('No response received'));
        }, 10000);
        
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

  async sendStatusRequest(writeChar) {
    // Try multiple simple approaches
    const approaches = [
      { name: 'Raw status', data: Buffer.from([0x01, 0x02]) },
      { name: 'DP query', data: Buffer.from([0x01, 0x02, 0x00, 0x00]) },
      { name: 'Battery query', data: Buffer.from([0x06]) }, // DP6 is battery
    ];

    for (const approach of approaches) {
      this.log(`📤 Trying ${approach.name}: ${approach.data.toString('hex')}`);
      
      // Create packet
      const packet = TuyaBLEPacket.createPacket(this.seqNo++, 0x02, approach.data);
      this.log(`📤 TX packet: ${packet.toString('hex')}`);
      
      // Send packet (split if needed for MTU)
      await this.writeCharacteristic(writeChar, packet);
      
      // Wait between attempts
      await this.delay(2000);
    }
  }

  parseBatteryFromPayload(payload) {
    this.log(`📊 Parsing battery from: ${payload.toString('hex')}`);
    
    // Try simple approaches to find battery level
    for (let i = 0; i < payload.length; i++) {
      const value = payload.readUInt8(i);
      if (value >= 0 && value <= 100) {
        this.log(`🔋 Potential battery level at offset ${i}: ${value}%`);
        this.batteryLevel = value;
        this.batteryService.updateCharacteristic(Characteristic.BatteryLevel, value);
      }
    }
    
    // Try 16-bit values
    for (let i = 0; i < payload.length - 1; i++) {
      const value = payload.readUInt16BE(i);
      if (value >= 0 && value <= 100) {
        this.log(`🔋 Potential battery level (16-bit) at offset ${i}: ${value}%`);
        this.batteryLevel = value;
        this.batteryService.updateCharacteristic(Characteristic.BatteryLevel, value);
      }
    }
  }

  async writeCharacteristic(characteristic, data) {
    return new Promise((resolve, reject) => {
      // Split packet if larger than MTU (20 bytes)
      const mtu = 20;
      if (data.length <= mtu) {
        characteristic.write(data, false, (error) => {
          if (error) {
            this.log(`❌ Write error: ${error.message}`);
            reject(error);
          } else {
            resolve();
          }
        });
      } else {
        // Split into chunks
        let offset = 0;
        const writeNext = () => {
          const chunk = data.slice(offset, offset + mtu);
          characteristic.write(chunk, false, (error) => {
            if (error) {
              this.log(`❌ Write error: ${error.message}`);
              reject(error);
            } else {
              offset += mtu;
              if (offset < data.length) {
                setTimeout(writeNext, 50);
              } else {
                resolve();
              }
            }
          });
        };
        writeNext();
      }
    });
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  forceDisconnect() {
    this.log('🔌 Disconnecting...');
    
    try {
      if (noble.state === 'poweredOn') {
        noble.stopScanning();
      }
      noble.removeAllListeners('discover');
    } catch (error) {
      this.log(`Scan cleanup error: ${error.message}`);
    }
    
    if (this.currentPeripheral) {
      try {
        if (this.currentPeripheral.state === 'connected') {
          this.currentPeripheral.disconnect();
        }
        this.currentPeripheral.removeAllListeners();
      } catch (error) {
        this.log(`Disconnect error: ${error.message}`);
      }
      this.currentPeripheral = null;
    }
    
    this.operationInProgress = false;
    this.isConnected = false;
  }
}