@echo off
rem Starts the backend and frontend in the background and opens the app in Google Chrome.
title ZodiacPatent Attorney Email Automation - Starting
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher.ps1" start
if errorlevel 1 (
  echo.
  echo The application could not be started. See the message above.
  pause
  exit /b 1
)
exit /b 0
