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
      // Turn ON - press for specified duration
      this.pressButton()
        .then(() => {
          this.isOn = true;
          callback(null);
          
          // Auto turn off after a short delay
          setTimeout(() => {
            this.isOn = false;
            this.switchService.updateCharacteristic(Characteristic.On, false);
          }, 1000); // Wait 1 second after command completion
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
    this.log(`Getting battery level: ${this.batteryLevel}`);
    callback(null, this.batteryLevel);
  }

  async pressButton() {
    return new Promise((resolve, reject) => {
      this.log('Scanning for Fingerbot...');
      
      let retryCount = 0;
      let scanningInProgress = false;
      
      const startScan = () => {
        if (scanningInProgress) return;
        
        scanningInProgress = true;
        noble.startScanning([], true);
        
        const scanTimeout = setTimeout(() => {
          noble.stopScanning();
          scanningInProgress = false;
          
          if (retryCount < this.scanRetries) {
            retryCount++;
            this.log(`Scan attempt ${retryCount} failed, retrying...`);
            setTimeout(startScan, this.scanRetryCooldown);
          } else {
            reject(new Error('Failed to find Fingerbot device after multiple attempts'));
          }
        }, this.scanDuration);
        
        noble.on('discover', async (peripheral) => {
          if (peripheral.address === this.address) {
            this.log(`Found Fingerbot: ${peripheral.address}`);
            
            clearTimeout(scanTimeout);
            noble.stopScanning();
            scanningInProgress = false;
            
            try {
              await this.connectAndPress(peripheral);
              resolve();
            } catch (error) {
              reject(error);
            }
          }
        });
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
            this.log(`Discovery error: ${error}`);
            peripheral.disconnect();
            return reject(error);
          }
          
          this.log(`Discovered ${services.length} services and ${characteristics.length} characteristics`);
          
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
            for (let i = 0; i < writableChars.length; i++) {
              const char = writableChars[i];
              
              for (let j = 0; j < commands.length; j++) {
                const cmd = commands[j];
                
                this.log(`Trying command ${cmd.toString('hex')} on characteristic ${char.uuid}`);
                
                try {
                  await this.writeCharacteristic(char, cmd);
                  this.log(`Command sent successfully`);
                  
                  // Wait for the specified press time
                  await new Promise(resolve => setTimeout(resolve, this.pressTime));
                  
                  // Try to send a release command if needed
                  if (j === 3) { // For the full Tuya command with checksum
                    const releaseCmd = Buffer.from([0x55, 0xAA, 0x00, 0x06, 0x00, 0x05, 0x01, 0x01, 0x00, 0x00, 0x0D]);
                    await this.writeCharacteristic(char, releaseCmd);
                    this.log('Release command sent');
                  }
                } catch (error) {
                  this.log(`Failed to send command: ${error}`);
                  // Continue to the next command/characteristic
                }
              }
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
    });
  }

  async writeCharacteristic(characteristic, data) {
    return new Promise((resolve, reject) => {
      if (characteristic.properties.includes('write')) {
        characteristic.write(data, true, (error) => {
          if (error) {
            return reject(error);
          }
          resolve();
        });
      } else if (characteristic.properties.includes('writeWithoutResponse')) {
        characteristic.write(data, false, (error) => {
          if (error) {
            return reject(error);
          }
          resolve();
        });
      } else {
        reject(new Error('Characteristic is not writable'));
      }
    });
  }
}