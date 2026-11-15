@echo off
setlocal EnableExtensions

rem Strict-NAT viewer launcher for Windows (cmd.exe).
rem Usage: viewer-windows.cmd [direct|turn] [session]
rem The session token is read from TOKIMEKI_SESSION_TOKEN or prompted.

cd /d "%~dp0..\.."

set "MODE=%~1"
if "%MODE%"=="" set "MODE=direct"
if /i "%MODE%"=="direct" goto :mode_ok
if /i "%MODE%"=="turn" goto :mode_ok
echo Usage: %~nx0 ^<direct^|turn^> [session]
exit /b 2
:mode_ok

if not defined TOKIMEKI_SESSION if not "%~2"=="" set "TOKIMEKI_SESSION=%~2"
if not defined TOKIMEKI_SESSION set /p TOKIMEKI_SESSION=Session name:
if not defined TOKIMEKI_SESSION_TOKEN set /p TOKIMEKI_SESSION_TOKEN=Session token:
if not defined TOKIMEKI_SESSION (
  echo Session name is required
  exit /b 2
)
if not defined TOKIMEKI_SESSION_TOKEN (
  echo Session token is required
  exit /b 2
)

set "TOKIMEKI_RELAY_URL=wss://relay.tokiapi.app"
set "TOKIMEKI_P2P=auto"
set "TOKIMEKI_LOG_LEVEL=debug"

if not exist "packages\cli\dist\index.js" (
  echo Building CLI...
  call npm ci || exit /b 1
  call npm run build || exit /b 1
)

node scripts\strictnat\viewer-runner.mjs --mode %MODE% --bytes 1048576 --label win 2> "attach-win-%MODE%.log"
set "CODE=%ERRORLEVEL%"
echo Viewer exited with code %CODE%. Log: attach-win-%MODE%.log
exit /b %CODE%
