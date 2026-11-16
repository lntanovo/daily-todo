@echo off
chcp 65001 >nul
title QQ Bot Launcher
cd /d "%~dp0"

echo ==========================================
echo   Starting AstrBot + SnowLuma
echo   Order: AstrBot first (it opens 6199),
echo          SnowLuma second (it connects in).
echo ==========================================
echo.

start "AstrBot" cmd /c ""%~dp0Start-AstrBot.cmd""

echo Waiting 10s for AstrBot to be ready...
timeout /t 10 /nobreak >nul

start "SnowLuma" cmd /c ""%~dp0Start-SnowLuma.cmd""

echo.
echo Both windows launched.
echo   AstrBot dashboard : http://127.0.0.1:6185
echo   SnowLuma console  : http://127.0.0.1:5099
echo.
echo Closing this window in 5s...
timeout /t 5 /nobreak >nul
