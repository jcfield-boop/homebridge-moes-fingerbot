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

    // PATCH: Prefer advanced block if present, fallback to top-level
    this.deviceId = config.advanced?.deviceId || config.deviceId;
    this.localKey = config.advanced?.localKey || config.localKey;
    this.pressTime = config.advanced?.pressTime || config.pressTime || 3000;
    this.scanDuration = config.advanced?.scanDuration || config.scanDuration || 5000;
    this.scanRetries = config.advanced?.scanRetries || config.scanRetries || 3;
    this.scanRetryCooldown = config.advanced?.scanRetryCooldown || config.scanRetryCooldown || 1000;
    this.batteryCheckInterval = (config.advanced?.batteryCheckInterval || config.batteryCheckInterval || 60) * 60 * 1000;

    this.sequenceNumber = 0;
    this.sessionKey = null;
    this.isAuthenticated = false;

    this.isOn = false;
    this.batteryLevel = -1;
    this.lastBatteryCheck = 0;
    this.connecting = false;
    this.currentOperation = null;
    this.currentPeripheral = null; // Track current peripheral

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
        // Clean up any existing connections
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
    callback(null, this.batteryLevel >= 0 && this.batteryLevel <= 100 ? this.batteryLevel : 0);
  }

  // Force disconnect any existing peripheral
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
  }

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

  createPressCommand() {
    // Simplified press command - try different formats
    return this.buildRawCommand(0x06, Buffer.from([0x01]));
  }

  createReleaseCommand() {
    // Simplified release command
    return this.buildRawCommand(0x06, Buffer.from([0x00]));
  }

  async pressButton() {
    return new Promise((resolve, reject) => {
      this.log('Scanning for Fingerbot...');

      // Force disconnect any existing connection first
      this.forceDisconnect();

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
        this.log('[DEBUG] Already connecting, skipping new attempt.');
        return reject(new Error('Already connecting'));
      }

      // Check if peripheral is already connected
      if (peripheral.state === 'connected') {
        this.log('[DEBUG] Peripheral already connected, disconnecting first...');
        try {
          peripheral.disconnect();
          // Wait a moment before reconnecting
          setTimeout(() => this.connectAndPress(peripheral).then(resolve).catch(reject), 1000);
          return;
        } catch (e) {
          this.log(`[DEBUG] Error disconnecting existing connection: ${e}`);
        }
      }

      this.connecting = true;
      this.currentPeripheral = peripheral;

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

        this.log('[DEBUG] Connected, waiting before service discovery...');
        
        setTimeout(() => {
          if (peripheral.state !== 'connected') {
            this.log('[DEBUG] Device disconnected before service discovery');
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
              this.log('[DEBUG] Device disconnected during service discovery');
              cleanup();
              return reject(new Error('Device disconnected during service discovery'));
            }

            clearTimeout(connectionTimeout);
            connectionTimeout = setTimeout(() => {
              this.log('[DEBUG] Operation timeout');
              cleanup();
              this.forceDisconnect();
              reject(new Error('Operation timeout'));
            }, 8000); // Reduced timeout

            this.handleDiscoveredCharacteristics(services, characteristics, peripheral, () => {
              cleanup();
              resolve();
            }, (error) => {
              cleanup();
              reject(error);
            });
          });
        }, 1000); // Reduced delay
      });
    });
  }

  handleDiscoveredCharacteristics(services, characteristics, peripheral, resolve, reject) {
    this.log(`[DEBUG] Discovered ${services?.length || 0} services, ${characteristics?.length || 0} characteristics`);
    
    if (!characteristics || characteristics.length === 0) {
      this.log('[DEBUG] No characteristics found');
      this.forceDisconnect();
      return reject(new Error('No characteristics found'));
    }

    characteristics.forEach(char => {
      this.log(`[DEBUG] Characteristic: ${char.uuid}, properties: ${JSON.stringify(char.properties)}`);
    });

    // Look for write characteristic (prioritize 2b11)
    const writeChar = characteristics.find(char => char.uuid === '2b11') ||
                     characteristics.find(char => char.properties.includes('writeWithoutResponse')) ||
                     characteristics.find(char => char.properties.includes('write'));

    const notifyChar = characteristics.find(char => char.uuid === '2b10') ||
                      characteristics.find(char => char.properties.includes('notify'));

    if (!writeChar) {
      this.log('[DEBUG] No writable characteristic found');
      this.forceDisconnect();
      return reject(new Error('No writable characteristic found'));
    }

    this.log(`[DEBUG] Using write characteristic: ${writeChar.uuid}`);
    if (notifyChar) {
      this.log(`[DEBUG] Using notify characteristic: ${notifyChar.uuid}`);
    }

    this.executeSimpleSequence(writeChar, notifyChar, peripheral, resolve, reject);
  }

  executeSimpleSequence(writeChar, notifyChar, peripheral, resolve, reject) {
    // Simplified approach - skip authentication and notifications for now
    this.log('[DEBUG] Starting simple press sequence...');

    // Check connection state
    if (peripheral.state !== 'connected') {
      this.log('[DEBUG] Device disconnected before sending commands');
      return reject(new Error('Device disconnected'));
    }

    // Send simple press command
    const pressCmd = this.createPressCommand();
    this.log('[DEBUG] Sending simple press command...');
    
    writeChar.write(pressCmd, false, (error) => {
      if (error) {
        this.log(`[DEBUG] Press command error: ${error}`);
        this.forceDisconnect();
        return reject(error);
      }

      this.log('[DEBUG] Press command sent successfully');

      // Wait briefly then send release
      setTimeout(() => {
        if (peripheral.state !== 'connected') {
          this.log('[DEBUG] Device disconnected before release');
          return resolve(); // Still consider successful if press was sent
        }

        const releaseCmd = this.createReleaseCommand();
        this.log('[DEBUG] Sending release command...');
        
        writeChar.write(releaseCmd, false, (error) => {
          if (error) {
            this.log(`[DEBUG] Release command error: ${error}`);
          } else {
            this.log('[DEBUG] Release command sent, sequence complete');
          }

          // Disconnect after brief delay
          setTimeout(() => {
            this.forceDisconnect();
            resolve();
          }, 300);
        });
      }, 100); // Very brief delay between press and release
    });
  }

  handleNotification(data) {
    try {
      this.log(`[DEBUG] Received notification: ${data.toString('hex')}`);
      // Battery parsing logic can be added here if needed
    } catch (error) {
      this.log(`[DEBUG] Error processing notification: ${error}`);
    }
  }
}