**markedown for fingerbot DP values
switch_1	Boolean	
"{true,false}"
mode	Enum	
{
  "range": [
    "click",
    "switch",
    "prog"
  ]
}
down_percent	Integer	
{
  "unit": "",
  "min": 51,
  "max": 100,
  "scale": 0,
  "step": 1
}
sustain_time	Integer	
{
  "unit": "s",
  "min": 0,
  "max": 10,
  "scale": 0,
  "step": 1
}
control_back	Enum	
{
  "range": [
    "up_off",
    "up_on"
  ]
}
battery_percentage	Integer	
{
  "unit": "",
  "min": 0,
  "max": 100,
  "scale": 0,
  "step": 1
}
up_percent	Integer	
{
  "unit": "",
  "min": 0,
  "max": 50,
  "scale": 0,
  "step": 1
}
tap_enable	Boolean	
"{true,false}"
click	Boolean	
"{true,false}"
custom_prog	Raw	
{
  "maxlen": 128
}
factory_data	Raw	
{
  "maxlen": 128
}
total_movement	Integer	
{
  "unit": "",
  "min": 0,
  "max": 1000000,
  "scale": 0,
  "step": 1
}
custom_timer	Raw	
{
  "maxlen": 128
}
custom_week_prog_1	Raw	
{
  "maxlen": 128
}
custom_week_prog_2	Raw	
{
  "maxlen": 128
}
custom_week_prog_3	Raw	
{
  "maxlen": 128
}
custom_week_prog_4	Raw	
{
  "maxlen": 128
}
calibrate	Boolean	
"{true,false}"
resistance	Integer	
{
  "unit": "",
  "min": 10,
  "max": 20,
  "scale": 1,
  "step": 1
}
adaptive_movement	Boolean	
"{true,false}"
up_gain	Integer	
{
  "unit": "",
  "min": 80,
  "max": 120,
  "scale": 2,
  "step": 1
}