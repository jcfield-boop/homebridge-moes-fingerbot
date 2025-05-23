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
        if (this.commandDiagnosticMode) {
          this.log('[COMMAND-DIAG] Diagnostic mode enabled - will test command formats when activated');
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
    callback(null, this.batteryLevel >= 0 && this.batteryLevel <= 100 ? this.batteryLevel : 0);
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

  // Generate session key (for potential future use)
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

  // WORKING PACKET FORMAT - with proper Tuya BLE encryption
  createTuyaBLEPacket(commandType, data = Buffer.alloc(0), encrypt = false) {
    try {
      this.sequenceNumber = (this.sequenceNumber + 1) & 0xFFFF;
      
      // Tuya BLE format: [0x55, 0xaa] [seq(2, BE)] [cmd(1)] [len(2, BE)] [data] [checksum(1)]
      const header = Buffer.from([0x55, 0xaa]);
      const seqBuffer = Buffer.alloc(2);
      seqBuffer.writeUInt16BE(this.sequenceNumber, 0);
      const cmdBuffer = Buffer.from([commandType]);
      
      let finalData = data;
      
      // Encrypt data if requested and we have session key
      if (encrypt && this.sessionKey && (commandType === 0x06 || commandType === 0x07)) {
        try {
          // Create proper Tuya BLE encrypted payload
          const timestamp = Math.floor(Date.now() / 1000);
          const deviceIdBuffer = Buffer.from(this.deviceId, 'utf8');
          
          // Build authenticated data: deviceId + timestamp + command data
          const timestampBuffer = Buffer.alloc(4);
          timestampBuffer.writeUInt32BE(timestamp, 0);
          const authData = Buffer.concat([deviceIdBuffer, timestampBuffer, data]);
          
          // Pad to 16-byte boundary for AES
          const paddingNeeded = 16 - (authData.length % 16);
          const paddedData = Buffer.concat([authData, Buffer.alloc(paddingNeeded, paddingNeeded)]);
          
          // Encrypt with AES-128-ECB
          const cipher = crypto.createCipher('aes-128-ecb', this.sessionKey);
          cipher.setAutoPadding(false);
          finalData = Buffer.concat([cipher.update(paddedData), cipher.final()]);
          
          this.log(`[DEBUG] Encrypted payload (${finalData.length} bytes): ${finalData.toString('hex')}`);
        } catch (encError) {
          this.log(`[DEBUG] Encryption failed: ${encError}, using raw data`);
          finalData = data;
        }
      }
      
      const lengthBuffer = Buffer.alloc(2);
      lengthBuffer.writeUInt16BE(finalData.length, 0);
      
      const payload = Buffer.concat([seqBuffer, cmdBuffer, lengthBuffer, finalData]);
      const preChecksum = Buffer.concat([header, payload]);
      
      let checksum = 0;
      for (let i = 0; i < preChecksum.length; i++) {
        checksum = (checksum + preChecksum[i]) & 0xFF;
      }
      
      const packet = Buffer.concat([header, payload, Buffer.from([checksum])]);
      this.log(`[DEBUG] Tuya BLE packet (cmd 0x${commandType.toString(16)}, encrypted: ${encrypt}): ${packet.toString('hex')}`);
      return packet;
      
    } catch (error) {
      this.log(`[DEBUG] Error creating Tuya BLE packet: ${error}`);
      return null;
    }
  }

  // COMMAND DIAGNOSTIC: Test encrypted and authenticated approaches
  getCommandTestConfigurations() {
    return [
      {
        name: "Basic DP1 BOOL (no encryption)",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01]), false), // DP1 = true
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x00]), false)  // DP1 = false
        ],
        delay: this.pressTime
      },
      {
        name: "ENCRYPTED DP1 BOOL (with auth)",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01]), true), // DP1 = true (encrypted)
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x00]), true)  // DP1 = false (encrypted)
        ],
        delay: this.pressTime
      },
      {
        name: "Full Auth + Encrypted DP1",
        commands: [
          () => this.createTuyaBLEPacket(0x01, Buffer.from(this.deviceId, 'utf8'), false), // Login
          () => {
            // Heartbeat with timestamp
            const timestamp = Math.floor(Date.now() / 1000);
            const timestampBuffer = Buffer.alloc(4);
            timestampBuffer.writeUInt32BE(timestamp, 0);
            return this.createTuyaBLEPacket(0x02, timestampBuffer, false);
          },
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01]), true), // Encrypted DP1 = true
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x00]), true)  // Encrypted DP1 = false
        ],
        delay: this.pressTime
      },
      {
        name: "ENCRYPTED DP2 BOOL",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x02, 0x01, 0x00, 0x01, 0x01]), true), // DP2 = true (encrypted)
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x02, 0x01, 0x00, 0x01, 0x00]), true)  // DP2 = false (encrypted)
        ],
        delay: this.pressTime
      },
      {
        name: "ENCRYPTED DP1 INTEGER",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x02, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01]), true), // DP1 = 1 (encrypted)
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x02, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00]), true)  // DP1 = 0 (encrypted)
        ],
        delay: this.pressTime
      },
      {
        name: "Single ENCRYPTED DP1 press",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01]), true) // Just DP1 = true (encrypted)
        ],
        delay: 1000
      },
      {
        name: "Command 0x07 with ENCRYPTED DP query",
        commands: [
          () => this.createTuyaBLEPacket(0x07, Buffer.from([0x01]), true) // Query DP1 (encrypted)
        ],
        delay: 500
      },
      {
        name: "Raw 0x04 command ENCRYPTED",
        commands: [
          () => this.createTuyaBLEPacket(0x04, Buffer.from([0x01]), true) // Raw command (encrypted)
        ],
        delay: 500
      }
    ];
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
          this.log(`[COMMAND-DIAG] All command tests completed! Check if any made the Fingerbot move.`);
          this.log(`[COMMAND-DIAG] If you saw movement, note which test number worked and we'll use that format.`);
          resolve();
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
    
    // Generate session key for encryption before starting
    this.generateSessionKey();
    
    let operationTimeout = null;
    let sequenceComplete = false;

    operationTimeout = setTimeout(() => {
      if (!sequenceComplete) {
        this.log('[COMMAND-DIAG] Test operation timeout');
        cleanup();
        this.forceDisconnect();
        resolve(); // Don't reject, just complete the test
      }
    }, 10000); // Longer timeout for encrypted commands

    // Set up notifications to see if device responds
    if (notifyChar) {
      notifyChar.subscribe((error) => {
        if (error) {
          this.log(`[COMMAND-DIAG] Notification subscription error: ${error}`);
        } else {
          this.log('[COMMAND-DIAG] Subscribed to notifications');
          
          notifyChar.on('data', (data) => {
            this.log(`[COMMAND-DIAG] Device response: ${data.toString('hex')}`);
            // Parse response for authentication status
            if (data.length >= 7) {
              const cmdType = data[6];
              if (cmdType === 0x01) {
                this.log(`[COMMAND-DIAG] Login response received - device may be authenticated`);
              } else if (cmdType === 0x02) {
                this.log(`[COMMAND-DIAG] Heartbeat response received`);
              } else if (cmdType === 0x06) {
                this.log(`[COMMAND-DIAG] DP command response received - device acknowledged command`);
              }
            }
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

            // Wait before next command - longer for auth commands
            let delay = 300;
            if (commandIndex === 1 && testConfig.name.includes("Auth")) {
              delay = 1000; // Wait longer after login
            } else if (commandIndex === 2 && testConfig.name.includes("Auth")) {
              delay = 500; // Wait after heartbeat
            } else if (commandIndex >= testConfig.commands.length) {
              delay = testConfig.delay; // Final delay
            }
            
            setTimeout(sendNextCommand, delay);
          });
        } else {
          setTimeout(sendNextCommand, 100);
        }
      };

      sendNextCommand();
    };

    // Start the test sequence with a longer delay for encryption setup
    setTimeout(executeTest, 1000);
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

  executeWorkingSequence(writeChar, notifyChar, peripheral, cleanup, resolve, reject) {
    this.log('[DEBUG] Executing WORKING Fingerbot sequence...');
    
    // Generate session key for potential encryption
    this.generateSessionKey();
    
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
          });
        }
      });
    }

    // Execute the working press+release sequence (try encrypted first, then fallback)
    const executeSequence = () => {
      // Try encrypted commands first since device works with Tuya app
      const pressPacketEncrypted = this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01]), true);
      const releasePacketEncrypted = this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x00]), true);
      
      // Fallback to unencrypted
      const pressPacket = this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01]), false);
      const releasePacket = this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x00]), false);

      if (!pressPacketEncrypted || !releasePacketEncrypted) {
        sequenceComplete = true;
        clearTimeout(operationTimeout);
        cleanup();
        this.forceDisconnect();
        return reject(new Error('Failed to create encrypted command packets'));
      }

      this.log('[DEBUG] Sending ENCRYPTED press command...');
      writeChar.write(pressPacketEncrypted, true, (error) => {
        if (error) {
          this.log(`[DEBUG] Encrypted press command error: ${error}`);
          // Fallback to unencrypted
          this.log('[DEBUG] Trying unencrypted press command...');
          writeChar.write(pressPacket, true, (fallbackError) => {
            if (fallbackError) {
              this.log(`[DEBUG] Unencrypted press also failed: ${fallbackError}`);
            } else {
              this.log('[DEBUG] Unencrypted press command sent successfully');
            }
          });
        } else {
          this.log('[DEBUG] Encrypted press command sent successfully');
        }

        // Wait for press duration, then send release
        setTimeout(() => {
          if (sequenceComplete || peripheral.state !== 'connected') {
            return; // Already completed or disconnected
          }

          this.log('[DEBUG] Sending ENCRYPTED release command...');
          writeChar.write(releasePacketEncrypted, true, (error) => {
            if (error) {
              this.log(`[DEBUG] Encrypted release command error: ${error}`);
              // Fallback to unencrypted
              this.log('[DEBUG] Trying unencrypted release command...');
              writeChar.write(releasePacket, true, (fallbackError) => {
                if (fallbackError) {
                  this.log(`[DEBUG] Unencrypted release also failed: ${fallbackError}`);
                } else {
                  this.log('[DEBUG] Unencrypted release command sent successfully');
                }
              });
            } else {
              this.log('[DEBUG] Encrypted release command sent successfully');
            }

            // Complete the operation
            sequenceComplete = true;
            clearTimeout(operationTimeout);
            cleanup();
            
            setTimeout(() => {
              this.forceDisconnect();
              this.log('[DEBUG] Fingerbot operation completed successfully!');
              resolve();
            }, 500); // Brief delay before disconnect
          });
        }, this.pressTime);
      });
    };

    // Start the sequence with a delay to ensure notifications are set up
    setTimeout(executeSequence, 500);
  }
}