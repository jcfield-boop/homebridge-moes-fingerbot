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
    this.scanDuration = config.advanced?.scanDuration || config.scanDuration || 8000; // Increased
    this.scanRetries = config.advanced?.scanRetries || config.scanRetries || 3;
    this.scanRetryCooldown = config.advanced?.scanRetryCooldown || config.scanRetryCooldown || 2000; // Increased
    this.batteryCheckInterval = (config.advanced?.batteryCheckInterval || config.batteryCheckInterval || 60) * 60 * 1000;

    this.sequenceNumber = 0;
    this.sessionKey = null;
    this.isAuthenticated = false;

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
  }

  // Try multiple command formats for different Fingerbot variants
  createPressCommands() {
    const commands = [
      // Format 1: Simple byte command
      Buffer.from([0x01]),
      
      // Format 2: Original format with header
      this.buildRawCommand(0x06, Buffer.from([0x01])),
      
      // Format 3: Alternative Tuya format
      Buffer.from([0x55, 0xaa, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01, 0x01]),
      
      // Format 4: Simple press command
      Buffer.from([0x57, 0x01]),
      
      // Format 5: Another variant
      Buffer.from([0x50, 0x01, 0x01]),
      
      // Format 6: Hex command often used
      Buffer.from([0xA0, 0x01]),
    ];
    
    return commands;
  }

  createReleaseCommands() {
    const commands = [
      // Format 1: Simple byte command
      Buffer.from([0x00]),
      
      // Format 2: Original format with header
      this.buildRawCommand(0x06, Buffer.from([0x00])),
      
      // Format 3: Alternative Tuya format
      Buffer.from([0x55, 0xaa, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01, 0x00]),
      
      // Format 4: Simple release command
      Buffer.from([0x57, 0x00]),
      
      // Format 5: Another variant
      Buffer.from([0x50, 0x01, 0x00]),
      
      // Format 6: Hex command often used
      Buffer.from([0xA0, 0x00]),
    ];
    
    return commands;
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
    
    return finalCommand;
  }

  calculateChecksum(buffer) {
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      sum += buffer[i];
    }
    return sum & 0xFF;
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
        this.log('[DEBUG] Already connecting, skipping new attempt.');
        return reject(new Error('Already connecting'));
      }

      if (peripheral.state === 'connected') {
        this.log('[DEBUG] Peripheral already connected, disconnecting first...');
        try {
          peripheral.disconnect();
          setTimeout(() => this.connectAndPress(peripheral).then(resolve).catch(reject), 2000);
          return;
        } catch (e) {
          this.log(`[DEBUG] Error disconnecting existing connection: ${e}`);
        }
      }

      this.connecting = true;
      this.currentPeripheral = peripheral;
      this.isAuthenticated = false;
      this.sequenceNumber = 0;

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
        this.log('[DEBUG] Peripheral disconnected unexpectedly');
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
      }, 20000); // Increased timeout

      peripheral.connect((error) => {
        if (error) {
          this.log(`[DEBUG] Connection error: ${error}`);
          cleanup();
          this.currentPeripheral = null;
          return reject(error);
        }

        this.log('[DEBUG] Connected successfully, waiting before service discovery...');
        
        // Longer wait to ensure device is ready
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

            // Extend timeout for operation
            clearTimeout(connectionTimeout);
            connectionTimeout = setTimeout(() => {
              this.log('[DEBUG] Operation timeout');
              cleanup();
              this.forceDisconnect();
              reject(new Error('Operation timeout'));
            }, 15000);

            this.handleDiscoveredCharacteristics(services, characteristics, peripheral, () => {
              cleanup();
              resolve();
            }, (error) => {
              cleanup();
              reject(error);
            });
          });
        }, 2000); // Longer delay
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

    this.tryMultipleCommandFormats(writeChar, notifyChar, peripheral, resolve, reject);
  }

  tryMultipleCommandFormats(writeChar, notifyChar, peripheral, resolve, reject) {
    this.log('[DEBUG] Trying multiple command formats...');

    const pressCommands = this.createPressCommands();
    const releaseCommands = this.createReleaseCommands();
    
    let commandIndex = 0;

    const tryNextCommand = () => {
      if (commandIndex >= pressCommands.length) {
        this.log('[DEBUG] All command formats failed');
        this.forceDisconnect();
        return reject(new Error('All command formats failed'));
      }

      if (peripheral.state !== 'connected') {
        this.log('[DEBUG] Device disconnected before sending commands');
        return reject(new Error('Device disconnected'));
      }

      const pressCmd = pressCommands[commandIndex];
      const releaseCmd = releaseCommands[commandIndex];
      
      this.log(`[DEBUG] Trying command format ${commandIndex + 1}: ${pressCmd.toString('hex')}`);
      
      writeChar.write(pressCmd, false, (error) => {
        if (error) {
          this.log(`[DEBUG] Command format ${commandIndex + 1} failed: ${error}`);
          commandIndex++;
          setTimeout(tryNextCommand, 500);
          return;
        }

        this.log(`[DEBUG] Command format ${commandIndex + 1} sent successfully`);

        // Wait then send release command
        setTimeout(() => {
          if (peripheral.state !== 'connected') {
            this.log('[DEBUG] Device disconnected before release');
            return resolve(); // Consider successful if press was sent
          }

          writeChar.write(releaseCmd, false, (error) => {
            if (error) {
              this.log(`[DEBUG] Release command error: ${error}`);
            } else {
              this.log(`[DEBUG] Release command sent, sequence complete`);
            }

            // Disconnect after brief delay
            setTimeout(() => {
              this.forceDisconnect();
              resolve();
            }, 500);
          });
        }, 200);
      });
    };

    tryNextCommand();
  }

  async validateDeviceOnStartup() {
    this.log('[DEBUG] Starting initial scan to validate Fingerbot services...');
    let found = false;
    let scanTimeout = null;

    const discoverHandler = async (peripheral) => {
      if (peripheral.address === this.address && !found) {
        found = true;
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
            }
            peripheral.disconnect();
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
      noble.stopScanning();
      noble.removeListener('discover', discoverHandler);
      if (!found) {
        this.log('[DEBUG] [Startup] Could not find Fingerbot during initial scan');
      }
    }, 10000);
  }
}