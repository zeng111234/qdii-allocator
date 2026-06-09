@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
echo ========================================
echo   QDII Fund WeChat Bot
echo ========================================
echo.
echo Please make sure WeChat desktop is open and logged in.
echo.
pause
node wechat.js
pause
