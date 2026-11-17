@echo off
rem Stops the ZodiacPatent Attorney Email Automation backend and frontend.
title ZodiacPatent Attorney Email Automation - Stopping
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher.ps1" stop
echo.
timeout /t 3 >nul 2>nul
exit /b 0
