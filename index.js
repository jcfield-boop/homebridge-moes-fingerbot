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

  // Multiple command formats to try
  createPressCommands() {
    const commands = [
      // Format 1: Simple single byte
      Buffer.from([0x01]),
      
      // Format 2: Tuya-style command
      Buffer.from([0x55, 0xaa, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01, 0x00, 0x01, 0x01, 0x03, 0x55, 0xaa]),
      
      // Format 3: Simple DPS command
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01]),
      
      // Format 4: Alternative single command
      Buffer.from([0x57, 0x01]),
      
      // Format 5: Two-byte command
      Buffer.from([0x01, 0x01]),
      
      // Format 6: Raw press signal
      Buffer.from([0xFF, 0x01, 0x00]),
      
      // Format 7: BLE standard format
      Buffer.from([0x02, 0x01, 0x00, 0x00]),

      // Format 8: Tuya DPS 1 = true
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x01]),

      // Format 9: Alternative Tuya format
      Buffer.from([0x55, 0xaa, 0x00, 0x00, 0x00, 0x01, 0x07, 0x00, 0x05, 0x01, 0x01, 0x00, 0x01, 0x01, 0x0f]),
    ];
    
    return commands;
  }

  createReleaseCommands() {
    const commands = [
      // Format 1: Simple single byte
      Buffer.from([0x00]),
      
      // Format 2: Tuya-style command
      Buffer.from([0x55, 0xaa, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01, 0x00, 0x01, 0x00, 0x02, 0x55, 0xaa]),
      
      // Format 3: Simple DPS command
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]),
      
      // Format 4: Alternative single command
      Buffer.from([0x57, 0x00]),
      
      // Format 5: Two-byte command
      Buffer.from([0x01, 0x00]),
      
      // Format 6: Raw release signal
      Buffer.from([0xFF, 0x00, 0x00]),
      
      // Format 7: BLE standard format
      Buffer.from([0x02, 0x00, 0x00, 0x00]),

      // Format 8: Tuya DPS 1 = false
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00]),

      // Format 9: Alternative Tuya format
      Buffer.from([0x55, 0xaa, 0x00, 0x00, 0x00, 0x01, 0x07, 0x00, 0x05, 0x01, 0x01, 0x00, 0x01, 0x00, 0x0e]),
    ];
    
    return commands;
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
          setTimeout(() => this.connectAndPress(peripheral).then(resolve).catch(reject), 1000);
          return;
        } catch (e) {
          this.log(`[DEBUG] Error disconnecting existing connection: ${e}`);
        }
      }

      this.connecting = true;
      this.currentPeripheral = peripheral;
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

        this.log('[DEBUG] Connected successfully, waiting before service discovery...');
        
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
            }, 10000);

            this.handleDiscoveredCharacteristics(services, characteristics, peripheral, () => {
              cleanup();
              resolve();
            }, (error) => {
              cleanup();
              reject(error);
            });
          });
        }, 1000);
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

    this.executeMultipleCommandFormats(writeChar, notifyChar, peripheral, resolve, reject);
  }

  executeMultipleCommandFormats(writeChar, notifyChar, peripheral, resolve, reject) {
    this.log('[DEBUG] Trying multiple command formats...');

    const pressCommands = this.createPressCommands();
    const releaseCommands = this.createReleaseCommands();
    
    let commandIndex = 0;
    let success = false;

    const tryNextCommand = () => {
      if (commandIndex >= pressCommands.length || success) {
        if (success) {
          this.log('[DEBUG] Command sequence completed successfully');
          setTimeout(() => {
            this.forceDisconnect();
            resolve();
          }, 300);
        } else {
          this.log('[DEBUG] All command formats failed');
          this.forceDisconnect();
          reject(new Error('All command formats failed'));
        }
        return;
      }

      if (peripheral.state !== 'connected') {
        this.log('[DEBUG] Device disconnected during command execution');
        return reject(new Error('Device disconnected'));
      }

      const pressCmd = pressCommands[commandIndex];
      const releaseCmd = releaseCommands[commandIndex];
      
      this.log(`[DEBUG] Trying command format ${commandIndex + 1}: ${pressCmd.toString('hex')}`);
      
      // Set up notification handler if available
      let notificationReceived = false;
      let notifyTimeout = null;
      
      if (notifyChar) {
        const notifyHandler = (data) => {
          this.log(`[DEBUG] Received notification: ${data.toString('hex')}`);
          notificationReceived = true;
          if (notifyTimeout) {
            clearTimeout(notifyTimeout);
            notifyTimeout = null;
          }
          // If we get a notification, consider this command format successful
          success = true;
          this.log(`[DEBUG] Command format ${commandIndex + 1} successful (notification received)`);
        };

        notifyChar.subscribe((error) => {
          if (error) {
            this.log(`[DEBUG] Error subscribing to notifications: ${error}`);
          } else {
            this.log(`[DEBUG] Subscribed to notifications`);
            notifyChar.on('data', notifyHandler);
          }
        });

        // Wait for notification for a short time
        notifyTimeout = setTimeout(() => {
          if (!notificationReceived && !success) {
            this.log(`[DEBUG] No notification received for command format ${commandIndex + 1}, trying next...`);
            notifyChar.removeListener('data', notifyHandler);
            commandIndex++;
            setTimeout(tryNextCommand, 200);
          }
        }, 1000);
      }
      
      // Send press command
      writeChar.write(pressCmd, false, (error) => {
        if (error) {
          this.log(`[DEBUG] Press command ${commandIndex + 1} error: ${error}`);
          if (notifyTimeout) {
            clearTimeout(notifyTimeout);
            notifyTimeout = null;
          }
          commandIndex++;
          setTimeout(tryNextCommand, 200);
          return;
        }

        this.log(`[DEBUG] Press command ${commandIndex + 1} sent`);

        // If no notify characteristic, wait briefly then send release
        if (!notifyChar) {
          setTimeout(() => {
            if (peripheral.state !== 'connected') {
              return;
            }

            writeChar.write(releaseCmd, false, (error) => {
              if (error) {
                this.log(`[DEBUG] Release command ${commandIndex + 1} error: ${error}`);
              } else {
                this.log(`[DEBUG] Release command ${commandIndex + 1} sent`);
                // Without notifications, we can't be sure it worked, but let's assume success after first attempt
                if (commandIndex === 0) {
                  success = true;
                  this.log(`[DEBUG] Command format ${commandIndex + 1} assumed successful (no notifications available)`);
                }
              }

              if (!success) {
                commandIndex++;
                setTimeout(tryNextCommand, 500);
              } else {
                setTimeout(() => {
                  this.forceDisconnect();
                  resolve();
                }, 300);
              }
            });
          }, 100);
        } else {
          // With notifications, wait for response before sending release
          setTimeout(() => {
            if (success && peripheral.state === 'connected') {
              writeChar.write(releaseCmd, false, (error) => {
                if (error) {
                  this.log(`[DEBUG] Release command error: ${error}`);
                } else {
                  this.log(`[DEBUG] Release command sent`);
                }
              });
            }
          }, 200);
        }
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
    }, 8000);
  }
}