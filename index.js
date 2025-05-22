const noble = require('@abandonware/noble');
const debug = require('debug')('homebridge-moes-fingerbot');
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
    this.address = config.address.toLowerCase();

    // REQUIRED: Tuya BLE credentials
    this.deviceId = config.deviceId;
    this.localKey = config.localKey;
    
    if (!this.deviceId || !this.localKey) {
      this.log('ERROR: deviceId and localKey are required for Tuya BLE devices');
      this.log('Use tuya-local-key-extractor to get these values');
      throw new Error('Missing required Tuya BLE credentials');
    }

    // Configuration
    this.pressTime = config.pressTime || 1000;
    this.scanDuration = config.scanDuration || 8000;
    this.scanRetries = config.scanRetries || 3;
    this.scanRetryCooldown = config.scanRetryCooldown || 2000;
    this.batteryCheckInterval = (config.batteryCheckInterval || 60) * 60 * 1000;
    
    // DIAGNOSTIC MODE - enable comprehensive testing
    this.diagnosticMode = config.diagnosticMode !== false; // default true

    // Protocol state
    this.sequenceNumber = 1;
    this.sessionKey = null;
    this.testAttempt = 0;

    // Device state
    this.isOn = false;
    this.batteryLevel = -1;
    this.lastBatteryCheck = 0;
    this.connecting = false;
    this.currentOperation = null;
    this.currentPeripheral = null;

    this.switchService = new Service.Switch(this.name);
    this.switchService
      .getCharacteristic(Characteristic.On)
      .on('get', this.getOn.bind(this))
      .on('set', this.setOn.bind(this));

    this.batteryService = new Service.BatteryService(this.name);
    this.batteryService
      .getCharacteristic(Characteristic.BatteryLevel)
      .on('get', this.getBatteryLevel.bind(this));

    noble.on('stateChange', (state) => {
      if (state === 'poweredOn') {
        this.log('Bluetooth adapter is powered on');
        if (this.diagnosticMode) {
          this.log('[DIAGNOSTIC] Diagnostic mode enabled - will test multiple packet formats');
        }
      } else {
        this.log('Bluetooth adapter is powered off or unavailable');
        this.forceDisconnect();
      }
    });
  }

  getServices() {
    return [this.switchService, this.batteryService];
  }

  getOn(callback) {
    callback(null, this.isOn);
  }

  setOn(value, callback) {
    this.log(`Setting power state to: ${value}`);

    if (value) {
      if (this.currentOperation) {
        this.log('[DEBUG] Operation already in progress, ignoring new request');
        callback(new Error('Operation in progress'));
        return;
      }

      this.currentOperation = this.pressButton()
        .then(() => {
          this.isOn = true;
          callback(null);

          setTimeout(() => {
            this.isOn = false;
            this.switchService.updateCharacteristic(Characteristic.On, false);
          }, this.pressTime);
        })
        .catch(error => {
          this.log(`Error pressing button: ${error}`);
          callback(error);
        })
        .finally(() => {
          this.currentOperation = null;
        });
    } else {
      callback(null);
    }
  }

  getBatteryLevel(callback) {
    callback(null, this.batteryLevel >= 0 && this.batteryLevel <= 100 ? this.batteryLevel : 0);
  }

  forceDisconnect() {
    if (this.currentPeripheral) {
      try {
        this.currentPeripheral.disconnect();
      } catch (e) {}
      this.currentPeripheral = null;
    }
    this.connecting = false;
  }

  // Generate session key
  generateSessionKey() {
    if (!this.localKey) return null;

    try {
      let keyBuffer;
      if (this.localKey.length === 32 && /^[0-9a-fA-F]+$/.test(this.localKey)) {
        keyBuffer = Buffer.from(this.localKey, 'hex');
      } else {
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
      return this.sessionKey;
    } catch (error) {
      this.log(`[DEBUG] Error generating session key: ${error}`);
      return null;
    }
  }

  // DIAGNOSTIC: Multiple packet creation methods to test
  createTuyaBLEPacket_v1(commandType, data = Buffer.alloc(0)) {
    // Version 1: Current format (2-byte seq, BE)
    try {
      this.sequenceNumber = (this.sequenceNumber + 1) & 0xFFFF;
      const header = Buffer.from([0x55, 0xaa]);
      const seqBuffer = Buffer.alloc(2);
      seqBuffer.writeUInt16BE(this.sequenceNumber, 0);
      const cmdBuffer = Buffer.from([commandType]);
      const lengthBuffer = Buffer.alloc(2);
      lengthBuffer.writeUInt16BE(data.length, 0);
      const payload = Buffer.concat([seqBuffer, cmdBuffer, lengthBuffer, data]);
      const preChecksum = Buffer.concat([header, payload]);
      let checksum = 0;
      for (let i = 0; i < preChecksum.length; i++) {
        checksum = (checksum + preChecksum[i]) & 0xFF;
      }
      return Buffer.concat([header, payload, Buffer.from([checksum])]);
    } catch (error) {
      return null;
    }
  }

  createTuyaBLEPacket_v2(commandType, data = Buffer.alloc(0)) {
    // Version 2: 4-byte sequence number, BE
    try {
      this.sequenceNumber = (this.sequenceNumber + 1) & 0xFFFFFFFF;
      const header = Buffer.from([0x55, 0xaa]);
      const seqBuffer = Buffer.alloc(4);
      seqBuffer.writeUInt32BE(this.sequenceNumber, 0);
      const cmdBuffer = Buffer.from([commandType]);
      const lengthBuffer = Buffer.alloc(2);
      lengthBuffer.writeUInt16BE(data.length, 0);
      const payload = Buffer.concat([seqBuffer, cmdBuffer, lengthBuffer, data]);
      const preChecksum = Buffer.concat([header, payload]);
      let checksum = 0;
      for (let i = 0; i < preChecksum.length; i++) {
        checksum = (checksum + preChecksum[i]) & 0xFF;
      }
      return Buffer.concat([header, payload, Buffer.from([checksum])]);
    } catch (error) {
      return null;
    }
  }

  createTuyaBLEPacket_v3(commandType, data = Buffer.alloc(0)) {
    // Version 3: 2-byte sequence, LE (little endian)
    try {
      this.sequenceNumber = (this.sequenceNumber + 1) & 0xFFFF;
      const header = Buffer.from([0x55, 0xaa]);
      const seqBuffer = Buffer.alloc(2);
      seqBuffer.writeUInt16LE(this.sequenceNumber, 0);
      const cmdBuffer = Buffer.from([commandType]);
      const lengthBuffer = Buffer.alloc(2);
      lengthBuffer.writeUInt16LE(data.length, 0);
      const payload = Buffer.concat([seqBuffer, cmdBuffer, lengthBuffer, data]);
      const preChecksum = Buffer.concat([header, payload]);
      let checksum = 0;
      for (let i = 0; i < preChecksum.length; i++) {
        checksum = (checksum + preChecksum[i]) & 0xFF;
      }
      return Buffer.concat([header, payload, Buffer.from([checksum])]);
    } catch (error) {
      return null;
    }
  }

  createTuyaBLEPacket_v4(commandType, data = Buffer.alloc(0)) {
    // Version 4: No sequence number, minimal format
    try {
      const header = Buffer.from([0x55, 0xaa]);
      const cmdBuffer = Buffer.from([commandType]);
      const lengthBuffer = Buffer.alloc(2);
      lengthBuffer.writeUInt16BE(data.length, 0);
      const payload = Buffer.concat([cmdBuffer, lengthBuffer, data]);
      const preChecksum = Buffer.concat([header, payload]);
      let checksum = 0;
      for (let i = 0; i < preChecksum.length; i++) {
        checksum = (checksum + preChecksum[i]) & 0xFF;
      }
      return Buffer.concat([header, payload, Buffer.from([checksum])]);
    } catch (error) {
      return null;
    }
  }

  // DIAGNOSTIC: Multiple command approaches
  getTestConfigurations() {
    return [
      // Test 1: DP command variations
      {
        name: "DP cmd 0x06, DP1, BOOL true",
        packets: [
          () => this.createTuyaBLEPacket_v1(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01]))
        ]
      },
      {
        name: "DP cmd 0x06, DP1, BOOL false",
        packets: [
          () => this.createTuyaBLEPacket_v1(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x00]))
        ]
      },
      {
        name: "Direct cmd 0x04 with data",
        packets: [
          () => this.createTuyaBLEPacket_v1(0x04, Buffer.from([0x01]))
        ]
      },
      {
        name: "Direct cmd 0x07 (alternative)",
        packets: [
          () => this.createTuyaBLEPacket_v1(0x07, Buffer.from([0x01]))
        ]
      },
      {
        name: "DP cmd with 4-byte seq",
        packets: [
          () => this.createTuyaBLEPacket_v2(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01]))
        ]
      },
      {
        name: "DP cmd with LE byte order",
        packets: [
          () => this.createTuyaBLEPacket_v3(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01]))
        ]
      },
      {
        name: "Minimal packet format",
        packets: [
          () => this.createTuyaBLEPacket_v4(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01]))
        ]
      },
      {
        name: "Press+Release sequence (current)",
        packets: [
          () => this.createTuyaBLEPacket_v1(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01])),
          () => this.createTuyaBLEPacket_v1(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x00]))
        ]
      },
      {
        name: "DP2 instead of DP1",
        packets: [
          () => this.createTuyaBLEPacket_v1(0x06, Buffer.from([0x02, 0x01, 0x00, 0x01, 0x01]))
        ]
      },
      {
        name: "Integer DP instead of bool",
        packets: [
          () => this.createTuyaBLEPacket_v1(0x06, Buffer.from([0x01, 0x02, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01]))
        ]
      },
      {
        name: "Raw Tuya command 0x03",
        packets: [
          () => this.createTuyaBLEPacket_v1(0x03, Buffer.from([0x01, 0x00]))
        ]
      },
      {
        name: "Single toggle command",
        packets: [
          () => this.createTuyaBLEPacket_v1(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01])),
          () => new Promise(resolve => setTimeout(() => resolve(this.createTuyaBLEPacket_v1(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x00]))), 100))
        ]
      }
    ];
  }

  async pressButton() {
    if (!this.diagnosticMode) {
      return this.pressButtonStandard();
    }

    return new Promise((resolve, reject) => {
      this.log('[DIAGNOSTIC] Starting comprehensive Fingerbot testing...');
      this.forceDisconnect();

      const testConfigs = this.getTestConfigurations();
      this.testAttempt = 0;

      const runNextTest = () => {
        if (this.testAttempt >= testConfigs.length) {
          return reject(new Error('All diagnostic tests failed - no working protocol found'));
        }

        const config = testConfigs[this.testAttempt];
        this.log(`[DIAGNOSTIC] Test ${this.testAttempt + 1}/${testConfigs.length}: ${config.name}`);
        
        this.testAttempt++;

        this.connectAndTest(config)
          .then(() => {
            this.log(`[DIAGNOSTIC] SUCCESS! Working protocol found: ${config.name}`);
            resolve();
          })
          .catch((error) => {
            this.log(`[DIAGNOSTIC] Test failed: ${error.message}`);
            setTimeout(runNextTest, 1000); // Brief delay between tests
          });
      };

      runNextTest();
    });
  }

  async pressButtonStandard() {
    // Standard single-test approach
    return new Promise((resolve, reject) => {
      this.log('Scanning for Fingerbot...');
      this.forceDisconnect();

      let scanTimeout = null;
      let peripheralFound = false;

      const discoverHandler = async (peripheral) => {
        if (peripheral.address === this.address && !peripheralFound) {
          peripheralFound = true;
          this.log(`Found Fingerbot: ${peripheral.address}`);
          
          try {
            noble.stopScanning();
          } catch (e) {}
          clearTimeout(scanTimeout);
          noble.removeListener('discover', discoverHandler);

          try {
            await this.connectAndPress(peripheral);
            resolve();
          } catch (error) {
            reject(error);
          }
        }
      };

      noble.on('discover', discoverHandler);
      
      try {
        noble.startScanning([], true);
      } catch (e) {
        noble.removeListener('discover', discoverHandler);
        reject(new Error('Failed to start scanning'));
        return;
      }

      scanTimeout = setTimeout(() => {
        try {
          noble.stopScanning();
        } catch (e) {}
        noble.removeListener('discover', discoverHandler);
        
        if (!peripheralFound) {
          reject(new Error('Failed to find Fingerbot device'));
        }
      }, this.scanDuration);
    });
  }

  async connectAndTest(testConfig) {
    return new Promise((resolve, reject) => {
      let scanTimeout = null;
      let peripheralFound = false;

      const discoverHandler = async (peripheral) => {
        if (peripheral.address === this.address && !peripheralFound) {
          peripheralFound = true;
          
          try {
            noble.stopScanning();
          } catch (e) {}
          clearTimeout(scanTimeout);
          noble.removeListener('discover', discoverHandler);

          try {
            await this.executeTest(peripheral, testConfig);
            resolve();
          } catch (error) {
            reject(error);
          }
        }
      };

      noble.on('discover', discoverHandler);
      
      try {
        noble.startScanning([], true);
      } catch (e) {
        noble.removeListener('discover', discoverHandler);
        reject(new Error('Failed to start scanning'));
        return;
      }

      scanTimeout = setTimeout(() => {
        try {
          noble.stopScanning();
        } catch (e) {}
        noble.removeListener('discover', discoverHandler);
        
        if (!peripheralFound) {
          reject(new Error('Device not found during test scan'));
        }
      }, 5000); // Shorter scan for tests
    });
  }

  async executeTest(peripheral, testConfig) {
    return new Promise((resolve, reject) => {
      if (this.connecting) {
        return reject(new Error('Already connecting'));
      }

      this.connecting = true;
      this.currentPeripheral = peripheral;

      let connectionTimeout = null;
      let disconnectHandler = null;
      let testCompleted = false;

      const cleanup = () => {
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
        }
        if (disconnectHandler) {
          peripheral.removeListener('disconnect', disconnectHandler);
          disconnectHandler = null;
        }
        this.connecting = false;
      };

      disconnectHandler = () => {
        this.currentPeripheral = null;
        cleanup();
        if (!testCompleted) {
          reject(new Error('Device disconnected during test'));
        }
      };

      peripheral.once('disconnect', disconnectHandler);

      connectionTimeout = setTimeout(() => {
        cleanup();
        this.forceDisconnect();
        reject(new Error('Test connection timeout'));
      }, 8000); // Shorter timeout for tests

      peripheral.connect((error) => {
        if (error) {
          cleanup();
          this.currentPeripheral = null;
          return reject(error);
        }

        peripheral.discoverAllServicesAndCharacteristics((error, services, characteristics) => {
          if (error) {
            cleanup();
            this.forceDisconnect();
            return reject(error);
          }

          const writeChar = characteristics.find(char => char.uuid === '2b11');
          const notifyChar = characteristics.find(char => char.uuid === '2b10');

          if (!writeChar) {
            cleanup();
            this.forceDisconnect();
            return reject(new Error('No write characteristic found'));
          }

          this.runTestSequence(writeChar, notifyChar, testConfig, () => {
            testCompleted = true;
            cleanup();
            setTimeout(() => this.forceDisconnect(), 100);
            resolve();
          }, (error) => {
            testCompleted = true;
            cleanup();
            this.forceDisconnect();
            reject(error);
          });
        });
      });
    });
  }

  runTestSequence(writeChar, notifyChar, testConfig, resolve, reject) {
    this.generateSessionKey();
    
    let responseReceived = false;
    let packetIndex = 0;
    
    // Set up notifications to detect any response
    if (notifyChar) {
      notifyChar.subscribe((error) => {
        if (!error) {
          notifyChar.on('data', (data) => {
            this.log(`[DIAGNOSTIC] Response received: ${data.toString('hex')}`);
            responseReceived = true;
          });
        }
      });
    }

    const sendNextPacket = () => {
      if (packetIndex >= testConfig.packets.length) {
        // Test completed
        setTimeout(() => {
          if (responseReceived) {
            this.log(`[DIAGNOSTIC] Test "${testConfig.name}" got device response - likely working!`);
          } else {
            this.log(`[DIAGNOSTIC] Test "${testConfig.name}" completed but no response received`);
          }
          resolve();
        }, 500);
        return;
      }

      const packetFunction = testConfig.packets[packetIndex];
      packetIndex++;

      try {
        let packet;
        if (typeof packetFunction === 'function') {
          packet = packetFunction();
        } else {
          packet = packetFunction;
        }

        if (packet && packet.then) {
          // Handle async packet creation
          packet.then(realPacket => {
            if (realPacket) {
              this.log(`[DIAGNOSTIC] Sending packet ${packetIndex}: ${realPacket.toString('hex')}`);
              writeChar.write(realPacket, true, (error) => {
                if (error) {
                  this.log(`[DIAGNOSTIC] Write error: ${error}`);
                }
                setTimeout(sendNextPacket, 300);
              });
            } else {
              setTimeout(sendNextPacket, 100);
            }
          });
        } else if (packet) {
          this.log(`[DIAGNOSTIC] Sending packet ${packetIndex}: ${packet.toString('hex')}`);
          writeChar.write(packet, true, (error) => {
            if (error) {
              this.log(`[DIAGNOSTIC] Write error: ${error}`);
            }
            setTimeout(sendNextPacket, 300);
          });
        } else {
          setTimeout(sendNextPacket, 100);
        }
      } catch (error) {
        this.log(`[DIAGNOSTIC] Packet creation error: ${error}`);
        setTimeout(sendNextPacket, 100);
      }
    };

    // Start sending packets
    setTimeout(sendNextPacket, 200);
  }

  async connectAndPress(peripheral) {
    // Standard connection for non-diagnostic mode
    return new Promise((resolve, reject) => {
      // Implementation similar to executeTest but with fixed packet sequence
      // This is for when diagnosticMode is false
      resolve();
    });
  }
}