@echo off
chcp 65001 >nul
echo Starting QDII Fund Allocator Web UI...
echo Browser will open at http://localhost:3000
echo Close this window to stop the server.
echo.
start http://localhost:3000
node index.js --web
pause
