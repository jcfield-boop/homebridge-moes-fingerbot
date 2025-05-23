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
    
    this.log(`🔧 Diagnostic Configuration: deviceId=${this.deviceId}, address=${this.address}`);
    
    if (!this.deviceId || !this.localKey || !this.address) {
      this.log('❌ ERROR: deviceId, localKey, and address are all required');
      throw new Error('Missing required configuration');
    }

    // Basic encryption setup
    this.loginKey = Buffer.from(this.localKey.slice(0, 6), 'utf8');
    this.log(`🔑 Login key: "${this.localKey.slice(0, 6)}" -> ${this.loginKey.toString('hex')}`);
    
    // Device state
    this.isOn = false;
    this.batteryLevel = -1;
    this.currentPeripheral = null;
    this.bluetoothReady = false;
    this.operationInProgress = false;
    this.discoveredChars = [];
    
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
    
    // Auto-scan on startup
    if (noble.state === 'poweredOn') {
      this.bluetoothReady = true;
      this.log('Starting comprehensive device scan in 3 seconds...');
      setTimeout(() => {
        this.diagnosticScan();
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
      this.log('🔴 Switch activated - running diagnostic scan...');
      this.diagnosticScan()
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

  async diagnosticScan() {
    if (this.operationInProgress) {
      this.log('⚠️ Diagnostic already in progress');
      return;
    }

    try {
      this.operationInProgress = true;
      this.log('🔍 Starting comprehensive diagnostic scan...');
      
      const peripheral = await this.scanAndConnect();
      await this.performFullDiagnostic(peripheral);
      
      this.log('✅ Diagnostic scan completed');
      
    } catch (error) {
      this.log(`❌ Diagnostic scan failed: ${error.message}`);
    } finally {
      this.operationInProgress = false;
      this.forceDisconnect();
    }
  }

  async performFullDiagnostic(peripheral) {
    this.log('🔬 Performing full device diagnostic...');
    
    return new Promise((resolve, reject) => {
      peripheral.discoverAllServicesAndCharacteristics((error, services, characteristics) => {
        if (error) {
          return reject(error);
        }

        this.log(`📋 Device Discovery Results:`);
        this.log(`   Services found: ${services.length}`);
        this.log(`   Characteristics found: ${characteristics.length}`);
        
        // Log all services
        this.log(`\n📁 Services:`);
        services.forEach((service, index) => {
          this.log(`   ${index + 1}. UUID: ${service.uuid}`);
          this.log(`      Name: ${this.getServiceName(service.uuid)}`);
        });
        
        // Log all characteristics with detailed info
        this.log(`\n📄 Characteristics:`);
        characteristics.forEach((char, index) => {
          this.log(`   ${index + 1}. UUID: ${char.uuid}`);
          this.log(`      Short: ${this.getShortUUID(char.uuid)}`);
          this.log(`      Properties: ${char.properties.join(', ')}`);
          this.log(`      Service: ${char._serviceUuid || 'unknown'}`);
          this.log(`      Name: ${this.getCharacteristicName(char.uuid)}`);
        });
        
        // Store for testing
        this.discoveredChars = characteristics;
        
        // Try to identify potential Tuya characteristics
        this.identifyTuyaCharacteristics(characteristics);
        
        // Test communication on promising characteristics
        this.testCharacteristics(characteristics)
          .then(() => resolve())
          .catch(error => reject(error));
      });
    });
  }

  identifyTuyaCharacteristics(characteristics) {
    this.log(`\n🔍 Analyzing characteristics for Tuya BLE patterns...`);
    
    const potentialTuya = [];
    
    // Known Tuya UUID patterns
    const tuyaPatterns = [
      '2b10', '2b11',  // Standard Tuya BLE
      'fff0', 'fff1', 'fff2', 'fff3', 'fff4', 'fff5', // Common custom UUIDs
      '0001', '0002', '0003', // Simple patterns
      'fe95', // Xiaomi/Tuya pattern
    ];
    
    characteristics.forEach((char, index) => {
      const shortUuid = this.getShortUUID(char.uuid);
      const hasWrite = char.properties.includes('write') || char.properties.includes('writeWithoutResponse');
      const hasNotify = char.properties.includes('notify') || char.properties.includes('indicate');
      
      // Check for Tuya patterns
      const matchesPattern = tuyaPatterns.some(pattern => shortUuid.includes(pattern));
      
      // Check for write/notify pair (typical for BLE communication)
      if (hasWrite || hasNotify || matchesPattern) {
        potentialTuya.push({
          index: index + 1,
          uuid: char.uuid,
          shortUuid: shortUuid,
          properties: char.properties,
          hasWrite,
          hasNotify,
          matchesPattern,
          score: (hasWrite ? 2 : 0) + (hasNotify ? 2 : 0) + (matchesPattern ? 3 : 0)
        });
      }
    });
    
    // Sort by likelihood score
    potentialTuya.sort((a, b) => b.score - a.score);
    
    this.log(`\n🎯 Potential Tuya characteristics (sorted by likelihood):`);
    potentialTuya.forEach(char => {
      this.log(`   ${char.index}. ${char.shortUuid} (score: ${char.score})`);
      this.log(`      UUID: ${char.uuid}`);
      this.log(`      Properties: ${char.properties.join(', ')}`);
      this.log(`      Write: ${char.hasWrite}, Notify: ${char.hasNotify}, Pattern: ${char.matchesPattern}`);
    });
    
    return potentialTuya;
  }

  async testCharacteristics(characteristics) {
    this.log(`\n🧪 Testing communication on potential characteristics...`);
    
    // Find characteristics with write capability
    const writeChars = characteristics.filter(char => 
      char.properties.includes('write') || char.properties.includes('writeWithoutResponse')
    );
    
    // Find characteristics with notify capability  
    const notifyChars = characteristics.filter(char =>
      char.properties.includes('notify') || char.properties.includes('indicate')
    );
    
    this.log(`   Found ${writeChars.length} writable characteristics`);
    this.log(`   Found ${notifyChars.length} notifiable characteristics`);
    
    // Test basic communication patterns
    for (const writeChar of writeChars.slice(0, 3)) { // Test first 3 to avoid spam
      this.log(`\n📤 Testing write to ${this.getShortUUID(writeChar.uuid)}...`);
      await this.testBasicCommunication(writeChar, notifyChars);
    }
  }

  async testBasicCommunication(writeChar, notifyChars) {
    try {
      // Setup listeners on all notify characteristics
      const listeners = [];
      for (const notifyChar of notifyChars) {
        try {
          await this.setupNotificationListener(notifyChar);
          listeners.push(notifyChar);
        } catch (error) {
          this.log(`   ⚠️ Could not setup listener on ${this.getShortUUID(notifyChar.uuid)}: ${error.message}`);
        }
      }

      if (listeners.length > 0) {
        this.log(`   🔔 Setup listeners on ${listeners.length} characteristics`);
      }

      // Test different basic command patterns
      const testCommands = [
        { name: 'Ping', data: Buffer.from([0x01]) },
        { name: 'Status Request', data: Buffer.from([0x02]) },
        { name: 'Battery Request', data: Buffer.from([0x06]) },
        { name: 'Device Info', data: Buffer.from([0x00]) },
        { name: 'Simple DP', data: Buffer.from([0x01, 0x02, 0x01, 0x01]) }, // Basic DP format
      ];

      for (const cmd of testCommands) {
        this.log(`   📤 Testing ${cmd.name}: ${cmd.data.toString('hex')}`);
        
        try {
          await this.writeCharacteristic(writeChar, cmd.data);
          await this.delay(1000); // Wait for potential response
        } catch (error) {
          this.log(`   ❌ ${cmd.name} failed: ${error.message}`);
        }
      }

    } catch (error) {
      this.log(`   ❌ Communication test failed: ${error.message}`);
    }
  }

  async setupNotificationListener(notifyChar) {
    return new Promise((resolve, reject) => {
      const shortUuid = this.getShortUUID(notifyChar.uuid);
      
      notifyChar.subscribe((error) => {
        if (error) {
          reject(error);
        } else {
          notifyChar.on('data', (data) => {
            this.log(`📥 Response from ${shortUuid}: ${data.toString('hex')}`);
            this.analyzeResponse(data, shortUuid);
          });
          resolve();
        }
      });
    });
  }

  analyzeResponse(data, sourceUuid) {
    this.log(`🔬 Analyzing response from ${sourceUuid}:`);
    this.log(`   Length: ${data.length} bytes`);
    this.log(`   Hex: ${data.toString('hex')}`);
    this.log(`   ASCII: ${this.toSafeAscii(data)}`);
    
    // Look for potential battery values
    for (let i = 0; i < data.length; i++) {
      const byte = data.readUInt8(i);
      if (byte >= 0 && byte <= 100) {
        this.log(`   🔋 Potential battery at offset ${i}: ${byte}%`);
      }
    }
    
    // Look for common patterns
    if (data.length >= 2) {
      this.log(`   First 2 bytes: ${data.readUInt16BE(0)} (BE), ${data.readUInt16LE(0)} (LE)`);
    }
    
    // Check for Tuya BLE packet patterns
    if (data.length > 10) {
      this.log(`   Could be Tuya packet - analyzing structure...`);
      // Look for packet header patterns
    }
  }

  toSafeAscii(buffer) {
    return buffer.toString('ascii').replace(/[^\x20-\x7E]/g, '.');
  }

  getShortUUID(uuid) {
    // Extract short UUID (e.g., "2b11" from full UUID)
    if (uuid.length > 8) {
      return uuid.slice(4, 8);
    }
    return uuid;
  }

  getServiceName(uuid) {
    const services = {
      '1800': 'Generic Access',
      '1801': 'Generic Attribute', 
      '180a': 'Device Information',
      '180f': 'Battery Service',
      'fff0': 'Custom Service (common)',
      'fe95': 'Xiaomi/Tuya Service'
    };
    
    const shortUuid = this.getShortUUID(uuid);
    return services[shortUuid] || 'Unknown';
  }

  getCharacteristicName(uuid) {
    const chars = {
      '2a00': 'Device Name',
      '2a01': 'Appearance',
      '2a19': 'Battery Level',
      '2b10': 'Tuya Notify',
      '2b11': 'Tuya Write',
      'fff1': 'Custom Characteristic 1',
      'fff2': 'Custom Characteristic 2',
      'fff3': 'Custom Characteristic 3',
      'fff4': 'Custom Characteristic 4'
    };
    
    const shortUuid = this.getShortUUID(uuid);
    return chars[shortUuid] || 'Unknown';
  }

  async writeCharacteristic(characteristic, data) {
    return new Promise((resolve, reject) => {
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
          this.log(`📡 Found target device: ${peripheral.address} (RSSI: ${peripheral.rssi})`);
          
          noble.stopScanning();
          noble.removeListener('discover', discoverHandler);

          peripheral.connect((error) => {
            if (error) {
              return reject(error);
            }
            
            this.currentPeripheral = peripheral;
            this.log('✅ Connected successfully');
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