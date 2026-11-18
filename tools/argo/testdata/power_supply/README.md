Hand-written imitations of `/sys/class/power_supply` (Linux kernel ABI: Documentation/ABI/testing/sysfs-class-power).
They are NOT recordings from a real laptop: values are plausible, units as the ABI gives them (µW, µA, µV, percent).
Replace or add a case from a real host with `cp -rL /sys/class/power_supply <case>` (text files only).

| Case | What it imitates |
|---|---|
| weak-charger | mains online, battery still discharging at 12.3 W |
| charge-limit | mains online, battery held at an 80% charge limit ("Not charging") |
| on-battery | unplugged, discharging at 9 W, limit file present at 100 |
| idle-at-full | mains online, firmware says "Discharging" at 100% with a zero rate: not a drain |
| current-only | a driver that reports current_now (negative while discharging) and no power_now |
| no-rate | mains online, "Discharging", no rate files, unreadable limit |
