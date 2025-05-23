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
    
    // Required credentials
    this.deviceId = config.deviceId;
    this.localKey = config.localKey;
    
    this.log(`🔧 Step-by-Step Diagnostic: deviceId=${this.deviceId}, address=${this.address}`);
    
    if (!this.deviceId || !this.localKey || !this.address) {
      this.log('❌ ERROR: deviceId, localKey, and address are all required');
      throw new Error('Missing required configuration');
    }

    // Initialize credentials exactly like Python
    this.uuid = Buffer.from(this.deviceId, 'utf8');
    this.devId = Buffer.from(this.deviceId, 'utf8');
    this.loginKey = Buffer.from(this.localKey.slice(0, 6), 'utf8');
    
    this.log(`🔑 Login key: "${this.localKey.slice(0, 6)}" -> ${this.loginKey.toString('hex')}`);
    
    // Test multiple key generation approaches
    this.testKeyGeneration();
    
    // Device state
    this.isOn = false;
    this.batteryLevel = -1;
    this.currentPeripheral = null;
    this.bluetoothReady = false;
    this.operationInProgress = false;
    this.responseCount = 0;
    
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
      this.log('Starting step-by-step communication diagnostic in 3 seconds...');
      setTimeout(() => {
        this.runStepByStepDiagnostic();
      }, 3000);
    }
  }

  testKeyGeneration() {
    this.log(`\n🔐 Testing different key generation approaches:`);
    
    // Approach 1: Python method (first 6 chars only)
    const key1 = Buffer.from(this.localKey.slice(0, 6), 'utf8');
    const secret1 = crypto.createHash('md5').update(key1).digest();
    this.log(`   1. Python method: "${this.localKey.slice(0, 6)}" -> ${secret1.toString('hex')}`);
    
    // Approach 2: Full local key
    const key2 = Buffer.from(this.localKey, 'utf8');
    const secret2 = crypto.createHash('md5').update(key2).digest();
    this.log(`   2. Full key method: "${this.localKey}" -> ${secret2.toString('hex')}`);
    
    // Approach 3: Hex interpretation
    try {
      const key3 = Buffer.from(this.localKey, 'hex');
      const secret3 = crypto.createHash('md5').update(key3).digest();
      this.log(`   3. Hex interpretation: ${key3.toString('hex')} -> ${secret3.toString('hex')}`);
    } catch (error) {
      this.log(`   3. Hex interpretation: FAILED (${error.message})`);
    }
    
    // Store different secrets for testing
    this.secretVariants = [secret1, secret2];
    this.currentSecretIndex = 0;
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
      this.log('🔴 Switch activated - running step-by-step diagnostic...');
      this.runStepByStepDiagnostic()
        .then(() => {
          callback(null);
          setTimeout(() => {
            this.switchService.updateCharacteristic(Characteristic.On, false);
          }, 1000);
        })
        .catch(error => {
          this.log(`❌ Diagnostic failed: ${error.message}`);
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

  async runStepByStepDiagnostic() {
    if (this.operationInProgress) {
      this.log('⚠️ Diagnostic already in progress');
      return;
    }

    try {
      this.operationInProgress = true;
      this.responseCount = 0;
      
      this.log('\n🧪 Starting comprehensive step-by-step diagnostic...');
      
      const { writeChar, notifyChar } = await this.connectAndSetupNotifications();
      
      // Step 1: Test device responsiveness with simple commands
      await this.testBasicResponsiveness(writeChar, notifyChar);
      
      // Step 2: Test different unencrypted approaches
      await this.testUnencryptedCommands(writeChar, notifyChar);
      
      // Step 3: Test different encryption keys
      await this.testDifferentEncryption(writeChar, notifyChar);
      
      // Step 4: Test protocol variations
      await this.testProtocolVariations(writeChar, notifyChar);
      
      this.log(`\n📊 Diagnostic Summary: Received ${this.responseCount} responses total`);
      this.log('✅ Step-by-step diagnostic completed');
      
    } catch (error) {
      this.log(`❌ Step-by-step diagnostic failed: ${error.message}`);
    } finally {
      this.operationInProgress = false;
      this.forceDisconnect();
    }
  }

  async connectAndSetupNotifications() {
    const peripheral = await this.scanAndConnect();
    
    return new Promise((resolve, reject) => {
      peripheral.discoverAllServicesAndCharacteristics((error, services, characteristics) => {
        if (error) {
          return reject(error);
        }

        const writeChar = characteristics.find(char => 
          char.uuid.toLowerCase().includes('2b11')
        );
        const notifyChar = characteristics.find(char => 
          char.uuid.toLowerCase().includes('2b10')
        );

        if (!writeChar || !notifyChar) {
          return reject(new Error('Required characteristics not found'));
        }

        this.log('✅ Found characteristics, setting up notifications...');
        
        // Setup comprehensive notification monitoring
        notifyChar.subscribe((error) => {
          if (error) {
            return reject(error);
          }
          
          notifyChar.on('data', (data) => {
            this.responseCount++;
            this.log(`📥 RX #${this.responseCount}: ${data.toString('hex')}`);
            this.analyzeResponse(data);
          });
          
          this.log('🔔 Notifications enabled - monitoring all responses');
          resolve({ writeChar, notifyChar });
        });
      });
    });
  }

  analyzeResponse(data) {
    this.log(`🔬 Analyzing response (${data.length} bytes):`);
    this.log(`   Hex: ${data.toString('hex')}`);
    this.log(`   ASCII: ${this.toSafeAscii(data)}`);
    
    // Check if it looks like encrypted Tuya data
    if (data.length > 17) {
      this.log(`   Potential encrypted packet (length=${data.length})`);
      
      // Try to decrypt with our secret keys
      for (let i = 0; i < this.secretVariants.length; i++) {
        try {
          const secret = this.secretVariants[i];
          const securityFlag = data[0];
          const iv = data.slice(1, 17);
          const encrypted = data.slice(17);
          
          const decipher = crypto.createDecipheriv('aes-128-cbc', secret, iv);
          const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
          
          this.log(`   ✅ Decryption attempt ${i + 1} SUCCESS!`);
          this.log(`   Decrypted: ${decrypted.toString('hex')}`);
          
          // Parse decrypted structure
          if (decrypted.length >= 12) {
            const sn = decrypted.readUInt32BE(0);
            const snAck = decrypted.readUInt32BE(4);
            const code = decrypted.readUInt16BE(8);
            const length = decrypted.readUInt16BE(10);
            
            this.log(`   Parsed: sn=${sn}, snAck=${snAck}, code=${code}, length=${length}`);
          }
          
          return; // Success - no need to try other keys
          
        } catch (error) {
          this.log(`   ❌ Decryption attempt ${i + 1} failed: ${error.message}`);
        }
      }
    }
    
    // Look for patterns
    if (data.length === 1) {
      this.log(`   Single byte response: 0x${data[0].toString(16).padStart(2, '0')}`);
    }
    
    // Check for common patterns
    const patterns = [0x00, 0x01, 0x02, 0x03, 0x04, 0x05];
    for (const pattern of patterns) {
      if (data[0] === pattern) {
        this.log(`   Matches pattern: 0x${pattern.toString(16).padStart(2, '0')}`);
      }
    }
  }

  async testBasicResponsiveness(writeChar, notifyChar) {
    this.log(`\n📋 Step 1: Testing basic device responsiveness...`);
    
    const basicCommands = [
      { name: 'Ping', data: Buffer.from([0x01]) },
      { name: 'Status', data: Buffer.from([0x02]) },
      { name: 'Hello', data: Buffer.from([0x00]) },
      { name: 'Battery', data: Buffer.from([0x06]) },
      { name: 'Wake', data: Buffer.from([0xFF]) },
      { name: 'Empty', data: Buffer.from([]) },
    ];

    for (const cmd of basicCommands) {
      this.log(`   📤 Testing ${cmd.name}: ${cmd.data.toString('hex')}`);
      
      try {
        await this.writeCharacteristic(writeChar, cmd.data);
        await this.delay(2000); // Wait for response
      } catch (error) {
        this.log(`   ❌ ${cmd.name} write failed: ${error.message}`);
      }
    }
  }

  async testUnencryptedCommands(writeChar, notifyChar) {
    this.log(`\n📋 Step 2: Testing unencrypted protocol variations...`);
    
    // Test different packet structures
    const unencryptedTests = [
      {
        name: 'Simple packet structure',
        data: Buffer.from([0x01, 0x00, 0x00, 0x00]) // SeqNo, Cmd, Length
      },
      {
        name: 'DP structure',
        data: Buffer.from([0x01, 0x02, 0x01, 0x01]) // DP1, Type Bool, Length, Value
      },
      {
        name: 'Tuya header',
        data: Buffer.from([0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]) // Basic Tuya structure
      },
      {
        name: 'Device ID query',
        data: Buffer.concat([Buffer.from([0x00]), Buffer.from(this.deviceId.slice(0, 8), 'utf8')])
      }
    ];

    for (const test of unencryptedTests) {
      this.log(`   📤 Testing ${test.name}: ${test.data.toString('hex')}`);
      
      try {
        await this.writeCharacteristic(writeChar, test.data);
        await this.delay(2000);
      } catch (error) {
        this.log(`   ❌ ${test.name} failed: ${error.message}`);
      }
    }
  }

  async testDifferentEncryption(writeChar, notifyChar) {
    this.log(`\n📋 Step 3: Testing different encryption approaches...`);
    
    for (let i = 0; i < this.secretVariants.length; i++) {
      const secret = this.secretVariants[i];
      this.log(`   🔐 Testing secret variant ${i + 1}: ${secret.toString('hex')}`);
      
      try {
        const testPacket = this.createSimpleEncryptedPacket(secret);
        this.log(`   📤 Encrypted test packet: ${testPacket.toString('hex')}`);
        
        await this.writeCharacteristic(writeChar, testPacket);
        await this.delay(3000); // Longer wait for encryption
        
      } catch (error) {
        this.log(`   ❌ Encryption test ${i + 1} failed: ${error.message}`);
      }
    }
  }

  async testProtocolVariations(writeChar, notifyChar) {
    this.log(`\n📋 Step 4: Testing protocol variations...`);
    
    // Test different approaches that might wake up the device
    const protocolTests = [
      {
        name: 'Auth request',
        data: Buffer.concat([
          Buffer.from([0x00, 0x00, 0x00, 0x01]), // SeqNo = 1
          Buffer.from([0x00, 0x00, 0x00, 0x00]), // AckSn = 0  
          Buffer.from([0x00, 0x00]), // Code = 0 (device info)
          Buffer.from([0x00, 0x00]), // Length = 0
        ])
      },
      {
        name: 'Login attempt',
        data: Buffer.concat([
          this.loginKey,
          Buffer.from([0x00, 0x00])
        ])
      },
      {
        name: 'Device ID handshake',
        data: Buffer.concat([
          Buffer.from([0x01]), // Some kind of init
          Buffer.from(this.deviceId.slice(0, 10), 'utf8')
        ])
      }
    ];

    for (const test of protocolTests) {
      this.log(`   📤 Testing ${test.name}: ${test.data.toString('hex')}`);
      
      try {
        await this.writeCharacteristic(writeChar, test.data);
        await this.delay(2000);
      } catch (error) {
        this.log(`   ❌ ${test.name} failed: ${error.message}`);
      }
    }
  }

  createSimpleEncryptedPacket(secretKey) {
    // Create a minimal encrypted packet for testing
    const iv = crypto.randomBytes(16);
    
    // Simple payload: SeqNo=1, AckSn=0, Code=0, Length=0
    let payload = Buffer.from([
      0x00, 0x00, 0x00, 0x01, // SeqNo
      0x00, 0x00, 0x00, 0x00, // AckSn
      0x00, 0x00,             // Code
      0x00, 0x00              // Length
    ]);
    
    // Pad to 16 bytes
    while (payload.length % 16 !== 0) {
      payload = Buffer.concat([payload, Buffer.from([0x00])]);
    }
    
    // Encrypt
    const cipher = crypto.createCipheriv('aes-128-cbc', secretKey, iv);
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    
    // Build final packet: SecurityFlag + IV + Encrypted
    return Buffer.concat([
      Buffer.from([0x04]), // Security flag 4
      iv,
      encrypted
    ]);
  }

  toSafeAscii(buffer) {
    return buffer.toString('ascii').replace(/[^\x20-\x7E]/g, '.');
  }

  async writeCharacteristic(characteristic, data) {
    return new Promise((resolve, reject) => {
      if (data.length === 0) {
        // Some devices don't like empty packets
        return resolve();
      }
      
      characteristic.write(data, false, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
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

          peripheral.connect((error) => {
            if (error) {
              return reject(error);
            }
            
            this.currentPeripheral = peripheral;
            this.log('✅ Connected to device');
            resolve(peripheral);
          });
        }
      };

      noble.on('discover', discoverHandler);
      this.log('🔍 Scanning for device...');
      noble.startScanning([], true);

      setTimeout(() => {
        noble.stopScanning();
        noble.removeListener('discover', discoverHandler);
        reject(new Error('Device not found during scan'));
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
  }
}