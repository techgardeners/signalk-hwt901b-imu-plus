

New version with added features of the great plugin W-Geronius/signalk-hwt901b-imu (https://github.com/W-Geronius/signalk-hwt901b-imu)

Original documentation (will be update)

======

SignalK node server plugin (BETA) reading roll, pitch and magnetic heading from [WITMOTION's HWT910B](https://www.wit-motion.com/10-axis/witmotion-hwt901b-rs232-10.html) sensor

#### INPUT:
as of device data sheet and own testing, cable plug respresenting the boat's stern:  
0x55 0x53 PitchL PitchH RollL RollH YawL YawH VL VH SUM

#### CALCULATION：
- Pitch (x axis):  
((PitchH<<8)|PitchL)/32768*180(°) 
- Roll  (y axis):  
((RollH<<8)|RollL)/32768*180(°) 
- Yaw   (z axis):  
((YawH<<8)|YawL)/32768*180(°)
- Version：  
(VH<<8)|VL
- Checksum：  
SUM=0x55+0x53+RollH+RollL+PitchH+PitchL+YawH+YawL+VH+VL (least significant byte must match SUM)
- Magnetic Heading:  
z axis value (yaw) plus an offset determined after calibration and install

#### PROCESSING:
- Gyroscope has to be calibrated by wit motion windows software prior to final placement onboard
- acceleration calibration, as well as levelling pitch & roll can be accomplished via the plugin's settings:

![image](https://user-images.githubusercontent.com/18160302/184508872-12e1ac4a-4126-4b6c-8608-5f2ab67f3f2c.png)

#### OUTPUT TO SIGNALK (in rad):

```JSON
{"updates":[{"$source":"WIT.n",
             "values":
               [{"path": "navigation.headingMagnetic",
                         "value":123.456},
                {"path": "navigation.attitude",
                         "value":{"roll":0.123456,
                         "pitch":-0.123456,
                         "yaw":null}}
                ]
            }]
}
```
