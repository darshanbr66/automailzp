@echo off
setlocal EnableExtensions
title ZodiacPatent Attorney Email Automation - Setup
cd /d "%~dp0.."

echo ============================================================
echo  ZodiacPatent Attorney Email Automation - one-time setup
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install the LTS version from https://nodejs.org
  echo then run this setup again.
  goto :fail
)
node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>20||(a===20&&b>=19)?0:1)"
if errorlevel 1 (
  echo Node.js 20.19 or newer is required. Installed version:
  node -v
  echo Please install the current LTS version from https://nodejs.org
  goto :fail
)
echo Using Node.js
node -v
echo.

echo [1/3] Installing backend dependencies...
call npm install --prefix backend --no-audit --no-fund
if errorlevel 1 goto :fail
echo.

echo [2/3] Installing frontend dependencies...
call npm install --prefix frontend --no-audit --no-fund
if errorlevel 1 goto :fail
echo.

echo [3/3] Preparing backend\.env ...
rem Creates backend\.env from the example only when it does not exist yet,
rem so an App Password you already pasted is never overwritten.
if not exist "backend\.env" (
  copy /y "backend\.env.example" "backend\.env" >nul
  if errorlevel 1 goto :fail
)
if not exist "backend\data" mkdir "backend\data"
echo backend\.env is ready.
echo.

echo ============================================================
echo  Setup complete.
echo.
echo  NEXT: generate an App Password in Hostinger hPanel
echo        (Emails - Mailboxes - your mailbox - three dots - App passwords),
echo        then open backend\.env in Notepad and paste it after SMTP_PASS=
echo        (see README.md, "Hostinger App Password").
echo ============================================================
echo.
choice /c YN /m "Create desktop shortcuts now"
if errorlevel 2 goto :done
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-shortcut.ps1"

:done
echo.
pause
exit /b 0

:fail
echo.
echo Setup did not complete. Please read the messages above.
pause
exit /b 1
