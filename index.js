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
    this.pressTime = config.pressTime || 3000;
    this.scanDuration = config.scanDuration || 5000;
    this.scanRetries = config.scanRetries || 3;
    this.scanRetryCooldown = config.scanRetryCooldown || 1000;

    // Tuya BLE configuration
    this.deviceId = config.deviceId;
    this.localKey = config.localKey;
    this.sequenceNumber = 0;
    this.sessionKey = null;
    this.isAuthenticated = false;

    this.isOn = false;
    this.batteryLevel = -1; // Unknown by default
    this.lastBatteryCheck = 0;
    this.batteryCheckInterval = (config.batteryCheckInterval || 60) * 60 * 1000;
    this.connecting = false;
    this.currentOperation = null; // Track current operation

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
      } else {
        this.log('Bluetooth adapter is powered off or unavailable');
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
      // Check if already processing
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
    // If batteryLevel is unknown, return 0 (HomeKit expects 0-100), or null if you want to indicate unknown
    callback(null, this.batteryLevel >= 0 && this.batteryLevel <= 100 ? this.batteryLevel : 0);
  }

  // Enhanced Tuya BLE encryption methods remain the same
  generateSessionKey() {
    if (!this.localKey || !this.deviceId) {
      this.log('[DEBUG] Missing localKey or deviceId for session key generation');
      return null;
    }

    try {
      const hash = crypto.createHash('md5');
      hash.update(this.localKey + this.deviceId);
      this.sessionKey = hash.digest();
      this.log(`[DEBUG] Generated session key: ${this.sessionKey.toString('hex')}`);
      return this.sessionKey;
    } catch (error) {
      this.log(`[DEBUG] Error generating session key: ${error}`);
      return null;
    }
  }

  encryptTuyaCommand(commandType, data = Buffer.alloc(0)) {
    if (!this.localKey) {
      this.log('[DEBUG] No localKey set, using raw command');
      return this.buildRawCommand(commandType, data);
    }

    try {
      this.sequenceNumber = (this.sequenceNumber + 1) & 0xFFFFFFFF;

      const header = Buffer.from([0x55, 0xaa]);
      const seqNum = Buffer.alloc(4);
      seqNum.writeUInt32BE(this.sequenceNumber, 0);
      const cmdType = Buffer.from([commandType]);
      const length = Buffer.alloc(2);
      length.writeUInt16BE(data.length + 8, 0);

      const payload = Buffer.concat([seqNum, cmdType, length, data]);
      
      let key;
      if (this.localKey.length === 32) {
        key = Buffer.from(this.localKey, 'hex');
      } else {
        key = Buffer.alloc(16);
        Buffer.from(this.localKey, 'utf8').copy(key);
      }

      const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
      cipher.setAutoPadding(true);
      const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);

      const checksum = this.calculateChecksum(Buffer.concat([header, encrypted]));
      const finalCommand = Buffer.concat([header, encrypted, Buffer.from([checksum])]);

      this.log(`[DEBUG] Encrypted command (type ${commandType}): ${finalCommand.toString('hex')}`);
      return finalCommand;

    } catch (error) {
      this.log(`[DEBUG] Encryption error: ${error}, falling back to raw command`);
      return this.buildRawCommand(commandType, data);
    }
  }

  buildRawCommand(commandType, data = Buffer.alloc(0)) {
    const header = Buffer.from([0x55, 0xaa]);
    const seqNum = Buffer.alloc(4);
    seqNum.writeUInt32BE(this.sequenceNumber++, 0);
    const cmdType = Buffer.from([commandType]);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(data.length, 0);
    
    const payload = Buffer.concat([header, seqNum, cmdType, length, data]);
    const checksum = this.calculateChecksum(payload);
    const finalCommand = Buffer.concat([payload, Buffer.from([checksum])]);
    
    this.log(`[DEBUG] Raw command (type ${commandType}): ${finalCommand.toString('hex')}`);
    return finalCommand;
  }

  calculateChecksum(buffer) {
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      sum += buffer[i];
    }
    return sum & 0xFF;
  }

  createAuthCommand() {
    if (!this.deviceId) {
      this.log('[DEBUG] No deviceId for authentication');
      return null;
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const authData = Buffer.alloc(12);
    authData.writeUInt32BE(timestamp, 0);
    Buffer.from(this.deviceId.substring(0, 8), 'utf8').copy(authData, 4);

    return this.encryptTuyaCommand(0x03, authData);
  }

  createStatusCommand() {
    return this.encryptTuyaCommand(0x08, Buffer.from([0x01, 0x01]));
  }

  createPressCommand() {
    return this.encryptTuyaCommand(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01]));
  }

  createReleaseCommand() {
    return this.encryptTuyaCommand(0x06, Buffer.from([0x01, 0x01, 0x00, 0x00]));
  }

  async pressButton() {
    return new Promise((resolve, reject) => {
      this.log('Scanning for Fingerbot...');

      let retryCount = 0;
      let scanTimeout = null;
      let peripheralFound = false;

      const discoverHandler = async (peripheral) => {
        if (peripheral.address === this.address && !peripheralFound) {
          peripheralFound = true;
          this.log(`Found Fingerbot: ${peripheral.address}`);
          
          // Stop scanning immediately
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

      // Clean up any existing listeners
      noble.removeAllListeners('discover');
      startScan();
    });
  }

  async connectAndPress(peripheral) {
    return new Promise((resolve, reject) => {
      this.log('Connecting to Fingerbot...');

      if (this.connecting) {
        this.log('[DEBUG] Already connecting, skipping new attempt.');
        return reject(new Error('Already connecting'));
      }
      this.connecting = true;

      // Reset authentication state
      this.isAuthenticated = false;
      this.sequenceNumber = 0;
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
        cleanup();
        reject(new Error('Device disconnected during operation'));
      };

      peripheral.once('disconnect', disconnectHandler);

      connectionTimeout = setTimeout(() => {
        this.log('[DEBUG] Connection timeout');
        cleanup();
        try {
          peripheral.disconnect();
        } catch (e) {
          this.log(`[DEBUG] Error disconnecting: ${e}`);
        }
        reject(new Error('Connection timeout'));
      }, 15000);

      peripheral.connect((error) => {
        if (error) {
          this.log(`[DEBUG] Connection error: ${error}`);
          cleanup();
          return reject(error);
        }

        this.log('[DEBUG] Connected, waiting before service discovery...');
        
        // Increased wait time for stability
        setTimeout(() => {
          if (peripheral.state !== 'connected') {
            this.log('[DEBUG] Device disconnected before service discovery');
            cleanup();
            return reject(new Error('Device disconnected before service discovery'));
          }

          this.log('[DEBUG] Starting broad service discovery...');
          
          // Use broad discovery first
          peripheral.discoverAllServicesAndCharacteristics((error, services, characteristics) => {
            if (error) {
              this.log(`[DEBUG] Service discovery error: ${error}`);
              cleanup();
              try {
                peripheral.disconnect();
              } catch (e) {
                this.log(`[DEBUG] Error disconnecting: ${e}`);
              }
              return reject(error);
            }

            if (peripheral.state !== 'connected') {
              this.log('[DEBUG] Device disconnected during service discovery');
              cleanup();
              return reject(new Error('Device disconnected during service discovery'));
            }

            clearTimeout(connectionTimeout);
            connectionTimeout = setTimeout(() => {
              this.log('[DEBUG] Operation timeout');
              cleanup();
              try {
                peripheral.disconnect();
              } catch (e) {
                this.log(`[DEBUG] Error disconnecting: ${e}`);
              }
              reject(new Error('Operation timeout'));
            }, 10000);

            this.handleDiscoveredCharacteristics(services, characteristics, peripheral, () => {
              cleanup();
              resolve();
            }, (error) => {
              cleanup();
              reject(error);
            });
          });
        }, 2000); // Increased delay for stability
      });
    });
  }

  handleDiscoveredCharacteristics(services, characteristics, peripheral, resolve, reject) {
    this.log(`[DEBUG] Discovered ${services?.length || 0} services, ${characteristics?.length || 0} characteristics`);
    
    if (services) {
      services.forEach(service => {
        this.log(`[DEBUG] Service: ${service.uuid}`);
      });
    }

    if (!characteristics || characteristics.length === 0) {
      this.log('[DEBUG] No characteristics found');
      try {
        peripheral.disconnect();
      } catch (e) {
        this.log(`[DEBUG] Error disconnecting: ${e}`);
      }
      return reject(new Error('No characteristics found'));
    }

    characteristics.forEach(char => {
      this.log(`[DEBUG] Characteristic: ${char.uuid}, properties: ${JSON.stringify(char.properties)}`);
    });

    // Look for Tuya-specific characteristics
    const writeChar = characteristics.find(char => 
      (char.uuid === '2b11' || char.uuid === '00002b11' || 
       char.uuid === 'fff1' || char.uuid === '0000fff1') && 
      (char.properties.includes('write') || char.properties.includes('writeWithoutResponse'))
    ) || characteristics.find(char => 
      char.properties.includes('write') || char.properties.includes('writeWithoutResponse')
    );

    const notifyChar = characteristics.find(char => 
      (char.uuid === '2b10' || char.uuid === '00002b10' || 
       char.uuid === 'fff2' || char.uuid === '0000fff2') && 
      char.properties.includes('notify')
    ) || characteristics.find(char => 
      char.properties.includes('notify')
    );

    if (!writeChar) {
      this.log('[DEBUG] No writable characteristic found');
      try {
        peripheral.disconnect();
      } catch (e) {
        this.log(`[DEBUG] Error disconnecting: ${e}`);
      }
      return reject(new Error('No writable characteristic found'));
    }

    this.log(`[DEBUG] Using write characteristic: ${writeChar.uuid}`);
    if (notifyChar) {
      this.log(`[DEBUG] Using notify characteristic: ${notifyChar.uuid}`);
    }

    this.executeSequence(writeChar, notifyChar, peripheral, resolve, reject);
  }

  executeSequence(writeChar, notifyChar, peripheral, resolve, reject) {
    // Set up notifications if available
    if (notifyChar) {
      notifyChar.on('data', (data, isNotification) => {
        this.log(`[DEBUG] Notification: ${data.toString('hex')}`);
        this.handleNotification(data);
      });

      notifyChar.subscribe((err) => {
        if (err) {
          this.log(`[DEBUG] Failed to subscribe to notifications: ${err}`);
        } else {
          this.log('[DEBUG] Subscribed to notifications');
        }
        this.startCommandSequence(writeChar, peripheral, resolve, reject);
      });
    } else {
      this.log('[DEBUG] No notification characteristic, proceeding without notifications');
      this.startCommandSequence(writeChar, peripheral, resolve, reject);
    }
  }

  startCommandSequence(writeChar, peripheral, resolve, reject) {
    // Check connection state
    if (peripheral.state !== 'connected') {
      this.log('[DEBUG] Device disconnected before sending commands');
      return reject(new Error('Device disconnected'));
    }

    // Generate session key
    this.generateSessionKey();

    // For simple operation, just send press and release commands
    const sendPress = () => {
      const pressCmd = this.createPressCommand();
      this.log('[DEBUG] Sending press command...');
      
      writeChar.write(pressCmd, false, (error) => {
        if (error) {
          this.log(`[DEBUG] Press command error: ${error}`);
          try {
            peripheral.disconnect();
          } catch (e) {
            this.log(`[DEBUG] Error disconnecting: ${e}`);
          }
          return reject(error);
        }

        this.log('[DEBUG] Press command sent, waiting for release...');

        // Send release command after delay
        setTimeout(() => {
          if (peripheral.state !== 'connected') {
            this.log('[DEBUG] Device disconnected before release');
            return resolve(); // Still consider it successful if press was sent
          }

          const releaseCmd = this.createReleaseCommand();
          this.log('[DEBUG] Sending release command...');
          
          writeChar.write(releaseCmd, false, (error) => {
            if (error) {
              this.log(`[DEBUG] Release command error: ${error}`);
            } else {
              this.log('[DEBUG] Release command sent, sequence complete');
            }

            setTimeout(() => {
              try {
                peripheral.disconnect();
              } catch (e) {
                this.log(`[DEBUG] Error disconnecting: ${e}`);
              }
              resolve();
            }, 500);
          });
        }, this.pressTime);
      });
    };

    // Try authentication first if configured
    if (this.deviceId && this.localKey) {
      const authCmd = this.createAuthCommand();
      if (authCmd) {
        this.log('[DEBUG] Sending authentication command...');
        writeChar.write(authCmd, false, (error) => {
          if (error) {
            this.log(`[DEBUG] Auth command error: ${error}, proceeding anyway`);
          } else {
            this.log('[DEBUG] Auth command sent');
          }
          setTimeout(sendPress, 500);
        });
      } else {
        sendPress();
      }
    } else {
      sendPress();
    }
  }

  handleNotification(data) {
    try {
      if (data.length >= 2 && data[0] === 0x55 && data[1] === 0xaa) {
        this.log('[DEBUG] Processing Tuya notification');
        let found = false;
        if (data.length > 6) {
          for (let i = 2; i < data.length - 1; i++) {
            const value = data[i];
            if (value > 0 && value <= 100) {
              this.log(`[DEBUG] Potential battery level at position ${i}: ${value}%`);
              // Only update if it's a plausible change or if batteryLevel is unknown
              if (
                this.batteryLevel === -1 ||
                (value <= 100 && value > this.batteryLevel - 20 && value < this.batteryLevel + 20)
              ) {
                this.batteryLevel = value;
                this.batteryService.updateCharacteristic(Characteristic.BatteryLevel, value);
                found = true;
                break;
              }
            }
          }
        }
        if (!found && this.batteryLevel === -1) {
          this.log('[DEBUG] Battery level still unknown');
        }
      }
    } catch (error) {
      this.log(`[DEBUG] Error processing notification: ${error}`);
    }
  }
}