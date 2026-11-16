@echo off
chcp 65001 >nul
title AstrBot
cd /d "%~dp0"

echo Starting AstrBot...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-astrbot.ps1"

echo.
echo AstrBot stopped.
pause >nul
