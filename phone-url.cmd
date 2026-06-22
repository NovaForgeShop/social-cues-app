@echo off
setlocal
echo Social Cues phone test URLs
echo.
echo Make sure your phone is on the same Wi-Fi as this computer.
echo Open one of these URLs on your phone:
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' } | ForEach-Object { 'http://' + $_.IPAddress + ':4177' }"
echo.
echo If none work, Windows Firewall may be blocking local network access.
pause
