@echo off
chcp 65001 >nul
title SnowLuma
cd /d "%~dp0"

echo Starting SnowLuma...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-snowluma.ps1"

echo.
echo SnowLuma stopped.
pause >nul
