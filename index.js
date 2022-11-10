const PLUGIN_ID = 'signalk-hwt901b-imu-plus';
const SerialPort = require('serialport')
const DelimiterParser = require('@serialport/parser-delimiter')

const freqs = ["0.2Hz", "0.5Hz", "1Hz", "2Hz", "5Hz", "10Hz", "20Hz", "50Hz"]

module.exports = function (app) {
    var plugin = {};
    var statusMessage

    plugin.id = PLUGIN_ID
    plugin.name = "WITMOTION HWT901B serial IMU"
    plugin.description = "SignalK node server plugin reading roll, pitch and magnetic heading from WITMOTION's HWT910B sensor"

    plugin.schema = {
        type: "object",
        required: ["usbDevice", "freq", "zOffset"],
        properties: {
            devices: {
                type: 'array',
                title: 'Devices',
                items: {
                    type: 'object',
                    properties: {
                        usbDevice: {
                            type: "string",
                            title: "USB Device Name",
                            description: "USB device: e.g. /dev/ttyUSB0 or COM3 (Windows)",
                            default: "/dev/ttyUSB0"
                        },
                        freq: {
                            type: "string",
                            title: "Return Rate",
                            description: "deltas/second",
                            default: "2Hz",
                            enum: freqs
                        },
                        accCal: {
                            type: "boolean",
                            title: "Accelerometer calibration",
                            description: "automatically resets to false after execution",
                            default: false
                        },
                        angleRef: {
                            type: "boolean",
                            title: "Reset Angle Reference",
                            description: "set roll & pitch to level, automatically resets to false after execution",
                            default: false
                        },
                        zOffset: {
                            type: "number",
                            title: "Heading Offset",
                            description: "heading degrees offset (-180.0° to 180.0°)",
                            default: 0.0
                        }
                    }
                }
            }
        }
    }

    const setPluginStatus = app.setPluginStatus
      ? (msg) => {
          app.setPluginStatus(msg)
          statusMessage = msg
      }
      : (msg) => { statusMessage = msg }

    const setPluginError = app.setPluginError
      ? (msg) => {
          app.setPluginError(msg)
          statusMessage = `error: ${msg}`
      }
      : (msg) => { statusMessage = `error: ${msg}` }

    plugin.start = function (options) {
        plugin.reconnectDelay = 1000
        let devices = options.devices
        plugin.serialPorts = []
        devices.forEach((device, index) => {
            plugin.connect(device, index)
            // todo: configure should only start when device is up and running!
            configureDevice(device, index)
            options.devices[index].accCal = false
            options.devices[index].angleRef = false
            app.savePluginOptions(options, () => { app.debug('Plugin options saved') });
        })
    }

    plugin.connect = function (device, index) {
        app.debug('plugin.connect')
        console.log(`connecting to ${device.usbDevice}:${index}`)
        try {
            let serial = new SerialPort(device.usbDevice, { baudRate: 9600 })
            plugin.serialPorts[index] = serial

            serial.on('open', function () {
                const parser = serial.pipe(new DelimiterParser({ delimiter: '\x55\x53' }))
                plugin.reconnectDelay = 1000
                parser.on('data', data => { parseData(device.zOffset, data, index) })
                setPluginStatus(`connected to ${device.usbDevice}:${index}`)
            })

            serial.on('error', function (err) {
                app.debug("plugin.connect.error")
                app.error(err.toString())
                setPluginError(err.toString())
                scheduleReconnect(device, index)
            })

            serial.on('close', function () {
                app.debug("plugin.connect.close")
                // scheduleReconnect(device, index)
            })
        }
        catch (err) {
            app.error(err)
            setPluginError(err.message)
            scheduleReconnect(device, index)
        }
    }

    function configureDevice(device, index) {

        const cmdUnlock = new Uint8Array([0xFF, 0xAA, 0x69, 0x88, 0xB5])

        var cmdFreq = new Uint8Array([0xFF, 0xAA, 0x03, 0x00, 0x00])
        cmdFreq[3] = freqs.indexOf(device.freq) + 1

        // set frequency unconditionally
        setTimeout(() => {
            sendCommand(cmdFreq)
            setTimeout(() => {
                saveConfig("frequency")
            }, 200)
        }, 10000)

        // set data set unconditionally
        setTimeout(() => {
            sendCommand(new Uint8Array([0xFF, 0xAA, 0x02, 0x48, 0x00]))
            setTimeout(() => {
                saveConfig("data set")
            }, 200)
        }, 12000)

        // calibrate acceleration if requested by plugin.options

        if (device.accCal) {
            setTimeout(() => {
                app.debug('calibrate acc ...')
                sendCommand(new Uint8Array([0xFF, 0xAA, 0x01, 0x01, 0x00]))
                app.debug('calibrating ...')
                setTimeout(() => {
                    sendCommand(new Uint8Array([0xFF, 0xAA, 0x01, 0x00, 0x00]))
                    setTimeout(() => {
                        saveConfig("acc calibration")
                    }, 200)
                }, 5000)
            }, 14000)
        }

        // reset angles if requested by plugin.options

        if (device.angleRef) {
            setTimeout(() => {
                app.debug('resetting x/y ...')
                sendCommand(new Uint8Array([0xFF, 0xAA, 0x01, 0x08, 0x00]))
                setTimeout(() => {
                    saveConfig("x/y level")
                }, 200)
            }, 20000)
        }

        function sendCommand(array) {
            plugin.serialPorts[index].write(cmdUnlock)      // unlock WIT configuration
            setTimeout(() => {
                plugin.serialPorts[index].write(array)      // write command after 200ms
                app.debug('command sent:', array)
            }, 200)
        }

        function saveConfig(comment) {
            plugin.serialPorts[index].write(cmdUnlock)      // unlock WIT configuration
            setTimeout(() => {                              // save WIT configuration after 200ms
                plugin.serialPorts[index].write(new Uint8Array([0xFF, 0xAA, 0x00, 0x00, 0x00]));
                app.debug('WIT config saved:', comment)
            }, 200)
        }
    }

    function parseData(zOffset, data, index) {

        const decodeWit = 0.0054931640625   // (180.00 / 32768)
        const factRad = 0.0174532925199     // * pi/180

        console.debug('parsed Data:', data)

        if (checkWitData(data)) { // TODO: refactoring check data (NOW always true)

            /******************************************************************
             * ****************************************************************
             * Time Output
             *
             * 0x55 0x50 YY MM DD hh mm ss msL msH SUM
             *
             * YY:Year, 20YY Year
             * MM:Month
             * DD:Day
             * hh:hour
             * mm:minute
             * ss:Second
             * ms:Millisecond
             * Millisecond calculate formula:
             * ms=((msH<<8)|msL)
             * Sum=0x55+0x51+YY+MM+DD+hh+mm+ss+ms+TL
             *
             * *****************************************************************
             *******************************************************************/

            const time_year = data.readUInt8(0)
            const time_month = data.readUInt8(1)
            const time_day = data.readUInt8(2)
            const time_hour = data.readUInt8(3)
            const time_minute = data.readUInt8(4)
            const time_second = data.readUInt8(5)
            const time_millisecond = data.readUInt16LE(6)
            const time_checksum = data.readUInt8(8)

            console.log(
              'Year: ', (2000 +time_year).toFixed(0),
              'Month: ', time_month.toFixed(0),
              'Day: ', time_day.toFixed(0),
              'Hour: ', time_hour.toFixed(0),
              'Minute: ', time_minute.toFixed(0),
              'Second: ', time_second.toFixed(0),
              'Millisecond: ', time_millisecond.toFixed(0)
            )


            /******************************************************************
             * ****************************************************************
             * Acceleration Output
             *
             * 0x55 0x51 AxL AxH AyL AyH AzL AzH TL TH SUM
             *
             * Calculate formula:
             * ax=((AxH<<8)|AxL)/32768*16g(g is Gravity acceleration, 9.8m/s2)
             * ay=((AyH<<8)|AyL)/32768*16g(g is Gravity acceleration, 9.8m/s2)
             * az=((AzH<<8)|AzL)/32768*16g(g is Gravity acceleration, 9.8m/s2)
             * Temperature calculated formular:
             * T=((TH<<8)|TL)/100 °C
             * Checksum:
             * Sum=0x55+0x51+AxH+AxL+AyH+AyL+AzH+AzL+TH+TL
             *
             * *****************************************************************
             *******************************************************************/

            const acc_offset = 9;
            const acc_header = data.readUInt8(acc_offset+0)
            const acc_ax = data.readInt16LE(acc_offset+2)/32768*16*9.8
            const acc_ay = data.readInt16LE(acc_offset+4)/32768*16*9.8
            const acc_az = data.readInt16LE(acc_offset+6)/32768*16*9.8
            const temp = data.readInt16LE(acc_offset+8)/100
            const acc_checksum = data.readUInt8(acc_offset+10)

            console.log(
              'acc_ax: ', acc_ax,
              'acc_ay: ', acc_ay,
              'acc_az: ', acc_az,
              'temp: ', temp
            )

            /******************************************************************
             * ****************************************************************
             * Angular Velocity Output
             *
             * 0x55 0x52 wxL wxH wyL wyH wzL wzH TL TH SUM
             *
             * Calculated formular:
             * wx=((wxH<<8)|wxL)/32768*2000(°/s)
             * wy=((wyH<<8)|wyL)/32768*2000(°/s)
             * wz=((wzH<<8)|wzL)/32768*2000(°/s)
             * Temperature calculated formular:
             * T=((TH<<8)|TL) /100 °C
             *
             * *****************************************************************
             *******************************************************************/

            const ang_offset = 20;
            const ang_header = data.readUInt8(ang_offset+0)
            const ang_wx = data.readInt16LE(ang_offset+2)/32768*2000
            const ang_wy = data.readInt16LE(ang_offset+4)/32768*2000
            const ang_wz = data.readInt16LE(ang_offset+6)/32768*2000
            const ang_temp = data.readInt16LE(ang_offset+8)/100
            const ang_checksum = data.readUInt8(ang_offset+10)

            console.log(
              'ang_wx: ', ang_wx,
              'ang_wy: ', ang_wy,
              'ang_wz: ', ang_wz,
              'temp: ', ang_temp
            )

            /******************************************************************
             * ****************************************************************
             * Angle Output
             *
             * 0x55 0x53 RollL RollH PitchL PitchH YawL YawH VL VH SUM
             *
             * Calculated formular:
             * Roll(X axis)Roll=((RollH<<8)|RollL)/32768*180(°)
             * Pitch(Y axis)Pitch=((PitchH<<8)|PitchL)/32768*180(°)
             * Yaw(Z axis)Yaw=((YawH<<8)|YawL)/32768*180(°)
             * Version calculated formula:
             * Version=(VH<<8)|VL
             * Checksum:
             * Sum=0x55+0x53+RollH+RollL+PitchH+PitchL+YawH+YawL+VH+VL
             *
             * *****************************************************************
             *******************************************************************/

            const a_offset = 31;
            const a_header = data.readUInt16LE(a_offset+ 0)
            const pitch = toRad(data.readUInt16LE(a_offset+ 2))
            const roll = toRad(data.readUInt16LE(a_offset+ 4))
            const yaw = toRad(data.readUInt16LE(a_offset+ 6))
            let hdm = (360.00 - yaw * decodeWit + zOffset);
            (hdm > 360) ? hdm = (hdm - 360) * factRad : hdm *= factRad
            const version = data.readUInt16LE(a_offset+ 8)
            const a_checksum = data.readUInt8(a_offset+ 10)

            console.debug(
              '° roll:', (roll / factRad).toFixed(6),
              '° pitch', (pitch / factRad).toFixed(6),
              '° heading:', (hdm / factRad).toFixed(6),
              '° yaw:', (yaw / factRad).toFixed(6)
            )

            /******************************************************************
             * ****************************************************************
             * Atmospheric Pressure and Height Output
             *
             * 0x55 0x56 P0 P1 P2 P3 H0 H1 H2 H3 SUM
             *
             * Calculated formular:
             * Atmospheric pressure P = (( P3<<24)| ( P2<<16)| ( P1<<8)| P0 (Pa)
             * Height H = (( H3<<24)| ( H2<<16)| ( H1<<8)| H0(cm)
             * Checksum:
             * Sum=0x55+0x54+P0+P1+P2+P3+H0+H1+H2+H3
             *
             * *****************************************************************
             *******************************************************************/

            const atmospheric_offset = 42;
            const atmospheric_header = data.readInt16LE(atmospheric_offset+ 0);
            const atmospheric_pressure = (parseInt(data.readInt32LE(atmospheric_offset+ 2))/100)
            const atmospheric_height = (parseInt(data.readInt32LE(atmospheric_offset+ 6))/100)
            const atmospheric_checksum = data.readUInt8(a_offset+ 10)

            console.debug(
              '(hPa) Pressure:', atmospheric_pressure.toFixed(2),
              '(m) Altitude:', atmospheric_height.toFixed(2),
            )

            /******************************************************************
             * ****************************************************************
             * Atmospheric Pressure and Height Output
             *
             * 0x55 0x56 P0 P1 P2 P3 H0 H1 H2 H3 SUM
             *
             * Calculated formular:
             * Atmospheric pressure P = (( P3<<24)| ( P2<<16)| ( P1<<8)| P0 (Pa)
             * Height H = (( H3<<24)| ( H2<<16)| ( H1<<8)| H0(cm)
             * Checksum:
             * Sum=0x55+0x54+P0+P1+P2+P3+H0+H1+H2+H3
             *
             * *****************************************************************
             *******************************************************************/



            //  send to SK
            console.log( {
                updates: [{
                    '$source': 'WIT.' + (index + 1).toString(),
                    values: [
                        {
                            path: 'HWT901B.time',
                            value: {
                                year: time_year,
                                month: time_month,
                                day: time_day,
                                hour : time_hour,
                                minute: time_minute,
                                second: time_second,
                                millisecond: time_millisecond
                            }
                        },
                        {
                            path: 'navigation.acceleration',
                            value: {
                                ax: acc_ax,
                                ay: acc_ay,
                                az: acc_az
                            }
                        },
                        {
                            path: 'navigation.angular_velocity',
                            value: {
                                wx: ang_wx,
                                wy: ang_wy,
                                wz: ang_wz
                            }
                        },
                        {
                            path: 'environment.pressure',
                            value: atmospheric_pressure
                        },
                        {
                            path: 'environment.height',
                            value: atmospheric_height
                        },
                        {
                            path: 'environment.temperature',
                            value: temp
                        },
                        {
                            path: 'navigation.headingMagnetic',
                            value: hdm
                        },
                        {
                            path: 'navigation.attitude',
                            value: {
                                roll: roll,
                                pitch: pitch,
                                yaw: yaw
                            }
                        }
                    ]
                }]
            })
        }

        function toRad(value) {
            value *= decodeWit
            value >= 180.00 ? value -= 360 : value
            return (value * factRad)
        }

        function checkWitData(data) {
            if (data.byteLength == 9) {
                var checksum = 168  // 0x55 + 0x53  Angle record
                for (i = 0; i < 8; i++) { checksum += data.readUInt8(i) }
                if (data.readUInt8(8) == checksum % 256) { return true }
            }

            return true;
        }

        return false
    }

    function scheduleReconnect(device, index) {
        plugin.reconnectDelay *= plugin.reconnectDelay < 60 * 1000 ? 1.5 : 1
        const msg = `Not connected (retry delay ${(plugin.reconnectDelay / 1000).toFixed(0)} s)`
        console.log(msg)
        setPluginError(msg)
        setTimeout(plugin.connect.bind(plugin, device, index), plugin.reconnectDelay)
    }

    plugin.statusMessage = () => {
        return statusMessage
    }

    plugin.stop = function () {
        app.debug('plugin.stop')
        if (plugin.serialPorts) {
            plugin.serialPorts.forEach(serial => {
                  serial.close()
              }
            )
            plugin.serialPorts = []
        }
    }

    return plugin
}
