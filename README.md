# homebridge-moes-fingerbot

A [Homebridge](https://homebridge.io/) plugin for controlling MOES (Tuya-based) Fingerbot devices over Bluetooth.

## Features

- **Switch Service:** Exposes your Fingerbot as a HomeKit switch.
- **Press Action:** Triggers the Fingerbot to press a button for a configurable duration.
- **Battery Service:** (Experimental) Attempts to read and report the battery level from the device.
- **Debug Logging:** Detailed logs for Bluetooth scanning, connection, command attempts, and characteristic discovery.

## Installation

1. Install Homebridge (if you haven't already).
2. Install this plugin:
   ```sh
   npm install -g homebridge-moes-fingerbot
   ```
3. Add the accessory to your Homebridge `config.json`:

   ```json
   {
     "accessories": [
       {
         "accessory": "MoesFingerbot",
         "name": "Fingerbot",
         "address": "XX:XX:XX:XX:XX:XX", // Replace with your device's Bluetooth address
         "pressTime": 3000,
         "scanDuration": 5000,
         "scanRetries": 3,
         "scanRetryCooldown": 1000
       }
     ]
   }
   ```

## Configuration Options

| Key                | Description                                         | Default   |
|--------------------|-----------------------------------------------------|-----------|
| `accessory`        | Must be `"MoesFingerbot"`                           |           |
| `name`             | Name to display in HomeKit                          | "MOES Fingerbot" |
| `address`          | Bluetooth MAC address of your Fingerbot (required)  |           |
| `pressTime`        | Button press duration in ms                         | 3000      |
| `scanDuration`     | Scan timeout per attempt in ms                      | 5000      |
| `scanRetries`      | Number of scan retries before giving up             | 3         |
| `scanRetryCooldown`| Delay between scan retries in ms                    | 1000      |

## How It Works

- When you turn the switch **on** in HomeKit, the plugin scans for your Fingerbot, connects, and sends a press command.
- The plugin tries several command formats for compatibility with different firmware versions.
- After a successful press, the switch automatically turns off after 1 second.
- The plugin attempts to read all readable characteristics for battery information and logs the results for debugging.

## Debugging

Enable debug logging in Homebridge to see detailed output, including:
- Bluetooth scanning and connection events
- All discovered services and characteristics
- Results of command attempts
- Raw data from readable characteristics (for battery discovery)

## Notes

- Battery level reporting is experimental. Check your logs for lines like `[DEBUG] Read from characteristic 2a19: ...` to help identify the correct battery characteristic.
- Only one Fingerbot device per accessory instance is supported (by Bluetooth address).
- Requires a compatible Bluetooth adapter and permissions.

## Troubleshooting

- Ensure your Bluetooth adapter is powered on and not blocked by other software.
- Place your Homebridge server close to the Fingerbot for best results.
- If you encounter repeated scan retries, check for Bluetooth interference or try increasing `scanDuration`.

## License

MIT

---
Contributions and pull requests are welcome!