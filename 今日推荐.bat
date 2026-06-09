@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
node index.js --dry-run
pause
