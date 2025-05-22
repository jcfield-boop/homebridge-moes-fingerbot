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

    // Configuration (reading from correct schema structure)
    this.pressTime = config.pressTime || 3000; // Default matches schema
    this.scanDuration = (config.advanced?.scanDuration) || 5000;
    this.scanRetries = (config.advanced?.scanRetries) || 3;
    this.scanRetryCooldown = (config.advanced?.scanRetryCooldown) || 1000;
    this.batteryCheckInterval = ((config.advanced?.batteryCheckInterval) || 60) * 60 * 1000;
    
    // DIAGNOSTIC MODE for testing different commands
    this.commandDiagnosticMode = config.commandDiagnosticMode !== false; // default true
    this.batteryDiagnosticMode = config.batteryDiagnosticMode !== false; // default true

    // Protocol state - using working format from diagnostic
    this.sequenceNumber = 1;
    this.sessionKey = null;

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
        // Delay battery diagnostic to avoid conflicts
        setTimeout(() => {
          if (this.batteryDiagnosticMode) {
            this.log('[BATTERY-DIAG] Diagnostic mode enabled - will test battery reading methods');
            // Run diagnostic after a longer delay to ensure stability
            setTimeout(() => {
              this.getBatteryStatus().catch(err => {
                this.log(`[BATTERY-DIAG] Initial diagnostic failed: ${err.message}`);
              });
            }, 5000);
          }
        }, 1000);
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
    this.log(`Getting power state: ${this.isOn}`);
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
    const now = Date.now();
    if (now - this.lastBatteryCheck > this.batteryCheckInterval) {
      this.lastBatteryCheck = now;
      this.log(`[DEBUG] (Battery) Triggering background battery check...`);
      
      // Don't run battery diagnostic if main operation is in progress
      if (!this.currentOperation) {
        this.getBatteryStatus().catch(err => {
          this.log(`[DEBUG] (Battery) Background check failed: ${err.message}`);
        });
      }
    } else {
      this.log(`[DEBUG] (Battery) Returning cached battery level: ${this.batteryLevel}`);
    }
    callback(null, this.batteryLevel >= 0 && this.batteryLevel <= 100 ? this.batteryLevel : 0);
  }

  // Manual battery test trigger (can be called independently)
  async testBatteryReading() {
    this.log('[BATTERY-TEST] Starting manual battery test...');
    if (this.currentOperation || this.connecting) {
      throw new Error('Device busy - try again later');
    }
    
    return this.getBatteryStatus();
  }

  forceDisconnect() {
    if (this.currentPeripheral) {
      try {
        this.log('[DEBUG] Force disconnecting existing peripheral');
        this.currentPeripheral.disconnect();
      } catch (e) {
        this.log(`[DEBUG] Error force disconnecting: ${e}`);
      }
      this.currentPeripheral = null;
    }
    this.connecting = false;
    
    // Also try to stop any ongoing scanning to prevent conflicts
    try {
      noble.stopScanning();
    } catch (e) {
      // Ignore scanning stop errors
    }
    noble.removeAllListeners('discover');
  }

  // Generate session key (for battery reading)
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
      this.log(`[DEBUG] Generated session key: ${this.sessionKey.toString('hex')}`);
      return this.sessionKey;
    } catch (error) {
      this.log(`[DEBUG] Error generating session key: ${error}`);
      return null;
    }
  }

  // WORKING PACKET FORMAT - from successful diagnostic test
  createTuyaBLEPacket(commandType, data = Buffer.alloc(0)) {
    try {
      this.sequenceNumber = (this.sequenceNumber + 1) & 0xFFFF;
      
      // Working format: [0x55, 0xaa] [seq(2, BE)] [cmd(1)] [len(2, BE)] [data] [checksum(1)]
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
      
      const packet = Buffer.concat([header, payload, Buffer.from([checksum])]);
      this.log(`[DEBUG] Tuya BLE packet (cmd 0x${commandType.toString(16)}): ${packet.toString('hex')}`);
      return packet;
      
    } catch (error) {
      this.log(`[DEBUG] Error creating Tuya BLE packet: ${error}`);
      return null;
    }
  }

  // Working command packets
  createPressCommand() {
    // DP command: DP1 (switch) = true
    const dpData = Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01]);
    return this.createTuyaBLEPacket(0x06, dpData);
  }

  createReleaseCommand() {
    // DP command: DP1 (switch) = false  
    const dpData = Buffer.from([0x01, 0x01, 0x00, 0x01, 0x00]);
    return this.createTuyaBLEPacket(0x06, dpData);
  }

  createStatusQueryPacket() {
    // Status query for battery reading
    return this.createTuyaBLEPacket(0x08, Buffer.alloc(0));
  }

  // Battery status reading with diagnostic capabilities
  async getBatteryStatus() {
    if (!this.batteryDiagnosticMode) {
      return this.getBatteryStatusStandard();
    }

    return new Promise((resolve, reject) => {
      this.log('[BATTERY-DIAG] Starting comprehensive battery diagnostic...');
      
      if (this.connecting || this.currentOperation) {
        this.log('[BATTERY-DIAG] Device busy, skipping battery diagnostic');
        return reject(new Error('Device busy'));
      }

      const testConfigs = this.getBatteryTestConfigurations();
      let testIndex = 0;
      let foundBatteryMethods = [];

      const runNextBatteryTest = () => {
        if (testIndex >= testConfigs.length) {
          this.log(`[BATTERY-DIAG] Diagnostic complete! Found ${foundBatteryMethods.length} potential battery reading methods:`);
          foundBatteryMethods.forEach((method, i) => {
            this.log(`[BATTERY-DIAG] Method ${i + 1}: ${method.name} - ${method.result.method} - Value: ${method.result.value}%`);
          });
          
          if (foundBatteryMethods.length > 0) {
            // Use the first working method
            const bestMethod = foundBatteryMethods[0];
            this.batteryLevel = bestMethod.result.value;
            this.batteryService.updateCharacteristic(Characteristic.BatteryLevel, bestMethod.result.value);
            this.log(`[BATTERY-DIAG] Using method: ${bestMethod.name} with value ${bestMethod.result.value}%`);
          }
          
          resolve();
          return;
        }

        const config = testConfigs[testIndex];
        this.log(`[BATTERY-DIAG] Test ${testIndex + 1}/${testConfigs.length}: ${config.name}`);
        
        testIndex++;

        this.connectAndTestBattery(config)
          .then((result) => {
            if (result) {
              this.log(`[BATTERY-DIAG] SUCCESS! ${config.name} found battery reading: ${result.value}%`);
              foundBatteryMethods.push({ name: config.name, result });
            } else {
              this.log(`[BATTERY-DIAG] ${config.name} - no battery data found`);
            }
            setTimeout(runNextBatteryTest, 500); // Brief delay between tests
          })
          .catch((error) => {
            this.log(`[BATTERY-DIAG] ${config.name} failed: ${error.message}`);
            setTimeout(runNextBatteryTest, 500);
          });
      };

      runNextBatteryTest();
    });
  }

  async getBatteryStatusStandard() {
    // Standard non-diagnostic battery check
    return new Promise((resolve, reject) => {
      this.log('[DEBUG] (Battery) Starting standard battery check...');
      
      if (this.connecting || this.currentOperation) {
        this.log('[DEBUG] (Battery) Device busy, skipping battery check');
        return reject(new Error('Device busy'));
      }

      let scanTimeout = null;
      let found = false;

      const discoverHandler = async (peripheral) => {
        if (peripheral.address === this.address && !found) {
          found = true;
          this.log(`[DEBUG] (Battery) Found device: ${peripheral.address}`);
          
          try {
            noble.stopScanning();
          } catch (e) {}
          clearTimeout(scanTimeout);
          noble.removeListener('discover', discoverHandler);

          try {
            await this.connectForBattery(peripheral);
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
        this.log(`[DEBUG] (Battery) Error starting scan: ${e}`);
        noble.removeListener('discover', discoverHandler);
        return reject(new Error('Failed to start scanning'));
      }

      scanTimeout = setTimeout(() => {
        try {
          noble.stopScanning();
        } catch (e) {}
        noble.removeListener('discover', discoverHandler);
        
        if (!found) {
          this.log('[DEBUG] (Battery) Device not found during scan');
          reject(new Error('Device not found'));
        }
      }, 5000);
    });
  }

  async connectAndTestBattery(testConfig) {
    return new Promise((resolve, reject) => {
      let scanTimeout = null;
      let found = false;

      const discoverHandler = async (peripheral) => {
        if (peripheral.address === this.address && !found) {
          found = true;
          
          try {
            noble.stopScanning();
          } catch (e) {}
          clearTimeout(scanTimeout);
          noble.removeListener('discover', discoverHandler);

          try {
            const result = await this.executeBatteryTest(peripheral, testConfig);
            resolve(result);
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
        
        if (!found) {
          reject(new Error('Device not found during battery test'));
        }
      }, 4000); // Shorter scan for battery tests
    });
  }

  async executeBatteryTest(peripheral, testConfig) {
    return new Promise((resolve, reject) => {
      let connectionTimeout = null;
      let batteryResult = null;

      const cleanup = () => {
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
        }
      };

      connectionTimeout = setTimeout(() => {
        cleanup();
        try {
          peripheral.disconnect();
        } catch (e) {}
        reject(new Error('Battery test connection timeout'));
      }, 6000);

      peripheral.connect((error) => {
        if (error) {
          cleanup();
          return reject(error);
        }

        // Add small delay after connection before service discovery
        setTimeout(() => {
          peripheral.discoverAllServicesAndCharacteristics((error, services, characteristics) => {
            if (error) {
              cleanup();
              try {
                peripheral.disconnect();
              } catch (e) {}
              return reject(error);
            }

            const writeChar = characteristics.find(char => char.uuid === '2b11');
            const notifyChar = characteristics.find(char => char.uuid === '2b10');

            if (!writeChar) {
              cleanup();
              try {
                peripheral.disconnect();
              } catch (e) {}
              return reject(new Error('No write characteristic found'));
            }

            // Set up notifications to capture response
            let responseReceived = false;
            
            if (notifyChar) {
              notifyChar.subscribe((err) => {
                if (!err) {
                  notifyChar.on('data', (data) => {
                    responseReceived = true;
                    this.log(`[BATTERY-DIAG] ${testConfig.name} - Response: ${data.toString('hex')}`);
                    const result = testConfig.parser(data);
                    if (result) {
                      batteryResult = result;
                    }
                  });
                }
              });
            }

            this.generateSessionKey();
            const packet = testConfig.packet();
            
            if (packet) {
              // Add delay before writing
              setTimeout(() => {
                writeChar.write(packet, true, (writeError) => {
                  if (writeError) {
                    this.log(`[BATTERY-DIAG] Write error for ${testConfig.name}: ${writeError}`);
                  } else {
                    this.log(`[BATTERY-DIAG] ${testConfig.name} - Packet sent: ${packet.toString('hex')}`);
                  }
                  
                  // Wait longer for response
                  setTimeout(() => {
                    cleanup();
                    try {
                      peripheral.disconnect();
                    } catch (e) {}
                    
                    if (!responseReceived) {
                      this.log(`[BATTERY-DIAG] ${testConfig.name} - No response received`);
                    }
                    
                    resolve(batteryResult);
                  }, 3000); // Longer wait for response
                });
              }, 500);
            } else {
              cleanup();
              try {
                peripheral.disconnect();
              } catch (e) {}
              reject(new Error('Failed to create test packet'));
            }
          });
        }, 500); // Delay after connection
      });

      peripheral.once('disconnect', () => {
        cleanup();
      });
    });
  }

  async connectForBattery(peripheral) {
    return new Promise((resolve, reject) => {
      this.log('[DEBUG] (Battery) Connecting for battery check...');
      
      let connectionTimeout = setTimeout(() => {
        this.log('[DEBUG] (Battery) Connection timeout');
        try {
          peripheral.disconnect();
        } catch (e) {}
        reject(new Error('Connection timeout'));
      }, 8000);

      peripheral.connect((error) => {
        if (error) {
          clearTimeout(connectionTimeout);
          return reject(error);
        }

        peripheral.discoverAllServicesAndCharacteristics((error, services, characteristics) => {
          if (error) {
            clearTimeout(connectionTimeout);
            try {
              peripheral.disconnect();
            } catch (e) {}
            return reject(error);
          }

          const writeChar = characteristics.find(char => char.uuid === '2b11');
          const notifyChar = characteristics.find(char => char.uuid === '2b10');

          if (!writeChar) {
            clearTimeout(connectionTimeout);
            try {
              peripheral.disconnect();
            } catch (e) {}
            return reject(new Error('No write characteristic found'));
          }

          this.log('[DEBUG] (Battery) Requesting device status...');
          
            notifyChar.on('data', (data) => {
              this.log(`[DEBUG] Notification: ${data.toString('hex')}`);
              // Try multiple parsing methods in standard mode too
              const methods = [
                () => this.parseBatteryMethod1(data, "Standard notification"),
                () => this.parseBatteryMethod2(data, "Standard notification"),
                () => this.parseBatteryMethod5(data, "Standard notification")
              ];
              
              for (const method of methods) {
                const result = method();
                if (result) {
                  this.batteryLevel = result.value;
                  this.batteryService.updateCharacteristic(Characteristic.BatteryLevel, result.value);
                  this.log(`[DEBUG] (Battery) Found via ${result.method}: ${result.value}%`);
                  break;
                }
              }
            });

          this.generateSessionKey();
          const statusPacket = this.createStatusQueryPacket();
          
          if (statusPacket) {
            writeChar.write(statusPacket, true, (writeError) => {
              clearTimeout(connectionTimeout);
              
              setTimeout(() => {
                try {
                  peripheral.disconnect();
                } catch (e) {}
              }, 2000);
              
              if (writeError) {
                this.log(`[DEBUG] (Battery) Write error: ${writeError}`);
                reject(writeError);
              } else {
                this.log('[DEBUG] (Battery) Status query sent');
                resolve();
              }
            });
          } else {
            clearTimeout(connectionTimeout);
            try {
              peripheral.disconnect();
            } catch (e) {}
            reject(new Error('Failed to create status packet'));
          }
        });
      });

      peripheral.once('disconnect', () => {
        this.log('[DEBUG] (Battery) Peripheral disconnected');
        clearTimeout(connectionTimeout);
      });
    });
  }

  // COMMAND DIAGNOSTIC: Test different command approaches to find what makes the Fingerbot move
  getCommandTestConfigurations() {
    return [
      {
        name: "Current DP1 BOOL (true/false sequence)",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01])), // DP1 = true
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x00]))  // DP1 = false
        ],
        delay: this.pressTime
      },
      {
        name: "DP2 BOOL (alternative switch DP)",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x02, 0x01, 0x00, 0x01, 0x01])), // DP2 = true
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x02, 0x01, 0x00, 0x01, 0x00]))  // DP2 = false
        ],
        delay: this.pressTime
      },
      {
        name: "DP3 BOOL (another alternative)",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x03, 0x01, 0x00, 0x01, 0x01])), // DP3 = true
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x03, 0x01, 0x00, 0x01, 0x00]))  // DP3 = false
        ],
        delay: this.pressTime
      },
      {
        name: "DP1 INTEGER (0 to 1)",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x02, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01])), // DP1 = 1 (int)
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x02, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00]))  // DP1 = 0 (int)
        ],
        delay: this.pressTime
      },
      {
        name: "DP1 single press (BOOL true only)",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01])) // DP1 = true only
        ],
        delay: 500
      },
      {
        name: "DP4 BOOL (press/direction control)",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x04, 0x01, 0x00, 0x01, 0x01])) // DP4 = true
        ],
        delay: 500
      },
      {
        name: "DP5 BOOL (mode control)",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x05, 0x01, 0x00, 0x01, 0x01])) // DP5 = true
        ],
        delay: 500
      },
      {
        name: "Multiple DPs (press + direction)",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01])), // DP1 = true (press)
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x02, 0x01, 0x00, 0x01, 0x01]))  // DP2 = true (direction?)
        ],
        delay: 800
      },
      {
        name: "Direct command 0x04 (raw press)",
        commands: [
          () => this.createTuyaBLEPacket(0x04, Buffer.from([0x01])) // Direct press command
        ],
        delay: 500
      },
      {
        name: "Direct command 0x07 (alternative press)",
        commands: [
          () => this.createTuyaBLEPacket(0x07, Buffer.from([0x01])) // Alternative press
        ],
        delay: 500
      },
      {
        name: "Raw switch command 0x03",
        commands: [
          () => this.createTuyaBLEPacket(0x03, Buffer.from([0x01, 0x00])) // Raw switch
        ],
        delay: 500
      },
      {
        name: "DP1 with different data format",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x04, 0x00, 0x01, 0x01])) // DP1, type 4
        ],
        delay: 500
      }
    ];
  }
  // EXTENDED COMMAND DIAGNOSTIC: More advanced approaches including authentication
  getExtendedCommandTestConfigurations() {
    return [
      {
        name: "Auth + DP1 BOOL sequence",
        commands: [
          () => this.createTuyaBLEPacket(0x01, Buffer.from(this.deviceId, 'utf8')), // Login first
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01])), // Then DP1 = true
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x00]))  // Then DP1 = false
        ],
        delay: this.pressTime
      },
      {
        name: "Heartbeat + DP1 sequence",
        commands: [
          () => {
            const timestamp = Math.floor(Date.now() / 1000);
            const timestampBuffer = Buffer.alloc(4);
            timestampBuffer.writeUInt32BE(timestamp, 0);
            return this.createTuyaBLEPacket(0x02, timestampBuffer);
          },
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01]))
        ],
        delay: 1000
      },
      {
        name: "DP101 BOOL (extended DP range)",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x65, 0x01, 0x00, 0x01, 0x01])) // DP101 = true
        ],
        delay: 500
      },
      {
        name: "DP102 BOOL",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x66, 0x01, 0x00, 0x01, 0x01])) // DP102 = true
        ],
        delay: 500
      },
      {
        name: "DP103 BOOL", 
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x67, 0x01, 0x00, 0x01, 0x01])) // DP103 = true
        ],
        delay: 500
      },
      {
        name: "DP1 with enum type (0x04)",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x04, 0x00, 0x01, 0x01])) // DP1, ENUM, value 1
        ],
        delay: 500
      },
      {
        name: "DP1 raw data type (0x00)",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x00, 0x00, 0x01, 0x01])) // DP1, RAW, value 1
        ],
        delay: 500
      },
      {
        name: "Direct motor command 0x0A",
        commands: [
          () => this.createTuyaBLEPacket(0x0A, Buffer.from([0x01, 0x01])) // Motor control
        ],
        delay: 500
      },
      {
        name: "Device control 0x0B",
        commands: [
          () => this.createTuyaBLEPacket(0x0B, Buffer.from([0x01])) // Device control
        ],
        delay: 500
      },
      {
        name: "Multiple DP command (batch)",
        commands: [
          () => {
            // Multiple DPs in one packet: DP1=true, DP2=true
            const dp1 = Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01]);
            const dp2 = Buffer.from([0x02, 0x01, 0x00, 0x01, 0x01]);
            return this.createTuyaBLEPacket(0x06, Buffer.concat([dp1, dp2]));
          }
        ],
        delay: 500
      },
      {
        name: "Auth + Status + DP1 (full sequence)",
        commands: [
          () => this.createTuyaBLEPacket(0x01, Buffer.from(this.deviceId, 'utf8')), // Login
          () => this.createTuyaBLEPacket(0x08, Buffer.alloc(0)), // Status query
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01])), // DP1 = true
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x00]))  // DP1 = false
        ],
        delay: this.pressTime
      },
      {
        name: "Press with timing data",
        commands: [
          () => {
            // DP1 = true with timing/duration info
            return this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x02, 0x00, 0x04, 0x00, 0x00, 0x03, 0xE8])); // DP1, INT, 1000ms
          }
        ],
        delay: 1000
      }
    ];
  }

  // Manual extended test trigger
  async testExtendedCommands() {
    this.log('[EXTENDED-DIAG] Starting extended command diagnostic...');
    if (this.currentOperation || this.connecting) {
      throw new Error('Device busy - try again later');
    }
    
    return new Promise((resolve, reject) => {
      this.forceDisconnect();

      const testConfigs = this.getExtendedCommandTestConfigurations();
      let testIndex = 0;

      const runNextExtendedTest = () => {
        if (testIndex >= testConfigs.length) {
          this.log(`[EXTENDED-DIAG] All extended tests completed! Check if any made the Fingerbot move.`);
          resolve();
          return;
        }

        const config = testConfigs[testIndex];
        this.log(`[EXTENDED-DIAG] Extended Test ${testIndex + 1}/${testConfigs.length}: ${config.name}`);
        this.log(`[EXTENDED-DIAG] ** WATCH THE FINGERBOT NOW ** - Test starting in 3 seconds...`);
        
        setTimeout(() => {
          testIndex++;
          this.connectAndTestCommand(config)
            .then(() => {
              this.log(`[EXTENDED-DIAG] Extended test "${config.name}" completed. Did the Fingerbot move?`);
              setTimeout(runNextExtendedTest, 4000); // Longer delay between extended tests
            })
            .catch((error) => {
              this.log(`[EXTENDED-DIAG] Extended test "${config.name}" failed: ${error.message}`);
              setTimeout(runNextExtendedTest, 3000);
            });
        }, 3000); // Longer warning delay
      };

      runNextExtendedTest();
    });
  }
    return [
      {
        name: "Status query (0x08) - standard",
        packet: () => this.createTuyaBLEPacket(0x08, Buffer.alloc(0)),
        parser: (data) => this.parseBatteryMethod1(data, "Status query standard")
      },
      {
        name: "DP query for DP2 (common battery DP)",
        packet: () => this.createTuyaBLEPacket(0x07, Buffer.from([0x02])), // Query DP2
        parser: (data) => this.parseBatteryMethod2(data, "DP2 query")
      },
      {
        name: "DP query for DP3 (alternative battery DP)",
        packet: () => this.createTuyaBLEPacket(0x07, Buffer.from([0x03])), // Query DP3
        parser: (data) => this.parseBatteryMethod2(data, "DP3 query")
      },
      {
        name: "DP query for DP4 (another alternative)",
        packet: () => this.createTuyaBLEPacket(0x07, Buffer.from([0x04])), // Query DP4
        parser: (data) => this.parseBatteryMethod2(data, "DP4 query")
      },
      {
        name: "Device info query (0x09)",
        packet: () => this.createTuyaBLEPacket(0x09, Buffer.alloc(0)),
        parser: (data) => this.parseBatteryMethod3(data, "Device info")
      },
      {
        name: "Raw data request (0x0A)",
        packet: () => this.createTuyaBLEPacket(0x0A, Buffer.alloc(0)),
        parser: (data) => this.parseBatteryMethod4(data, "Raw data")
      },
      {
        name: "Heartbeat with status (0x02)",
        packet: () => {
          const timestamp = Math.floor(Date.now() / 1000);
          const timestampBuffer = Buffer.alloc(4);
          timestampBuffer.writeUInt32BE(timestamp, 0);
          return this.createTuyaBLEPacket(0x02, timestampBuffer);
        },
        parser: (data) => this.parseBatteryMethod1(data, "Heartbeat status")
      },
      {
        name: "Multiple DP query (DPs 1-5)",
        packet: () => this.createTuyaBLEPacket(0x07, Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05])),
        parser: (data) => this.parseBatteryMethod5(data, "Multiple DP query")
      },
      {
        name: "Authentication + status (with deviceId)",
        packet: () => {
          const loginData = Buffer.from(this.deviceId, 'utf8');
          return this.createTuyaBLEPacket(0x01, loginData);
        },
        parser: (data) => this.parseBatteryMethod1(data, "Auth + status")
      },
      {
        name: "Extended status query (0x08 with deviceId)",
        packet: () => {
          const deviceIdBuffer = Buffer.from(this.deviceId, 'utf8');
          return this.createTuyaBLEPacket(0x08, deviceIdBuffer);
        },
        parser: (data) => this.parseBatteryMethod6(data, "Extended status")
      }
    ];
  }

  // Different parsing methods to try
  parseBatteryMethod1(data, source) {
    // Standard DP parsing - look for integer DPs that could be battery
    if (data.length < 8) return null;
    
    this.log(`[BATTERY-DIAG] ${source} - Raw data: ${data.toString('hex')}`);
    
    for (let i = 0; i < data.length - 6; i++) {
      const dpId = data[i];
      const dpType = data[i + 1];
      
      if (dpId >= 0x01 && dpId <= 0x10 && dpType === 0x02) { // INTEGER type
        try {
          const dpLen = data.readUInt16BE(i + 2);
          if (dpLen === 4 && i + 8 <= data.length) {
            const value = data.readUInt32BE(i + 4);
            if (value >= 0 && value <= 100) {
              this.log(`[BATTERY-DIAG] ${source} - Found potential battery: DP${dpId} = ${value}%`);
              return { dpId, value, method: "Method1-Integer" };
            }
          }
        } catch (e) {}
      }
    }
    return null;
  }

  parseBatteryMethod2(data, source) {
    // Look for single byte percentage values
    this.log(`[BATTERY-DIAG] ${source} - Raw data: ${data.toString('hex')}`);
    
    for (let i = 0; i < data.length; i++) {
      const value = data[i];
      if (value > 0 && value <= 100) {
        this.log(`[BATTERY-DIAG] ${source} - Found potential battery at offset ${i}: ${value}%`);
        return { offset: i, value, method: "Method2-SingleByte" };
      }
    }
    return null;
  }

  parseBatteryMethod3(data, source) {
    // Look for 2-byte values that could be battery percentage
    this.log(`[BATTERY-DIAG] ${source} - Raw data: ${data.toString('hex')}`);
    
    for (let i = 0; i < data.length - 1; i++) {
      const valueBE = data.readUInt16BE(i);
      const valueLE = data.readUInt16LE(i);
      
      if (valueBE > 0 && valueBE <= 100) {
        this.log(`[BATTERY-DIAG] ${source} - Found potential battery BE at offset ${i}: ${valueBE}%`);
        return { offset: i, value: valueBE, method: "Method3-2ByteBE" };
      }
      if (valueLE > 0 && valueLE <= 100 && valueLE !== valueBE) {
        this.log(`[BATTERY-DIAG] ${source} - Found potential battery LE at offset ${i}: ${valueLE}%`);
        return { offset: i, value: valueLE, method: "Method3-2ByteLE" };
      }
    }
    return null;
  }

  parseBatteryMethod4(data, source) {
    // Look for patterns like voltage readings that might correlate to battery
    this.log(`[BATTERY-DIAG] ${source} - Raw data: ${data.toString('hex')}`);
    
    for (let i = 0; i < data.length - 3; i++) {
      const value32BE = data.readUInt32BE(i);
      const value32LE = data.readUInt32LE(i);
      
      // Check for voltage-like values (2500-4200 mV range)
      if (value32BE >= 2500 && value32BE <= 4200) {
        const estimated = Math.round(((value32BE - 2500) / 1700) * 100);
        this.log(`[BATTERY-DIAG] ${source} - Found potential voltage BE at offset ${i}: ${value32BE}mV (~${estimated}%)`);
        return { offset: i, value: estimated, voltage: value32BE, method: "Method4-VoltageBE" };
      }
      if (value32LE >= 2500 && value32LE <= 4200 && value32LE !== value32BE) {
        const estimated = Math.round(((value32LE - 2500) / 1700) * 100);
        this.log(`[BATTERY-DIAG] ${source} - Found potential voltage LE at offset ${i}: ${value32LE}mV (~${estimated}%)`);
        return { offset: i, value: estimated, voltage: value32LE, method: "Method4-VoltageLE" };
      }
    }
    return null;
  }

  parseBatteryMethod5(data, source) {
    // Advanced DP structure parsing
    this.log(`[BATTERY-DIAG] ${source} - Raw data: ${data.toString('hex')}`);
    
    // Look for Tuya DP response structure: [count][dp1_id][dp1_type][dp1_len][dp1_data]...
    if (data.length >= 6) {
      try {
        let offset = 7; // Skip header
        while (offset < data.length - 4) {
          const dpId = data[offset];
          const dpType = data[offset + 1];
          const dpLen = data.readUInt16BE(offset + 2);
          
          if (dpLen > 0 && dpLen <= 8 && offset + 4 + dpLen <= data.length) {
            const dpData = data.slice(offset + 4, offset + 4 + dpLen);
            
            if (dpType === 0x02 && dpLen === 4) { // 4-byte integer
              const value = dpData.readUInt32BE(0);
              if (value <= 100) {
                this.log(`[BATTERY-DIAG] ${source} - DP structure: DP${dpId} (type ${dpType}) = ${value}`);
                return { dpId, value, method: "Method5-DPStructure" };
              }
            } else if (dpType === 0x01 && dpLen === 1) { // 1-byte boolean/int
              const value = dpData[0];
              if (value <= 100) {
                this.log(`[BATTERY-DIAG] ${source} - DP structure: DP${dpId} (type ${dpType}) = ${value}`);
                return { dpId, value, method: "Method5-DPStructure" };
              }
            }
            
            offset += 4 + dpLen;
          } else {
            break;
          }
        }
      } catch (e) {
        this.log(`[BATTERY-DIAG] ${source} - DP parsing error: ${e.message}`);
      }
    }
    return null;
  }

  parseBatteryMethod6(data, source) {
    // Check for battery level in specific known locations
    this.log(`[BATTERY-DIAG] ${source} - Raw data: ${data.toString('hex')}`);
    
    const knownOffsets = [7, 8, 9, 10, 11, 12, 15, 16, 20, 24]; // Common battery locations
    
    for (const offset of knownOffsets) {
      if (offset < data.length) {
        const value = data[offset];
        if (value > 0 && value <= 100) {
          this.log(`[BATTERY-DIAG] ${source} - Found battery at known offset ${offset}: ${value}%`);
          return { offset, value, method: "Method6-KnownOffset" };
        }
      }
    }
    return null;
  }

  async pressButton() {
    if (this.commandDiagnosticMode) {
      return this.pressButtonDiagnostic();
    } else {
      return this.pressButtonStandard();
    }
  }

  async pressButtonDiagnostic() {
    return new Promise((resolve, reject) => {
      this.log('[COMMAND-DIAG] Starting command diagnostic to find working Fingerbot commands...');
      this.forceDisconnect();

      const testConfigs = this.getCommandTestConfigurations();
      let testIndex = 0;

      const runNextCommandTest = () => {
        if (testIndex >= testConfigs.length) {
          this.log(`[COMMAND-DIAG] First round tests completed!`);
          this.log(`[COMMAND-DIAG] Starting EXTENDED diagnostic with authentication sequences...`);
          
          // Run extended tests
          this.runExtendedDiagnostic()
            .then(() => {
              this.log(`[COMMAND-DIAG] All diagnostic tests completed! If no movement was seen, the device may need:`);
              this.log(`[COMMAND-DIAG] 1. Different firmware-specific commands`);
              this.log(`[COMMAND-DIAG] 2. Encrypted payloads with proper authentication`);
              this.log(`[COMMAND-DIAG] 3. Physical button press to activate pairing mode first`);
              resolve();
            })
            .catch(() => {
              resolve();
            });
          return;
        }

        const config = testConfigs[testIndex];
        this.log(`[COMMAND-DIAG] Test ${testIndex + 1}/${testConfigs.length}: ${config.name}`);
        this.log(`[COMMAND-DIAG] ** WATCH THE FINGERBOT NOW ** - Test starting in 2 seconds...`);
        
        setTimeout(() => {
          testIndex++;
          this.connectAndTestCommand(config)
            .then(() => {
              this.log(`[COMMAND-DIAG] Test "${config.name}" completed. Did the Fingerbot move? (Check physically)`);
              setTimeout(runNextCommandTest, 3000); // 3 second delay between tests
            })
            .catch((error) => {
              this.log(`[COMMAND-DIAG] Test "${config.name}" failed: ${error.message}`);
              setTimeout(runNextCommandTest, 2000);
            });
        }, 2000); // 2 second warning delay
      };

      runNextCommandTest();
    });
  }

  async runExtendedDiagnostic() {
    return new Promise((resolve, reject) => {
      const testConfigs = this.getExtendedCommandTestConfigurations();
      let testIndex = 0;

      const runNextExtendedTest = () => {
        if (testIndex >= testConfigs.length) {
          this.log(`[EXTENDED-DIAG] All extended tests completed!`);
          resolve();
          return;
        }

        const config = testConfigs[testIndex];
        this.log(`[EXTENDED-DIAG] Extended Test ${testIndex + 1}/${testConfigs.length}: ${config.name}`);
        this.log(`[EXTENDED-DIAG] ** WATCH THE FINGERBOT NOW ** - Test starting in 3 seconds...`);
        
        setTimeout(() => {
          testIndex++;
          this.connectAndTestCommand(config)
            .then(() => {
              this.log(`[EXTENDED-DIAG] Extended test "${config.name}" completed. Did the Fingerbot move?`);
              setTimeout(runNextExtendedTest, 4000); // Longer delay between extended tests
            })
            .catch((error) => {
              this.log(`[EXTENDED-DIAG] Extended test "${config.name}" failed: ${error.message}`);
              setTimeout(runNextExtendedTest, 3000);
            });
        }, 3000); // Longer warning delay
      };

      runNextExtendedTest();
    });
    });
  }

  async pressButtonStandard() {
    return new Promise((resolve, reject) => {
      this.log('Scanning for Fingerbot...');

      this.forceDisconnect();

      let retryCount = 0;
      let scanTimeout = null;
      let peripheralFound = false;

      const discoverHandler = async (peripheral) => {
        if (peripheral.address === this.address && !peripheralFound) {
          peripheralFound = true;
          this.log(`Found Fingerbot: ${peripheral.address}`);
          
          try {
            noble.stopScanning();
          } catch (e) {
            this.log(`[DEBUG] Error stopping scan: ${e}`);
          }
          
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

      const startScan = () => {
        peripheralFound = false;
        noble.removeAllListeners('discover');
        noble.on('discover', discoverHandler);
        
        this.log(`[DEBUG] Starting scan attempt ${retryCount + 1}...`);
        
        try {
          noble.startScanning([], true);
        } catch (e) {
          this.log(`[DEBUG] Error starting scan: ${e}`);
          noble.removeListener('discover', discoverHandler);
          reject(new Error('Failed to start scanning'));
          return;
        }

        scanTimeout = setTimeout(() => {
          try {
            noble.stopScanning();
          } catch (e) {
            this.log(`[DEBUG] Error stopping scan: ${e}`);
          }
          noble.removeListener('discover', discoverHandler);

          if (!peripheralFound && retryCount < this.scanRetries) {
            retryCount++;
            this.log(`Scan attempt ${retryCount} failed, retrying in ${this.scanRetryCooldown}ms...`);
            setTimeout(startScan, this.scanRetryCooldown);
          } else if (!peripheralFound) {
            reject(new Error('Failed to find Fingerbot device after multiple attempts'));
          }
        }, this.scanDuration);
      };

      startScan();
    });
  }

  async connectAndTestCommand(testConfig) {
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
            await this.executeCommandTest(peripheral, testConfig);
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
          reject(new Error('Device not found during command test'));
        }
      }, 4000); // Quick scan for command tests
    });
  }

  async executeCommandTest(peripheral, testConfig) {
    return new Promise((resolve, reject) => {
      this.forceDisconnect();
      
      setTimeout(() => {
        this.doConnection(peripheral, () => {
          this.log(`[COMMAND-DIAG] Connection successful, executing: ${testConfig.name}`);
          resolve();
        }, reject, testConfig);
      }, 500);
    });
  }

  async connectAndPress(peripheral) {
    return new Promise((resolve, reject) => {
      this.log('Connecting to Fingerbot...');

      if (this.connecting) {
        return reject(new Error('Already connecting'));
      }

      // Always force disconnect first to ensure clean state
      this.forceDisconnect();
      
      // Wait a moment for cleanup to complete
      setTimeout(() => {
        this.doConnection(peripheral, resolve, reject);
      }, 1000);
    });
  }

  doConnection(peripheral, resolve, reject, testConfig = null) {
    // Check if already connected and disconnect first
    if (peripheral.state === 'connected') {
      this.log('[DEBUG] Peripheral already connected, disconnecting first...');
      try {
        peripheral.disconnect();
        setTimeout(() => {
          this.doConnection(peripheral, resolve, reject, testConfig);
        }, 2000);
        return;
      } catch (e) {
        this.log(`[DEBUG] Error disconnecting: ${e}`);
      }
    }

    this.connecting = true;
    this.currentPeripheral = peripheral;

    let connectionTimeout = null;
    let disconnectHandler = null;
    let serviceTimeout = null;

    const cleanup = () => {
      if (connectionTimeout) {
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
      }
      if (serviceTimeout) {
        clearTimeout(serviceTimeout);
        serviceTimeout = null;
      }
      if (disconnectHandler) {
        peripheral.removeListener('disconnect', disconnectHandler);
        disconnectHandler = null;
      }
      this.connecting = false;
    };

    disconnectHandler = () => {
      this.log('[DEBUG] Peripheral disconnected during operation');
      this.currentPeripheral = null;
      cleanup();
      reject(new Error('Device disconnected during operation'));
    };

    peripheral.once('disconnect', disconnectHandler);

    connectionTimeout = setTimeout(() => {
      this.log('[DEBUG] Connection timeout');
      cleanup();
      this.forceDisconnect();
      reject(new Error('Connection timeout'));
    }, 15000); // Longer timeout

    peripheral.connect((error) => {
      if (error) {
        this.log(`[DEBUG] Connection error: ${error}`);
        cleanup();
        this.currentPeripheral = null;
        return reject(error);
      }

      this.log('[DEBUG] Connected, waiting before service discovery...');
      
      // Wait longer before service discovery to let connection stabilize
      setTimeout(() => {
        if (peripheral.state !== 'connected') {
          cleanup();
          return reject(new Error('Device disconnected before service discovery'));
        }

        this.log('[DEBUG] Starting service discovery...');
        
        peripheral.discoverAllServicesAndCharacteristics((error, services, characteristics) => {
          if (error) {
            this.log(`[DEBUG] Service discovery error: ${error}`);
            cleanup();
            this.forceDisconnect();
            return reject(error);
          }

          if (peripheral.state !== 'connected') {
            cleanup();
            return reject(new Error('Device disconnected during service discovery'));
          }

          this.log(`[DEBUG] Discovered ${services?.length || 0} services, ${characteristics?.length || 0} characteristics`);

          const writeChar = characteristics.find(char => char.uuid === '2b11');
          const notifyChar = characteristics.find(char => char.uuid === '2b10');

          if (!writeChar) {
            this.log('[DEBUG] No write characteristic (2b11) found');
            cleanup();
            this.forceDisconnect();
            return reject(new Error('No write characteristic found'));
          }

          this.log(`[DEBUG] Using write characteristic: ${writeChar.uuid}`);
          if (notifyChar) {
            this.log(`[DEBUG] Using notify characteristic: ${notifyChar.uuid}`);
          }

          // Clear connection timeout, set service timeout
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
          
          serviceTimeout = setTimeout(() => {
            this.log('[DEBUG] Service operation timeout');
            cleanup();
            this.forceDisconnect();
            reject(new Error('Service operation timeout'));
          }, 10000);

          if (testConfig) {
            this.executeTestSequence(writeChar, notifyChar, peripheral, testConfig, cleanup, resolve, reject);
          } else {
            this.executeWorkingSequence(writeChar, notifyChar, peripheral, cleanup, resolve, reject);
          }
        });
      }, 2000); // Wait 2 seconds after connection before service discovery
    });
  }

  executeTestSequence(writeChar, notifyChar, peripheral, testConfig, cleanup, resolve, reject) {
    this.log(`[COMMAND-DIAG] Executing test: ${testConfig.name}`);
    
    let operationTimeout = null;
    let sequenceComplete = false;

    operationTimeout = setTimeout(() => {
      if (!sequenceComplete) {
        this.log('[COMMAND-DIAG] Test operation timeout');
        cleanup();
        this.forceDisconnect();
        resolve(); // Don't reject, just complete the test
      }
    }, 8000);

    // Set up notifications to see if device responds
    if (notifyChar) {
      notifyChar.subscribe((error) => {
        if (error) {
          this.log(`[COMMAND-DIAG] Notification subscription error: ${error}`);
        } else {
          this.log('[COMMAND-DIAG] Subscribed to notifications');
          
          notifyChar.on('data', (data) => {
            this.log(`[COMMAND-DIAG] Device response: ${data.toString('hex')}`);
          });
        }
      });
    }

    // Execute the test command sequence
    const executeTest = () => {
      let commandIndex = 0;
      
      const sendNextCommand = () => {
        if (commandIndex >= testConfig.commands.length) {
          // Test completed
          sequenceComplete = true;
          clearTimeout(operationTimeout);
          cleanup();
          
          setTimeout(() => {
            this.forceDisconnect();
            this.log(`[COMMAND-DIAG] Test "${testConfig.name}" completed - check if Fingerbot moved!`);
            resolve();
          }, 500);
          return;
        }

        const commandFunction = testConfig.commands[commandIndex];
        const packet = commandFunction();
        commandIndex++;

        if (packet) {
          this.log(`[COMMAND-DIAG] Sending command ${commandIndex}: ${packet.toString('hex')}`);
          writeChar.write(packet, true, (error) => {
            if (error) {
              this.log(`[COMMAND-DIAG] Command write error: ${error}`);
            } else {
              this.log(`[COMMAND-DIAG] Command ${commandIndex} sent successfully`);
            }

            // Wait before next command (or completion)
            const delay = commandIndex >= testConfig.commands.length ? testConfig.delay : 300;
            setTimeout(sendNextCommand, delay);
          });
        } else {
          setTimeout(sendNextCommand, 100);
        }
      };

      sendNextCommand();
    };

    // Start the test sequence
    setTimeout(executeTest, 500);
  }

  executeWorkingSequence(writeChar, notifyChar, peripheral, cleanup, resolve, reject) {
    this.log('[DEBUG] Executing WORKING Fingerbot sequence...');
    
    let operationTimeout = null;
    let sequenceComplete = false;

    operationTimeout = setTimeout(() => {
      if (!sequenceComplete) {
        this.log('[DEBUG] Operation timeout');
        cleanup();
        this.forceDisconnect();
        reject(new Error('Operation timeout'));
      }
    }, 8000);

    // Set up notifications for status/battery updates
    if (notifyChar) {
      notifyChar.subscribe((error) => {
        if (error) {
          this.log(`[DEBUG] Notification subscription error: ${error}`);
        } else {
          this.log('[DEBUG] Subscribed to notifications');
          
          notifyChar.on('data', (data) => {
            this.log(`[DEBUG] Notification: ${data.toString('hex')}`);
            this.parseBatteryFromResponse(data);
          });
        }
      });
    }

    // Execute the working press+release sequence
    const executeSequence = () => {
      const pressPacket = this.createPressCommand();
      const releasePacket = this.createReleaseCommand();

      if (!pressPacket || !releasePacket) {
        sequenceComplete = true;
        clearTimeout(operationTimeout);
        cleanup();
        this.forceDisconnect();
        return reject(new Error('Failed to create command packets'));
      }

      this.log('[DEBUG] Sending press command...');
      writeChar.write(pressPacket, true, (error) => {
        if (error) {
          this.log(`[DEBUG] Press command error: ${error}`);
          // Continue anyway - device might still work
        } else {
          this.log('[DEBUG] Press command sent successfully');
        }

        // Wait for press duration, then send release
        setTimeout(() => {
          this.log('[DEBUG] Sending release command...');
          writeChar.write(releasePacket, true, (error) => {
            if (error) {
              this.log(`[DEBUG] Release command error: ${error}`);
            } else {
              this.log('[DEBUG] Release command sent successfully');
            }

            // Complete the operation
            sequenceComplete = true;
            clearTimeout(operationTimeout);
            cleanup();
            
            setTimeout(() => {
              this.forceDisconnect();
              this.log('[DEBUG] Fingerbot operation completed successfully!');
              resolve();
            }, 300);
          });
        }, this.pressTime);
      });
    };

    // Start the sequence
    setTimeout(executeSequence, 200);
  }
}