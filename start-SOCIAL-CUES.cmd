@echo off
setlocal
cd /d "%~dp0"
echo Starting Social Cues local test app...
echo Open http://127.0.0.1:4177 in your browser.
echo For phone access, run phone-url.cmd and open the shown URL on your phone.
echo.
if exist "C:\Program Files\nodejs\node.exe" (
  "C:\Program Files\nodejs\node.exe" server.mjs
) else (
  echo Node.js was not found at C:\Program Files\nodejs\node.exe
  echo Try opening ..\OPEN-Social Cues.html instead.
)
echo.
echo Social Cues stopped or could not start.
pause
