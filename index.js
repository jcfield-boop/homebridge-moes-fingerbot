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

  // PATCH: Ensure we subscribe to notifications on 2b10 BEFORE sending the status query command,
  // and only send the status query if the notify characteristic is present.

  async connectAndPress(peripheral) {
    return new Promise((resolve, reject) => {
      this.log('Connecting to Fingerbot...');

      if (this.connecting) {
        this.log('[DEBUG] Already connecting, skipping new attempt.');
        return;
      }
      this.connecting = true;

      peripheral.connect((error) => {
        if (error) {
          this.log(`[DEBUG] Connection error: ${error}`);
          this.connecting = false;
          return reject(error);
        }
        this.log('[DEBUG] Connected, discovering all services...');
        peripheral.discoverSomeServicesAndCharacteristics(
          ['1910'],
          ['2b11', '2b10'],
          (error, services, characteristics) => {
            if (error) {
              this.log(`[DEBUG] Error discovering services/characteristics: ${error}`);
              this.connecting = false;
              peripheral.disconnect();
              return reject(error);
            }
            this.log(`[DEBUG] Discovered services: ${services.length}`);
            this.log(`[DEBUG] Discovered characteristics:`);
            characteristics.forEach(char => {
              this.log(`[DEBUG] Characteristic UUID: ${char.uuid}, properties: ${JSON.stringify(char.properties)}`);
            });

            const writeChar = characteristics.find(char =>
              char.uuid === '2b11' && (char.properties.includes('write') || char.properties.includes('writeWithoutResponse'))
            );

            if (!writeChar) {
              this.log('[DEBUG] No writable characteristic (2b11) found');
              this.connecting = false;
              peripheral.disconnect();
              return reject(new Error('No writable characteristic (2b11) found'));
            }

            const notifyChar = characteristics.find(char => char.uuid === '2b10' && char.properties.includes('notify'));
            if (notifyChar) {
              notifyChar.on('data', (data, isNotification) => {
                this.log(`[DEBUG] Notification from 2b10: ${data.toString('hex')}`);
                if (data.length > 2 && data[0] === 0x55 && data[1] === 0xaa && data[3] === 0x07) {
                  const battery = data[data.length - 2];
                  this.log(`[DEBUG] Parsed battery level: ${battery}%`);
                  this.batteryLevel = battery;
                  this.batteryService.updateCharacteristic(Characteristic.BatteryLevel, battery);
                }
              });
              notifyChar.subscribe((err) => {
                if (err) {
                  this.log('[DEBUG] Failed to subscribe to 2b10 notifications');
                } else {
                  this.log('[DEBUG] Subscribed to 2b10 notifications');
                  // Wait briefly to ensure subscription is active
                  setTimeout(() => {
                    // Send status query command
                    const statusCmd = Buffer.from('55aa00070008010100000010', 'hex');
                    this.log('[DEBUG] Sending status query command...');
                    writeChar.write(statusCmd, false, (error) => {
                      if (error) this.log(`[DEBUG] Status query write error: ${error}`);
                      else this.log('[DEBUG] Status query command sent');
                    });
                    // Send press command
                    const pressCmd = Buffer.from('55aa00060005010100010e', 'hex');
                    this.log('[DEBUG] Sending press command...');
                    writeChar.write(pressCmd, false, (error) => {
                      if (error) {
                        this.log(`[DEBUG] Write error: ${error}`);
                        this.connecting = false;
                        peripheral.disconnect();
                        return reject(error);
                      }
                      this.log('[DEBUG] Press command sent, waiting...');
                      setTimeout(() => {
                        // Send release command
                        const releaseCmd = Buffer.from('55aa00060005010100000d', 'hex');
                        this.log('[DEBUG] Sending release command...');
                        writeChar.write(releaseCmd, false, (error) => {
                          this.connecting = false;
                          peripheral.disconnect();
                          if (error) {
                            this.log(`[DEBUG] Release write error: ${error}`);
                            return reject(error);
                          }
                          this.log('[DEBUG] Release command sent, done.');
                          resolve();
                        });
                      }, this.pressTime);
                    });
                  }, 200); // 200ms delay after subscribing
                }
              });
            }

            const readChars = characteristics.filter(char => char.properties.includes('read'));
            for (const char of readChars) {
              char.read((err, data) => {
                if (!err) this.log(`[DEBUG] Read from ${char.uuid}: ${data.toString('hex')}`);
              });
            }
          }
        );
      });

      peripheral.on('disconnect', () => {
        this.log('[DEBUG] Peripheral disconnected');
        this.connecting = false;
      });
    });
  }
}