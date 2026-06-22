@echo off
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" server.mjs > server.out.log 2> server.err.log
