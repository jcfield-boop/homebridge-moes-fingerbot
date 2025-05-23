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
    
    // NEW: Firmware version detection
    this.firmwareVersion = config.firmwareVersion || 'auto'; // auto, 1.x, 2.0
    this.deviceModel = config.deviceModel || 'auto'; // auto, original, plus, cubetouch

    // Protocol state - using working format from diagnostic
    this.sequenceNumber = 1;
    this.sessionKey = null;
    this.deviceAuthenticated = false;
    this.deviceStatus = {};

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
          this.log('[COMMAND-DIAG] Testing for Fingerbot Plus firmware 2.0 compatibility');
        }
      } else {
        this.log('Bluetooth adapter is powered off or unavailable');
        this.forceDisconnect();
      }
    });

    // Detect device model from deviceId patterns
    this.detectDeviceModel();
  }

  // Enhanced auto-detect device model with blliqpsj support
  detectDeviceModel() {
    const deviceIdPatterns = {
      'plus': ['blliqpsj', 'ndvkgsrm', 'yiihr7zh', 'neq16kgd'],
      'original': ['ltak7e1p', 'y6kttvd6', 'yrnk7mnn', 'nvr2rocq', 'bnt7wajf', 'rvdceqjh', '5xhbk964'],
      'cubetouch1s': ['3yqdo5yt'],
      'cubetouch2': ['xhf790if']
    };

    if (this.deviceModel === 'auto') {
      for (const [model, patterns] of Object.entries(deviceIdPatterns)) {
        if (patterns.some(pattern => this.deviceId.startsWith(pattern))) {
          this.deviceModel = model;
          this.log(`[AUTO-DETECT] Detected device model: ${model}`);
          
          // Special logging for blliqpsj (user's confirmed model)
          if (this.deviceId.startsWith('blliqpsj')) {
            this.log(`[AUTO-DETECT] Confirmed blliqpsj Fingerbot Plus with full feature set:`);
            this.log(`[AUTO-DETECT] - Resistance coefficient: 0-2 (0.1 increments)`);
            this.log(`[AUTO-DETECT] - Movement modes: Click, Switch, Programmable`);
            this.log(`[AUTO-DETECT] - Down movement: 51%-100%`);
            this.log(`[AUTO-DETECT] - Sustain time: 0-10 seconds`);
            this.log(`[AUTO-DETECT] - Calibration & Programming functions available`);
          }
          break;
        }
      }
      if (this.deviceModel === 'auto') {
        this.deviceModel = 'unknown';
        this.log(`[AUTO-DETECT] Unknown device model, using fallback mode`);
      }
    }
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
    this.deviceAuthenticated = false;
    
    // Also try to stop any ongoing scanning to prevent conflicts
    try {
      noble.stopScanning();
    } catch (e) {
      // Ignore scanning stop errors
    }
    noble.removeAllListeners('discover');
  }

  // Enhanced session key generation for firmware 2.0
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

  // ENHANCED packet format with firmware 2.0 support
  createTuyaBLEPacket(commandType, data = Buffer.alloc(0), encrypt = false, useV2Protocol = false) {
    try {
      this.sequenceNumber = (this.sequenceNumber + 1) & 0xFFFF;
      
      // Tuya BLE format: [0x55, 0xaa] [seq(2, BE)] [cmd(1)] [len(2, BE)] [data] [checksum(1)]
      const header = Buffer.from([0x55, 0xaa]);
      const seqBuffer = Buffer.alloc(2);
      seqBuffer.writeUInt16BE(this.sequenceNumber, 0);
      const cmdBuffer = Buffer.from([commandType]);
      
      let finalData = data;
      
      // Enhanced encryption for firmware 2.0
      if (encrypt && this.sessionKey && (commandType === 0x06 || commandType === 0x07 || commandType === 0x08)) {
        try {
          if (useV2Protocol || this.firmwareVersion === '2.0' || this.deviceModel === 'plus') {
            // Firmware 2.0 encryption approach
            finalData = this.encryptDataV2(data);
          } else {
            // Original encryption approach
            finalData = this.encryptDataV1(data);
          }
          
          this.log(`[DEBUG] Encrypted payload (v${useV2Protocol ? '2' : '1'}, ${finalData.length} bytes): ${finalData.toString('hex')}`);
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
      this.log(`[DEBUG] Tuya BLE packet (cmd 0x${commandType.toString(16)}, encrypted: ${encrypt}, v2: ${useV2Protocol}): ${packet.toString('hex')}`);
      return packet;
      
    } catch (error) {
      this.log(`[DEBUG] Error creating Tuya BLE packet: ${error}`);
      return null;
    }
  }

  // Original encryption method
  encryptDataV1(data) {
    const timestamp = Math.floor(Date.now() / 1000);
    const deviceIdBuffer = Buffer.from(this.deviceId, 'utf8');

    const timestampBuffer = Buffer.alloc(4);
    timestampBuffer.writeUInt32BE(timestamp, 0);
    const authData = Buffer.concat([deviceIdBuffer, timestampBuffer, data]);

    const paddingNeeded = 16 - (authData.length % 16);
    const paddedData = Buffer.concat([authData, Buffer.alloc(paddingNeeded, paddingNeeded)]);

    // FIX: Use createCipheriv instead of deprecated createCipher
    const cipher = crypto.createCipheriv('aes-128-ecb', this.sessionKey, null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(paddedData), cipher.final()]);
  }

  // Enhanced encryption for firmware 2.0
  encryptDataV2(data) {
    const timestamp = Math.floor(Date.now() / 1000);
    
    // For firmware 2.0, use different auth data structure
    const deviceIdTruncated = Buffer.from(this.deviceId, 'utf8').slice(0, 16);
    const timestampBuffer = Buffer.alloc(4);
    timestampBuffer.writeUInt32BE(timestamp, 0);
    
    // Pad device ID to 16 bytes
    const paddedDeviceId = Buffer.alloc(16, 0);
    deviceIdTruncated.copy(paddedDeviceId);
    
    const authData = Buffer.concat([paddedDeviceId, timestampBuffer, data]);
    
    // Try AES-128-CBC with zero IV for firmware 2.0
    const iv = Buffer.alloc(16, 0);
    const cipher = crypto.createCipheriv('aes-128-cbc', this.sessionKey, iv);
    return Buffer.concat([cipher.update(authData), cipher.final()]);
  }

  // Enhanced device response parsing
  parseDeviceResponse(data) {
    if (data.length < 7) {
      this.log(`[ENHANCED-DIAG] Response too short: ${data.length} bytes`);
      return;
    }
    
    try {
      const header = data.slice(0, 2);
      const sequence = data.readUInt16BE(2);
      const command = data[4];
      const length = data.readUInt16BE(5);
      const payload = data.slice(7, 7 + length);
      const checksum = data[7 + length];
      
      this.log(`[ENHANCED-DIAG] Parsed response:`);
      this.log(`  Header: ${header.toString('hex')}`);
      this.log(`  Sequence: ${sequence}`);
      this.log(`  Command: 0x${command.toString(16)}`);
      this.log(`  Length: ${length}`);
      this.log(`  Payload: ${payload.toString('hex')}`);
      this.log(`  Checksum: 0x${checksum.toString(16)}`);
      
      // Decode specific responses
      switch (command) {
        case 0x01:
          this.handleLoginResponse(payload);
          break;
        case 0x02:
          this.log(`[ENHANCED-DIAG] Heartbeat response received`);
          break;
        case 0x06:
          this.handleDPResponse(payload);
          break;
        case 0x08:
          this.handleStatusResponse(payload);
          break;
        default:
          this.log(`[ENHANCED-DIAG] Unknown command response: 0x${command.toString(16)}`);
      }
    } catch (parseError) {
      this.log(`[ENHANCED-DIAG] Error parsing response: ${parseError}`);
    }
  }

  handleLoginResponse(payload) {
    this.log(`[ENHANCED-DIAG] Login response - Status: ${payload.length > 0 ? payload[0] : 'unknown'}`);
    if (payload.length > 0 && payload[0] === 0x00) {
      this.log(`[ENHANCED-DIAG] ✓ Login successful - device authenticated`);
      this.deviceAuthenticated = true;
    } else {
      this.log(`[ENHANCED-DIAG] ✗ Login failed - status code: ${payload[0]}`);
      this.deviceAuthenticated = false;
    }
  }

  handleDPResponse(payload) {
    this.log(`[ENHANCED-DIAG] DP command response`);
    if (payload.length >= 4) {
      const dpId = payload[0];
      const dpType = payload[1];
      const dpValue = payload.slice(4);
      this.log(`  DP${dpId} (type ${dpType}): ${dpValue.toString('hex')}`);
      
      // Store DP status
      this.deviceStatus[`dp${dpId}`] = {
        type: dpType,
        value: dpValue
      };
    }
  }

  handleStatusResponse(payload) {
    this.log(`[ENHANCED-DIAG] Device status response`);
    if (payload.length === 0) {
      this.log(`[ENHANCED-DIAG] Empty status payload`);
      return;
    }
    
    // Parse DP status responses
    let offset = 0;
    while (offset < payload.length - 4) {
      try {
        const dpId = payload[offset];
        const dpType = payload[offset + 1];
        const dpLength = payload.readUInt16BE(offset + 2);
        const dpData = payload.slice(offset + 4, offset + 4 + dpLength);
        
        this.log(`[ENHANCED-DIAG] Status DP${dpId} (type ${dpType}, len ${dpLength}): ${dpData.toString('hex')}`);
        
        // Decode common DP types
        if (dpType === 0x01 && dpLength === 1) { // Boolean
          const boolValue = dpData[0] === 0x01;
          this.log(`  Boolean value: ${boolValue}`);
          this.deviceStatus[`dp${dpId}`] = boolValue;
        } else if (dpType === 0x02 && dpLength === 4) { // Integer
          const intValue = dpData.readUInt32BE(0);
          this.log(`  Integer value: ${intValue}`);
          this.deviceStatus[`dp${dpId}`] = intValue;
        }
        
        offset += 4 + dpLength;
      } catch (parseError) {
        this.log(`[ENHANCED-DIAG] Error parsing DP at offset ${offset}: ${parseError}`);
        break;
      }
    }
  }

  // ENHANCED COMMAND DIAGNOSTIC: Targeted for blliqpsj Fingerbot Plus
  getCommandTestConfigurations() {
    const dpMappings = this.getTuyaDPMappings && this.getTuyaDPMappings();

    const baseConfigs = [
      // Test 0: Device Detection Test
      {
        name: "Device Detection & Response Test",
        commands: [
          () => {
            this.log('[COMMAND-DIAG] 🔍 Testing if device responds to ANY command...');
            this.log('[COMMAND-DIAG] 📱 MAKE SURE: Tuya Smart app is closed OR device is in pairing mode');
            // Simple ping command
            return this.createTuyaBLEPacket(0x00, Buffer.from([0x00]), false, false);
          }
        ],
        delay: 3000
      },

      // Test 1: Force device wake-up
      {
        name: "Device Wake-up Sequence",
        commands: [
          () => {
            this.log('[COMMAND-DIAG] 🚨 If Fingerbot has a physical button, PRESS AND HOLD IT NOW!');
            this.log('[COMMAND-DIAG] ⏰ Sending wake-up command in 3 seconds...');
            // Try to wake device
            return this.createTuyaBLEPacket(0x01, Buffer.from(this.deviceId, 'utf8'), false);
          }
        ],
        delay: 5000
      },

      // Test 2: Raw unencrypted DP1
      {
        name: "Raw DP1 Trigger (No Encryption)",
        commands: [
          () => {
            this.log('[COMMAND-DIAG] 🎯 Sending simplest possible trigger command...');
            // Simplest DP1 command
            return this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01]), false, false);
          }
        ],
        delay: this.pressTime
      },

      // Test 3: Mode setting + trigger (Switch to Click mode then trigger)
      {
        name: "Set Click Mode + Trigger",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x02, 0x04, 0x00, 0x04, 0x43, 0x6C, 0x69, 0x63]), true, true), // DP2 = "Clic" (Click mode)
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01]), true, true), // DP1 trigger
        ],
        delay: this.pressTime
      },

      // Test 4: Switch mode test
      {
        name: "Switch Mode Toggle",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x02, 0x04, 0x00, 0x06, 0x53, 0x77, 0x69, 0x74, 0x63, 0x68]), true, true), // DP2 = "Switch"
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01]), true, true), // DP1 trigger
        ],
        delay: this.pressTime
      },

      // Test 5: Resistance coefficient setting (DP3 likely)
      {
        name: "Set Resistance + Trigger",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x03, 0x02, 0x00, 0x04, 0x00, 0x00, 0x00, 0x0A]), true, true), // DP3 = 10 (1.0 resistance)
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01]), true, true), // DP1 trigger
        ],
        delay: this.pressTime
      },

      // Test 6: Down movement percentage (DP4 likely)
      {
        name: "Set Down Movement + Trigger",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x04, 0x02, 0x00, 0x04, 0x00, 0x00, 0x00, 0x50]), true, true), // DP4 = 80 (80% down movement)
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01]), true, true), // DP1 trigger
        ],
        delay: this.pressTime
      },

      // Test 7: Sustain time (DP5 likely)
      {
        name: "Set Sustain Time + Trigger",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x05, 0x02, 0x00, 0x04, 0x00, 0x00, 0x00, 0x1E]), true, true), // DP5 = 30 (3 seconds)
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01]), true, true), // DP1 trigger
        ],
        delay: this.pressTime
      },

      // Test 8: Programming mode activation
      {
        name: "Programming Mode Test",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x02, 0x04, 0x00, 0x0C, 0x50, 0x72, 0x6F, 0x67, 0x72, 0x61, 0x6D, 0x6D, 0x61, 0x62, 0x6C, 0x65]), true, true), // DP2 = "Programmable"
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x65, 0x01, 0x00, 0x01, 0x01]), true, true), // DP101 execute program
        ],
        delay: this.pressTime
      },

      // Test 9: Calibration command (DP6 likely)
      {
        name: "Calibration Command",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x06, 0x01, 0x00, 0x01, 0x01]), true, true), // DP6 = calibrate
        ],
        delay: 5000 // Calibration might take longer
      },

      // Test 10: Adaptive movement setting
      {
        name: "Adaptive Movement + Trigger",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x07, 0x01, 0x00, 0x01, 0x01]), true, true), // DP7 = adaptive movement on
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01]), true, true), // DP1 trigger
        ],
        delay: this.pressTime
      },

      // Test 11: Complete setup sequence
      {
        name: "Complete Setup + Click Mode",
        commands: [
          () => {
            this.log('[COMMAND-DIAG] Setting up Click mode...');
            return this.createTuyaBLEPacket(0x06, Buffer.from([0x02, 0x04, 0x00, 0x04, 0x43, 0x6C, 0x69, 0x63]), true, true); // Click mode
          },
          () => {
            this.log('[COMMAND-DIAG] Setting resistance...');
            return this.createTuyaBLEPacket(0x06, Buffer.from([0x03, 0x02, 0x00, 0x04, 0x00, 0x00, 0x00, 0x0A]), true, true); // Resistance 1.0
          },
          () => {
            this.log('[COMMAND-DIAG] Setting down movement...');
            return this.createTuyaBLEPacket(0x06, Buffer.from([0x04, 0x02, 0x00, 0x04, 0x00, 0x00, 0x00, 0x50]), true, true); // 80% down
          },
          () => {
            this.log('[COMMAND-DIAG] Triggering action...');
            return this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01]), true, true); // Trigger
          }
        ],
        delay: this.pressTime
      },

      // Test 12: Auth sequence + Status query + Action
      {
        name: "Full Auth + Status + Action",
        commands: [
          () => {
            this.log('[COMMAND-DIAG] Authenticating...');
            return this.createTuyaBLEPacket(0x01, Buffer.from(this.deviceId, 'utf8'), false);
          },
          () => {
            this.log('[COMMAND-DIAG] Heartbeat...');
            const timestamp = Math.floor(Date.now() / 1000);
            const timestampBuffer = Buffer.alloc(4);
            timestampBuffer.writeUInt32BE(timestamp, 0);
            return this.createTuyaBLEPacket(0x02, timestampBuffer, false);
          },
          () => {
            this.log('[COMMAND-DIAG] Querying status...');
            return this.createTuyaBLEPacket(0x08, Buffer.alloc(0), true, true);
          },
          () => {
            this.log('[COMMAND-DIAG] Triggering...');
            return this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01]), true, true);
          }
        ],
        delay: this.pressTime
      },

      // Original working commands for compatibility
      {
        name: "Original DP2 BOOL (firmware 1.x compat)",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x02, 0x01, 0x00, 0x01, 0x01]), false), // DP2 = true
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x02, 0x01, 0x00, 0x01, 0x00]), false)  // DP2 = false
        ],
        delay: this.pressTime
      },

      {
        name: "ENCRYPTED DP2 BOOL (v1 encryption)",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x02, 0x01, 0x00, 0x01, 0x01]), true, false), // DP2 = true (v1)
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x02, 0x01, 0x00, 0x01, 0x00]), true, false)  // DP2 = false (v1)
        ],
        delay: this.pressTime
      },

      {
        name: "ENCRYPTED DP1 BOOL (v2 encryption)",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01]), true, true), // DP1 = true (v2)
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x00]), true, true)  // DP1 = false (v2)
        ],
        delay: this.pressTime
      },

      {
        name: "Query All DPs (status check)",
        commands: [
          () => this.createTuyaBLEPacket(0x08, Buffer.alloc(0), true, true), // Query all DPs
        ],
        delay: 1000
      }
    ];

    // Add model-specific tests
    if (this.deviceModel === 'plus') {
      baseConfigs.unshift({
        name: "Fingerbot Plus Manual Trigger DP",
        commands: [
          () => this.createTuyaBLEPacket(0x06, Buffer.from([0x04, 0x01, 0x00, 0x01, 0x01]), true, true), // DP4 manual trigger
        ],
        delay: this.pressTime
      });
    }

    return baseConfigs;
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
      this.log(`[COMMAND-DIAG] Starting enhanced diagnostic for ${this.deviceModel} device (firmware ${this.firmwareVersion})`);
      this.forceDisconnect();

      const testConfigs = this.getCommandTestConfigurations();
      let testIndex = 0;

      const runNextCommandTest = () => {
        if (testIndex >= testConfigs.length) {
          this.log(`[COMMAND-DIAG] All ${testConfigs.length} command tests completed!`);
          this.log(`[COMMAND-DIAG] Check device status: ${JSON.stringify(this.deviceStatus)}`);
          this.log(`[COMMAND-DIAG] If you saw movement, note which test number worked.`);
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
        }, 2000);
      };

      runNextCommandTest();
    });
  }

  async pressButtonStandard() {
    return new Promise((resolve, reject) => {
      this.log(`Scanning for ${this.deviceModel} Fingerbot...`);

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
      }, 5000); // Slightly longer scan for command tests
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

          clearTimeout(connectionTimeout);
          connectionTimeout = null;
          
          serviceTimeout = setTimeout(() => {
            this.log('[DEBUG] Service operation timeout');
            cleanup();
            this.forceDisconnect();
            reject(new Error('Service operation timeout'));
          }, 12000);

          if (testConfig) {
            this.executeTestSequence(writeChar, notifyChar, peripheral, testConfig, cleanup, resolve, reject);
          } else {
            this.executeWorkingSequence(writeChar, notifyChar, peripheral, cleanup, resolve, reject);
          }
        });
      }, 2000);
    });
  }

  // Enhanced notification setup
  setupEnhancedNotifications(notifyChar) {
    if (!notifyChar) return;
    
    notifyChar.subscribe((error) => {
      if (error) {
        this.log(`[ENHANCED-DIAG] Notification subscription error: ${error}`);
      } else {
        this.log('[ENHANCED-DIAG] Subscribed to notifications');
        
        notifyChar.on('data', (data) => {
          this.log(`[ENHANCED-DIAG] Raw response: ${data.toString('hex')}`);
          this.parseDeviceResponse(data);
        });
      }
    });
  }

  executeTestSequence(writeChar, notifyChar, peripheral, testConfig, cleanup, resolve, reject) {
    this.log(`[COMMAND-DIAG] Executing test: ${testConfig.name}`);
    
    // Generate session key and setup enhanced notifications
    this.generateSessionKey();
    this.setupEnhancedNotifications(notifyChar);
    
    let operationTimeout = null;
    let sequenceComplete = false;

    operationTimeout = setTimeout(() => {
      if (!sequenceComplete) {
        this.log('[COMMAND-DIAG] Test operation timeout');
        cleanup();
        this.forceDisconnect();
        resolve();
      }
    }, 12000);

    const executeTest = () => {
      let commandIndex = 0;
      
      const sendNextCommand = () => {
        if (commandIndex >= testConfig.commands.length) {
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

            let delay = 500;
            if (commandIndex === 1 && testConfig.name.includes("Auth")) {
              delay = 1500; // Wait longer after login
            } else if (commandIndex === 2 && testConfig.name.includes("Auth")) {
              delay = 1000; // Wait after heartbeat
            } else if (commandIndex >= testConfig.commands.length) {
              delay = testConfig.delay;
            }
            
            setTimeout(sendNextCommand, delay);
          });
        } else {
          setTimeout(sendNextCommand, 100);
        }
      };

      sendNextCommand();
    };

    setTimeout(executeTest, 1000);
  }

  async connectAndPress(peripheral) {
    return new Promise((resolve, reject) => {
      this.log('Connecting to Fingerbot...');

      if (this.connecting) {
        return reject(new Error('Already connecting'));
      }
      this.forceDisconnect();

      setTimeout(() => {
        this.doConnection(peripheral, resolve, reject);
      }, 1000);
    });
  }

  executeWorkingSequence(writeChar, notifyChar, peripheral, cleanup, resolve, reject) {
    this.log(`[DEBUG] Executing WORKING ${this.deviceModel} Fingerbot sequence (model: ${this.deviceId.substring(0,8)})...`);
    this.generateSessionKey();
    this.setupEnhancedNotifications(notifyChar);

    let operationTimeout = null;
    let sequenceComplete = false;

    operationTimeout = setTimeout(() => {
      if (!sequenceComplete) {
        this.log('[DEBUG] Operation timeout');
        cleanup();
        this.forceDisconnect();
        reject(new Error('Operation timeout'));
      }
    }, 12000);

    const isBlliqpsj = this.deviceId.startsWith('blliqpsj');
    const useV2 = true; // Always use v2 for Plus models

    if (isBlliqpsj) {
      this.log('[DEBUG] Using blliqpsj Fingerbot Plus sequence...');
      // Step 1: Set Click mode
      const setClickMode = this.createTuyaBLEPacket(0x06, Buffer.from([0x02, 0x04, 0x00, 0x04, 0x43, 0x6C, 0x69, 0x63]), true, true);
      this.log('[DEBUG] Setting Click mode...');
      writeChar.write(setClickMode, true, (error) => {
        if (error) {
          this.log(`[DEBUG] Click mode setting error: ${error}`);
        } else {
          this.log('[DEBUG] Click mode set successfully');
        }
        // Step 2: Wait then trigger action
        setTimeout(() => {
          if (sequenceComplete || peripheral.state !== 'connected') return;
          const triggerAction = this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x01]), true, true);
          this.log('[DEBUG] Triggering Fingerbot action...');
          writeChar.write(triggerAction, true, (error) => {
            if (error) {
              this.log(`[DEBUG] Trigger command error: ${error}`);
            } else {
              this.log('[DEBUG] Trigger command sent successfully');
            }
            // Step 3: Wait for pressTime, then release
            setTimeout(() => {
              if (sequenceComplete || peripheral.state !== 'connected') return;
              const releasePacket = this.createTuyaBLEPacket(0x06, Buffer.from([0x01, 0x01, 0x00, 0x01, 0x00]), true, true);
              this.log('[DEBUG] Releasing Fingerbot...');
              writeChar.write(releasePacket, true, (error) => {
                if (error) {
                  this.log(`[DEBUG] Release command error: ${error}`);
                } else {
                  this.log('[DEBUG] Release command sent successfully');
                }
                sequenceComplete = true;
                clearTimeout(operationTimeout);
                cleanup();
                setTimeout(() => {
                  this.forceDisconnect();
                  this.log('[DEBUG] blliqpsj Fingerbot Plus operation completed successfully!');
                  resolve();
                }, 500);
              });
            }, this.pressTime);
          });
        }, 1000); // Wait 1 second between mode setting and trigger
      });
    } else {
      // Fallback for other Plus models or unknown variants
      this.log('[DEBUG] Using fallback Plus sequence...');
      const pressDP = this.deviceModel === 'plus' ? [0x01, 0x01, 0x00, 0x01, 0x01] : [0x02, 0x01, 0x00, 0x01, 0x01];
      const releaseDP = this.deviceModel === 'plus' ? [0x01, 0x01, 0x00, 0x01, 0x00] : [0x02, 0x01, 0x00, 0x01, 0x00];
      const pressPacket = this.createTuyaBLEPacket(0x06, Buffer.from(pressDP), true, useV2);
      const releasePacket = this.createTuyaBLEPacket(0x06, Buffer.from(releaseDP), true, useV2);

      if (!pressPacket || !releasePacket) {
        sequenceComplete = true;
        clearTimeout(operationTimeout);
        cleanup();
        this.forceDisconnect();
        return reject(new Error('Failed to create command packets'));
      }

      this.log(`[DEBUG] Sending fallback press command...`);
      writeChar.write(pressPacket, true, (error) => {
        if (error) {
          this.log(`[DEBUG] Press command error: ${error}`);
        } else {
          this.log('[DEBUG] Press command sent successfully');
        }
        setTimeout(() => {
          if (sequenceComplete || peripheral.state !== 'connected') return;
          this.log(`[DEBUG] Sending fallback release command...`);
          writeChar.write(releasePacket, true, (error) => {
            if (error) {
              this.log(`[DEBUG] Release command error: ${error}`);
            } else {
              this.log('[DEBUG] Release command sent successfully');
            }
            sequenceComplete = true;
            clearTimeout(operationTimeout);
            cleanup();
            setTimeout(() => {
              this.forceDisconnect();
              this.log(`[DEBUG] Fallback Fingerbot operation completed!`);
              resolve();
            }, 500);
          });
        }, this.pressTime);
      });
    }
  }
}