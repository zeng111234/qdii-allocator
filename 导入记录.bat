@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
echo Importing buys from data/buys.txt...
echo.
node index.js --import-file data/buys.txt
echo.
echo Done! Press any key to view portfolio...
pause >nul
node index.js --portfolio
pause
