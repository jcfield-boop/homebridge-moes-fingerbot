const noble = require('@abandonware/noble');
const debug = require('debug')('homebridge-moes-fingerbot');

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
    this.pressTime = config.pressTime || 3000; // Default 3 seconds
    this.scanDuration = config.scanDuration || 5000;
    this.scanRetries = config.scanRetries || 3;
    this.scanRetryCooldown = config.scanRetryCooldown || 1000;
    
    this.isOn = false;
    this.batteryLevel = 100;
    this.lastBatteryCheck = 0;
    this.batteryCheckInterval = (config.batteryCheckInterval || 60) * 60 * 1000; // default 60 minutes
    
    this.switchService = new Service.Switch(this.name);
    this.switchService
      .getCharacteristic(Characteristic.On)
      .on('get', this.getOn.bind(this))
      .on('set', this.setOn.bind(this));
    
    this.batteryService = new Service.BatteryService(this.name);
    this.batteryService
      .getCharacteristic(Characteristic.BatteryLevel)
      .on('get', this.getBatteryLevel.bind(this));
    
    // Initialize Noble
    noble.on('stateChange', (state) => {
      if (state === 'poweredOn') {
        this.log('Bluetooth adapter is powered on');
        this.initDiscovery();
      } else {
        this.log('Bluetooth adapter is powered off or unavailable');
      }
    });
  }

  initDiscovery() {
    this.log('Starting initial scan for Fingerbot...');
    let connecting = false;

    const discoverHandler = async (peripheral) => {
      if (peripheral.address === this.address && !connecting) {
        connecting = true;
        this.log(`Discovered Fingerbot at startup: ${peripheral.address}`);
        noble.stopScanning();
        noble.removeListener('discover', discoverHandler);
        try {
          this.peripheral = peripheral;
          await this.cacheCharacteristics(peripheral);
          this.ready = true;
        } catch (err) {
          this.log(`Startup connection error: ${err}`);
          // Optionally, restart scan after a delay
          setTimeout(() => {
            connecting = false;
            noble.startScanning([], true);
          }, 5000);
        }
      }
    };

    noble.on('discover', discoverHandler);
    noble.startScanning([], true);
  }

  async cacheCharacteristics(peripheral) {
    return new Promise((resolve, reject) => {
      peripheral.connect((error) => {
        if (error) {
          this.log(`Startup connection error: ${error}`);
          return reject(error);
        }
        peripheral.discoverAllServicesAndCharacteristics((error, services, characteristics) => {
          if (error) {
            this.log(`Startup discovery error: ${error}`);
            return reject(error);
          }
          this.characteristics = characteristics;
          this.log('[DEBUG] Cached characteristics at startup.');
          peripheral.disconnect();
          resolve();
        });
      });
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
      // Turn ON - press for specified duration
      this.pressButton()
        .then(() => {
          this.isOn = true;
          callback(null);

          // Auto turn off after pressTime (make this configurable)
          setTimeout(() => {
            this.isOn = false;
            this.switchService.updateCharacteristic(Characteristic.On, false);
          }, this.pressTime); // Use this.pressTime instead of 1000
        })
        .catch(error => {
          this.log(`Error pressing button: ${error}`);
          callback(error);
        });
    } else {
      // Already OFF
      callback(null);
    }
  }

  getBatteryLevel(callback) {
    const now = Date.now();
    if (now - this.lastBatteryCheck > this.batteryCheckInterval) {
      this.lastBatteryCheck = now;
      // TODO: Actually read battery from device here if supported
      this.log(`[DEBUG] (Battery) Polled device for battery level: ${this.batteryLevel}`);
    } else {
      this.log(`[DEBUG] (Battery) Returning cached battery level: ${this.batteryLevel}`);
    }
    callback(null, this.batteryLevel);
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
          this.log(`[DEBUG] Peripheral details: ${JSON.stringify({
            id: peripheral.id,
            address: peripheral.address,
            advertisement: peripheral.advertisement,
            rssi: peripheral.rssi,
            state: peripheral.state
          }, null, 2)}`);
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

      startScan();
    });
  }

  async connectAndPress(peripheral) {
    return new Promise((resolve, reject) => {
      this.log('Connecting to Fingerbot...');
      
      peripheral.connect(async (error) => {
        if (error) {
          this.log(`Connection error: ${error}`);
          return reject(error);
        }
        
        this.log('Connected, discovering services...');
        
        peripheral.discoverAllServicesAndCharacteristics(async (error, services, characteristics) => {
          if (error) {
            this.log(`[DEBUG] Error discovering services/characteristics: ${error}`);
            return;
          }

          // Log all discovered services
          this.log(`[DEBUG] Discovered services:`);
          services.forEach(service => {
            this.log(`  Service UUID: ${service.uuid}`);
          });

          this.log(`[DEBUG] Discovered characteristics:`);
          characteristics.forEach(char => {
            this.log(`[DEBUG] Characteristic UUID: ${char.uuid}, properties: ${JSON.stringify(char.properties)}`);
          });
          const readableChars = characteristics.filter(char => char.properties.includes('read'));
          for (const char of readableChars) {
            char.read((error, data) => {
              if (error) {
                this.log(`[DEBUG] Failed to read from characteristic ${char.uuid}: ${error}`);
              } else {
                this.log(`[DEBUG] Read from characteristic ${char.uuid}: ${data.toString('hex')} (raw), ${data.readUInt8(0)} (as uint8), ${data.toString('utf8')} (as utf8)`);
              }
            });
          }
          const notifyChars = characteristics.filter(char => char.properties.includes('notify'));
          notifyChars.forEach(char => {
            char.on('data', (data, isNotification) => {
              this.log(`[DEBUG] Notification from ${char.uuid}: ${data.toString('hex')}`);
            });
            char.subscribe((err) => {
              if (err) this.log(`[DEBUG] Failed to subscribe to ${char.uuid}: ${err}`);
              else this.log(`[DEBUG] Subscribed to notifications on ${char.uuid}`);
            });
          });
          peripheral.on('disconnect', () => {
            this.log('[DEBUG] Peripheral disconnected');
          });
          
          // Look for writable characteristics
          const writableChars = characteristics.filter(char => {
            return (char.properties.includes('write') || char.properties.includes('writeWithoutResponse'));
          });
          
          if (writableChars.length === 0) {
            peripheral.disconnect();
            return reject(new Error('No writable characteristics found'));
          }
          
          // Try different Tuya/MOES command formats
          const commands = [
            Buffer.from('57', 'hex'),                                // Standard SwitchBot format
            Buffer.from('550100', 'hex'),                           // Simple Tuya format
            Buffer.from('55AA0006000501010001', 'hex'),             // Full Tuya command format
            Buffer.from([0x55, 0xAA, 0x00, 0x06, 0x00, 0x05, 0x01, 0x01, 0x00, 0x01, 0x0E]), // Tuya command with checksum
          ];
          
          try {
            let success = false;
            for (let i = 0; i < writableChars.length; i++) {
              const char = writableChars[i];

              for (let j = 0; j < commands.length; j++) {
                const cmd = commands[j];
                const startTime = Date.now();

                this.log(`[DEBUG] Trying command ${cmd.toString('hex')} on characteristic ${char.uuid} (properties: ${JSON.stringify(char.properties)})`);

                try {
                  await this.writeCharacteristic(char, cmd);
                  const elapsed = Date.now() - startTime;
                  this.log(`[DEBUG] Command ${cmd.toString('hex')} sent successfully on ${char.uuid} in ${elapsed}ms`);

                  // Wait for the specified press time
                  await new Promise(resolve => setTimeout(resolve, this.pressTime));

                  // Try to send a release command if needed
                  if (j === 3) { // For the full Tuya command with checksum
                    const releaseCmd = Buffer.from([0x55, 0xAA, 0x00, 0x06, 0x00, 0x05, 0x01, 0x01, 0x00, 0x00, 0x0D]);
                    await this.writeCharacteristic(char, releaseCmd);
                    this.log('[DEBUG] Release command sent');
                  }

                  // Mark as success and break out of loops
                  if (!success) {
                    this.log(`[DEBUG] SUCCESS: Command ${cmd.toString('hex')} on characteristic ${char.uuid} worked!`);
                    success = true;
                  }
                  break;
                } catch (error) {
                  this.log(`[DEBUG] Failed to send command ${cmd.toString('hex')} on ${char.uuid}: ${error}`);
                  // Continue to the next command/characteristic
                }
              }
              if (success) break;
            }
            
            // Disconnect after all attempts, whether successful or not
            peripheral.disconnect();
            resolve();
          } catch (error) {
            peripheral.disconnect();
            reject(error);
          }
        });
      });

      peripheral.on('disconnect', () => {
        this.log('[DEBUG] Peripheral disconnected');
      });
    });
  }

  async writeCharacteristic(characteristic, data) {
    return new Promise((resolve, reject) => {
      this.log(`[DEBUG] Attempting to write to characteristic ${characteristic.uuid} with data: ${data.toString('hex')}`);
      if (characteristic.properties.includes('write')) {
        characteristic.write(data, true, (error) => {
          if (error) {
            this.log(`[DEBUG] Write error on ${characteristic.uuid}: ${error}`);
            return reject(error);
          }
          this.log(`[DEBUG] Write success on ${characteristic.uuid}`);
          resolve();
        });
      } else if (characteristic.properties.includes('writeWithoutResponse')) {
        characteristic.write(data, false, (error) => {
          if (error) {
            this.log(`[DEBUG] WriteWithoutResponse error on ${characteristic.uuid}: ${error}`);
            return reject(error);
          }
          this.log(`[DEBUG] WriteWithoutResponse success on ${characteristic.uuid}`);
          resolve();
        });
      } else {
        this.log(`[DEBUG] Characteristic ${characteristic.uuid} is not writable`);
        reject(new Error('Characteristic is not writable'));
      }
    });
  }
}