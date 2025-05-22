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

    // Optional configuration
    this.pressTime = config.pressTime || 1000; // Reduced from 3000ms
    this.scanDuration = config.scanDuration || 5000;
    this.scanRetries = config.scanRetries || 3;
    this.scanRetryCooldown = config.scanRetryCooldown || 1000;
    this.batteryCheckInterval = (config.batteryCheckInterval || 60) * 60 * 1000;

    // Tuya BLE protocol state
    this.sequenceNumber = Math.floor(Math.random() * 0xFFFF); // Start with random seq
    this.sessionKey = null;
    this.isAuthenticated = false;

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
        setTimeout(() => {
          this.validateDeviceOnStartup();
        }, 2000);
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
      this.log(`[DEBUG] (Battery) Polled device for battery level: ${this.batteryLevel}`);
    } else {
      this.log(`[DEBUG] (Battery) Returning cached battery level: ${this.batteryLevel}`);
    }
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
    this.isAuthenticated = false;
    this.sessionKey = null;
  }

  // Tuya BLE protocol implementation
  generateSessionKey() {
    if (!this.localKey || !this.deviceId) {
      this.log('[DEBUG] Missing localKey or deviceId for session key generation');
      return null;
    }

    try {
      // Convert localKey to buffer - ensure it's exactly 16 bytes
      let keyBuffer;
      if (this.localKey.length === 32) {
        // Hex string
        keyBuffer = Buffer.from(this.localKey, 'hex');
      } else {
        // UTF8 string - pad or truncate to 16 bytes
        keyBuffer = Buffer.from(this.localKey, 'utf8');
        if (keyBuffer.length > 16) {
          keyBuffer = keyBuffer.slice(0, 16);
        } else if (keyBuffer.length < 16) {
          const padded = Buffer.alloc(16);
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

  // Fixed Tuya BLE packet creation based on working Python implementation
  createTuyaBLEPacket(commandType, data = Buffer.alloc(0)) {
    try {
      this.sequenceNumber = (this.sequenceNumber + 1) & 0xFFFF;
      
      // Tuya BLE packet format for Fingerbot Plus:
      // [0x55, 0xaa] [seq(2, BE)] [cmd(1)] [len(2, BE)] [data] [checksum(1)]
      const header = Buffer.from([0x55, 0xaa]);
      
      // Sequence number (2 bytes, big endian)
      const seqBuffer = Buffer.alloc(2);
      seqBuffer.writeUInt16BE(this.sequenceNumber, 0);
      
      // Command type (1 byte)
      const cmdBuffer = Buffer.from([commandType]);
      
      // Data length (2 bytes, big endian)
      const lengthBuffer = Buffer.alloc(2);
      lengthBuffer.writeUInt16BE(data.length, 0);
      
      // Build payload
      const payload = Buffer.concat([seqBuffer, cmdBuffer, lengthBuffer, data]);
      
      // Calculate checksum (sum of all bytes except checksum itself)
      const preChecksumData = Buffer.concat([header, payload]);
      let checksum = 0;
      for (let i = 0; i < preChecksumData.length; i++) {
        checksum = (checksum + preChecksumData[i]) & 0xFF;
      }
      
      // Final packet
      const packet = Buffer.concat([header, payload, Buffer.from([checksum])]);
      
      this.log(`[DEBUG] Tuya BLE packet (cmd 0x${commandType.toString(16)}): ${packet.toString('hex')}`);
      return packet;
      
    } catch (error) {
      this.log(`[DEBUG] Error creating Tuya BLE packet: ${error}`);
      return null;
    }
  }

  // Create direct press command for Fingerbot Plus (no auth needed)
  createDirectPressCommand() {
    // Direct command to trigger fingerbot press
    // Based on successful Python implementation
    return this.createTuyaBLEPacket(0x04, Buffer.from([0x01]));
  }

  // Create simple DP command for switch
  createDPCommand(dpId, dpType, value) {
    // DP command format: [dp_id(1)] [dp_type(1)] [dp_len(2)] [dp_value(...)]
    let valueBuffer;
    let dataLength;
    
    if (dpType === 0x01) { // BOOL
      valueBuffer = Buffer.from([value ? 0x01 : 0x00]);
      dataLength = 1;
    } else if (dpType === 0x02) { // INT
      valueBuffer = Buffer.alloc(4);
      valueBuffer.writeUInt32BE(value, 0);
      dataLength = 4;
    } else {
      valueBuffer = Buffer.from([value]);
      dataLength = 1;
    }
    
    const dpData = Buffer.concat([
      Buffer.from([dpId]),                    // DP ID
      Buffer.from([dpType]),                  // DP Type  
      Buffer.from([0x00, dataLength]),        // Data length (2 bytes, BE)
      valueBuffer                             // Value
    ]);
    
    return this.createTuyaBLEPacket(0x06, dpData);
  }

  // Create status query
  createStatusQuery() {
    return this.createTuyaBLEPacket(0x08, Buffer.alloc(0));
  }

  async pressButton() {
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
            this.log(`Scan attempt ${retryCount} failed, retrying...`);
            setTimeout(startScan, this.scanRetryCooldown);
          } else if (!peripheralFound) {
            reject(new Error('Failed to find Fingerbot device after multiple attempts'));
          }
        }, this.scanDuration);
      };

      startScan();
    });
  }

  async connectAndPress(peripheral) {
    return new Promise((resolve, reject) => {
      this.log('Connecting to Fingerbot...');

      if (this.connecting) {
        return reject(new Error('Already connecting'));
      }

      if (peripheral.state === 'connected') {
        this.log('[DEBUG] Peripheral already connected, disconnecting first...');
        try {
          peripheral.disconnect();
          setTimeout(() => this.connectAndPress(peripheral).then(resolve).catch(reject), 1000);
          return;
        } catch (e) {
          this.log(`[DEBUG] Error disconnecting existing connection: ${e}`);
        }
      }

      this.connecting = true;
      this.currentPeripheral = peripheral;
      this.isAuthenticated = false;
      this.sessionKey = null;

      let connectionTimeout = null;
      let disconnectHandler = null;

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
        this.log('[DEBUG] Peripheral disconnected');
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
      }, 15000);

      peripheral.connect((error) => {
        if (error) {
          this.log(`[DEBUG] Connection error: ${error}`);
          cleanup();
          this.currentPeripheral = null;
          return reject(error);
        }

        this.log('[DEBUG] Connected, discovering services...');
        
        // Immediate service discovery
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

          // Find the correct characteristics
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

          this.executeFingerbot(writeChar, notifyChar, peripheral, cleanup, resolve, reject);
        });
      });
    });
  }

  executeFingerbot(writeChar, notifyChar, peripheral, cleanup, resolve, reject) {
    this.log('[DEBUG] Starting simplified Fingerbot command sequence...');
    
    let operationTimeout = null;
    let notificationReceived = false;
    let commandSent = false;

    // Set overall operation timeout (reduced to 8 seconds)
    operationTimeout = setTimeout(() => {
      this.log('[DEBUG] Overall operation timeout');
      cleanup();
      this.forceDisconnect();
      reject(new Error('Operation timeout'));
    }, 8000);

    // Set up notifications if available
    if (notifyChar) {
      notifyChar.subscribe((error) => {
        if (error) {
          this.log(`[DEBUG] Notification subscription error: ${error}`);
          // Continue without notifications
          this.sendCommandSequence();
        } else {
          this.log('[DEBUG] Subscribed to notifications');
          
          notifyChar.on('data', (data) => {
            this.log(`[DEBUG] Notification received: ${data.toString('hex')}`);
            notificationReceived = true;
            this.parseNotificationData(data);
            
            // If we haven't sent commands yet, do it now
            if (!commandSent) {
              setTimeout(() => this.sendCommandSequence(), 100);
            }
          });
          
          // Send initial ping to wake device
          setTimeout(() => {
            if (!notificationReceived && !commandSent) {
              this.log('[DEBUG] No initial response, proceeding with commands anyway...');
              this.sendCommandSequence();
            }
          }, 1000);
        }
      });
    } else {
      // No notifications available, proceed directly
      setTimeout(() => this.sendCommandSequence(), 200);
    }

    const that = this;
    
    function sendCommandSequence() {
      if (commandSent) return;
      commandSent = true;
      
      that.log('[DEBUG] Sending command sequence...');
      
      // Try multiple command approaches
      const commands = [
        // Approach 1: Direct press command
        () => {
          that.log('[DEBUG] Trying direct press command...');
          const packet = that.createDirectPressCommand();
          return packet;
        },
        
        // Approach 2: DP switch command (ON)
        () => {
          that.log('[DEBUG] Trying DP switch ON command...');
          const packet = that.createDPCommand(0x01, 0x01, true); // DP1, BOOL, true
          return packet;
        },
        
        // Approach 3: DP switch command (OFF) after delay
        () => {
          that.log('[DEBUG] Trying DP switch OFF command...');
          const packet = that.createDPCommand(0x01, 0x01, false); // DP1, BOOL, false
          return packet;
        }
      ];
      
      let commandIndex = 0;
      
      const sendNextCommand = () => {
        if (commandIndex >= commands.length) {
          that.log('[DEBUG] All commands sent, completing operation...');
          clearTimeout(operationTimeout);
          cleanup();
          setTimeout(() => that.forceDisconnect(), 100);
          resolve();
          return;
        }
        
        const packet = commands[commandIndex]();
        if (packet) {
          writeChar.write(packet, true, (error) => { // writeWithoutResponse = true
            if (error) {
              that.log(`[DEBUG] Error sending command ${commandIndex}: ${error}`);
            } else {
              that.log(`[DEBUG] Command ${commandIndex} sent successfully`);
            }
            
            commandIndex++;
            
            // Wait between commands (longer for press duration)
            const delay = commandIndex === 2 ? that.pressTime : 300;
            setTimeout(sendNextCommand, delay);
          });
        } else {
          commandIndex++;
          setTimeout(sendNextCommand, 100);
        }
      };
      
      sendNextCommand();
    }
    
    // Bind the function to this context
    this.sendCommandSequence = sendCommandSequence;
  }

  parseNotificationData(data) {
    try {
      if (data.length >= 8) {
        // Basic Tuya BLE response parsing
        const header = data.readUInt16BE(0);
        if (header === 0x55aa || header === 0xaa55) {
          const cmdType = data[5]; // Command type usually at offset 5
          this.log(`[DEBUG] Response command type: 0x${cmdType.toString(16)}`);
          
          // Look for battery level in status responses
          if (cmdType === 0x08 && data.length > 10) {
            // Try to extract battery level from status response
            for (let i = 6; i < data.length - 2; i++) {
              if (data[i] === 0x02) { // DP ID 2 might be battery
                const dpType = data[i + 1];
                if (dpType === 0x02 && i + 5 < data.length) { // INTEGER type
                  const batteryLevel = data.readUInt32BE(i + 2) & 0xFF;
                  if (batteryLevel <= 100) {
                    this.batteryLevel = batteryLevel;
                    this.log(`[DEBUG] Battery level updated: ${batteryLevel}%`);
                    this.batteryService.updateCharacteristic(Characteristic.BatteryLevel, batteryLevel);
                  }
                }
              }
            }
          }
        }
      }
    } catch (error) {
      this.log(`[DEBUG] Error parsing notification: ${error}`);
    }
  }

  async validateDeviceOnStartup() {
    this.log('[DEBUG] Starting initial scan to validate Fingerbot services...');
    let found = false;
    let scanTimeout = null;

    const discoverHandler = async (peripheral) => {
      if (peripheral.address === this.address && !found) {
        found = true;
        noble.removeListener('discover', discoverHandler);
        this.log(`[DEBUG] [Startup] Found Fingerbot: ${peripheral.address}`);
        
        try {
          noble.stopScanning();
        } catch (e) {}
        clearTimeout(scanTimeout);

        peripheral.connect((error) => {
          if (error) {
            this.log(`[DEBUG] [Startup] Connection error: ${error}`);
            return;
          }
          
          this.log('[DEBUG] [Startup] Connected, discovering services...');
          peripheral.discoverAllServicesAndCharacteristics((err, services, characteristics) => {
            if (err) {
              this.log(`[DEBUG] [Startup] Service discovery error: ${err}`);
            } else {
              this.log(`[DEBUG] [Startup] Discovered ${services.length} services, ${characteristics.length} characteristics`);
              services.forEach(s => this.log(`[DEBUG] [Startup] Service: ${s.uuid}`));
              characteristics.forEach(c => this.log(`[DEBUG] [Startup] Characteristic: ${c.uuid}, properties: ${JSON.stringify(c.properties)}`));
              
              // Try to read device info if available
              const deviceNameChar = characteristics.find(c => c.uuid === '2a00');
              if (deviceNameChar) {
                deviceNameChar.read((err, data) => {
                  if (!err && data) {
                    this.log(`[DEBUG] [Startup] Device name: ${data.toString()}`);
                  }
                });
              }
            }
            
            setTimeout(() => {
              peripheral.disconnect();
            }, 500);
          });
        });

        peripheral.once('disconnect', () => {
          this.log('[DEBUG] [Startup] Peripheral disconnected');
        });
      }
    };

    noble.on('discover', discoverHandler);

    try {
      noble.startScanning([], true);
    } catch (e) {
      this.log(`[DEBUG] [Startup] Error starting scan: ${e}`);
      noble.removeListener('discover', discoverHandler);
      return;
    }

    scanTimeout = setTimeout(() => {
      try {
        noble.stopScanning();
      } catch (e) {}
      noble.removeListener('discover', discoverHandler);
      if (!found) {
        this.log('[DEBUG] [Startup] Could not find Fingerbot during initial scan');
      }
    }, 8000);
  }
}