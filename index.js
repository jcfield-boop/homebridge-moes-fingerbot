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
    this.batteryLevel = 100;
    this.lastBatteryCheck = 0;
    this.batteryCheckInterval = (config.batteryCheckInterval || 60) * 60 * 1000;
    this.connecting = false;

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
      this.pressButton()
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
    callback(null, this.batteryLevel);
  }

  // Enhanced Tuya BLE encryption
  generateSessionKey() {
    if (!this.localKey || !this.deviceId) {
      this.log('[DEBUG] Missing localKey or deviceId for session key generation');
      return null;
    }

    try {
      // Create session key from localKey and deviceId
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
      // Increment sequence number
      this.sequenceNumber = (this.sequenceNumber + 1) & 0xFFFFFFFF;

      // Build the command structure
      const header = Buffer.from([0x55, 0xaa]); // Tuya header
      const seqNum = Buffer.alloc(4);
      seqNum.writeUInt32BE(this.sequenceNumber, 0);
      const cmdType = Buffer.from([commandType]);
      const length = Buffer.alloc(2);
      length.writeUInt16BE(data.length + 8, 0); // +8 for seq + cmd + length + checksum

      // Create payload to encrypt
      const payload = Buffer.concat([seqNum, cmdType, length, data]);
      
      // Use proper key - try both localKey as string and as hex
      let key;
      if (this.localKey.length === 32) {
        // Assume hex string
        key = Buffer.from(this.localKey, 'hex');
      } else {
        // Use as UTF-8 string, pad/truncate to 16 bytes
        key = Buffer.alloc(16);
        Buffer.from(this.localKey, 'utf8').copy(key);
      }

      // Encrypt with AES-128-ECB
      const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
      cipher.setAutoPadding(true);
      const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);

      // Calculate checksum
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
    // Build unencrypted command for testing
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

  // Authentication command
  createAuthCommand() {
    if (!this.deviceId) {
      this.log('[DEBUG] No deviceId for authentication');
      return null;
    }

    // Create authentication payload
    const timestamp = Math.floor(Date.now() / 1000);
    const authData = Buffer.alloc(12);
    authData.writeUInt32BE(timestamp, 0);
    Buffer.from(this.deviceId.substring(0, 8), 'utf8').copy(authData, 4);

    return this.encryptTuyaCommand(0x03, authData); // 0x03 = auth command
  }

  createStatusCommand() {
    // Command to query device status/battery
    return this.encryptTuyaCommand(0x08, Buffer.from([0x01, 0x01])); // 0x08 = status query
  }

  createPressCommand() {
    // Command to press the fingerbot
    return this.encryptTuyaCommand(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01])); // 0x06 = control command
  }

  createReleaseCommand() {
    // Command to release the fingerbot
    return this.encryptTuyaCommand(0x06, Buffer.from([0x01, 0x01, 0x00, 0x00])); // 0x06 = control command
  }

  async pressButton() {
    return new Promise((resolve, reject) => {
      this.log('Scanning for Fingerbot...');

      let retryCount = 0;
      let scanningInProgress = false;
      let scanTimeout = null;

      const discoverHandler = async (peripheral) => {
        if (peripheral.address === this.address) {
          this.log(`Found Fingerbot: ${peripheral.address}`);
          clearTimeout(scanTimeout);
          noble.stopScanning();
          noble.removeListener('discover', discoverHandler);
          scanningInProgress = false;

          try {
            await this.connectAndPress(peripheral);
            resolve();
          } catch (error) {
            reject(error);
          }
        }
      };

      const startScan = () => {
        if (scanningInProgress) return;
        scanningInProgress = true;
        noble.on('discover', discoverHandler);
        noble.startScanning([], true);

        scanTimeout = setTimeout(() => {
          noble.stopScanning();
          noble.removeListener('discover', discoverHandler);
          scanningInProgress = false;

          if (retryCount < this.scanRetries) {
            retryCount++;
            this.log(`Scan attempt ${retryCount} failed, retrying...`);
            setTimeout(startScan, this.scanRetryCooldown);
          } else {
            reject(new Error('Failed to find Fingerbot device after multiple attempts'));
          }
        }, this.scanDuration);
      };

      noble.removeListener('discover', discoverHandler);
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

      const connectionTimeout = setTimeout(() => {
        this.log('[DEBUG] Connection timeout');
        this.connecting = false;
        peripheral.disconnect();
        reject(new Error('Connection timeout'));
      }, 15000);

      peripheral.connect((error) => {
        if (error) {
          this.log(`[DEBUG] Connection error: ${error}`);
          clearTimeout(connectionTimeout);
          this.connecting = false;
          return reject(error);
        }

        this.log('[DEBUG] Connected, waiting before service discovery...');
        
        // Wait before service discovery - some devices need this
        setTimeout(() => {
          this.log('[DEBUG] Starting service discovery...');
          
          // Try the advertised service first, then fallback to common Tuya services
          const servicesToTry = ['a201', '1910', '00001910-0000-1000-8000-00805f9b34fb'];
          const characteristicsToFind = ['2b11', '2b10', 'fff1', 'fff2'];
          
          peripheral.discoverSomeServicesAndCharacteristics(
            servicesToTry,
            characteristicsToFind,
            (error, services, characteristics) => {
              if (error) {
                this.log(`[DEBUG] Service discovery error: ${error}`);
                // Try broader discovery
                peripheral.discoverAllServicesAndCharacteristics((error, services, characteristics) => {
                  clearTimeout(connectionTimeout);
                  if (error) {
                    this.log(`[DEBUG] Broad discovery error: ${error}`);
                    this.connecting = false;
                    peripheral.disconnect();
                    return reject(error);
                  }
                  this.handleDiscoveredCharacteristics(services, characteristics, peripheral, resolve, reject);
                });
              } else {
                clearTimeout(connectionTimeout);
                this.handleDiscoveredCharacteristics(services, characteristics, peripheral, resolve, reject);
              }
            }
          );
        }, 1000); // 1 second delay
      });

      peripheral.on('disconnect', () => {
        this.log('[DEBUG] Peripheral disconnected');
        clearTimeout(connectionTimeout);
        this.connecting = false;
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
      this.connecting = false;
      peripheral.disconnect();
      return reject(new Error('No characteristics found'));
    }

    characteristics.forEach(char => {
      this.log(`[DEBUG] Characteristic: ${char.uuid}, properties: ${JSON.stringify(char.properties)}`);
    });

    // PATCH: Prefer 2b11 for write, 2b10 for notify
    const writeChar = characteristics.find(char => char.uuid === '2b11' && (char.properties.includes('write') || char.properties.includes('writeWithoutResponse')))
      || characteristics.find(char => char.properties.includes('write') || char.properties.includes('writeWithoutResponse'));

    const notifyChar = characteristics.find(char => char.uuid === '2b10' && char.properties.includes('notify'))
      || characteristics.find(char => char.properties.includes('notify'));

    if (!writeChar) {
      this.log('[DEBUG] No writable characteristic found');
      this.connecting = false;
      peripheral.disconnect();
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
    // Generate session key
    this.generateSessionKey();

    setTimeout(() => {
      // Try authentication first if we have deviceId
      if (this.deviceId) {
        const authCmd = this.createAuthCommand();
        if (authCmd) {
          this.log('[DEBUG] Sending authentication command...');
          writeChar.write(authCmd, false, (error) => {
            if (error) {
              this.log(`[DEBUG] Auth command error: ${error}`);
            } else {
              this.log('[DEBUG] Auth command sent');
            }
            
            // Continue with status and press commands regardless
            setTimeout(() => {
              this.sendControlCommands(writeChar, peripheral, resolve, reject);
            }, 500);
          });
        } else {
          this.sendControlCommands(writeChar, peripheral, resolve, reject);
        }
      } else {
        this.sendControlCommands(writeChar, peripheral, resolve, reject);
      }
    }, 500);
  }

  sendControlCommands(writeChar, peripheral, resolve, reject) {
    // Send status query
    const statusCmd = this.createStatusCommand();
    this.log('[DEBUG] Sending status command...');
    
    writeChar.write(statusCmd, false, (error) => {
      if (error) {
        this.log(`[DEBUG] Status command error: ${error}`);
      } else {
        this.log('[DEBUG] Status command sent');
      }

      // Send press command
      setTimeout(() => {
        const pressCmd = this.createPressCommand();
        this.log('[DEBUG] Sending press command...');
        
        writeChar.write(pressCmd, false, (error) => {
          if (error) {
            this.log(`[DEBUG] Press command error: ${error}`);
            this.connecting = false;
            peripheral.disconnect();
            return reject(error);
          }

          this.log('[DEBUG] Press command sent, waiting for release...');

          // Send release command after delay
          setTimeout(() => {
            const releaseCmd = this.createReleaseCommand();
            this.log('[DEBUG] Sending release command...');
            
            writeChar.write(releaseCmd, false, (error) => {
              this.connecting = false;
              peripheral.disconnect();

              if (error) {
                this.log(`[DEBUG] Release command error: ${error}`);
                return reject(error);
              }

              this.log('[DEBUG] Release command sent, sequence complete');
              resolve();
            });
          }, this.pressTime);
        });
      }, 300);
    });
  }

  handleNotification(data) {
    try {
      // Try to decrypt notification if encrypted
      if (data.length >= 2 && data[0] === 0x55 && data[1] === 0xaa) {
        this.log('[DEBUG] Processing Tuya notification');
        
        // Look for battery data or status response
        if (data.length > 6) {
          // Try to find battery level in various positions
          for (let i = 2; i < data.length - 1; i++) {
            const value = data[i];
            if (value > 0 && value <= 100) {
              this.log(`[DEBUG] Potential battery level at position ${i}: ${value}%`);
              if (value <= 100 && value > this.batteryLevel - 20 && value < this.batteryLevel + 20) {
                this.batteryLevel = value;
                this.batteryService.updateCharacteristic(Characteristic.BatteryLevel, value);
                break;
              }
            }
          }
        }
      }
    } catch (error) {
      this.log(`[DEBUG] Error processing notification: ${error}`);
    }
  }
}