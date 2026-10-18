@echo off
setlocal
cd /d "%~dp0"
echo.
echo   拾光 · 日常办公工作台
echo   正在启动本地服务...
echo.
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Milliseconds 900; Start-Process 'http://127.0.0.1:4173'"
node server.mjs
if errorlevel 1 (
  echo.
  echo   启动失败。请确认已安装 Node.js，或直接双击 index.html 使用。
  pause
)
