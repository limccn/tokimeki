@echo off
setlocal EnableExtensions

rem Strict-NAT host launcher for Windows (cmd.exe).
rem Usage: host-windows.cmd [mac|win] [direct|turn]
rem Master token comes from TOKIMEKI_MASTER_TOKEN or
rem %USERPROFILE%\.tokimeki\master-token. A random test session token is
rem generated unless TOKIMEKI_SESSION_TOKEN is already set.

cd /d "%~dp0..\.."

set "LABEL=%~1"
if "%LABEL%"=="" set "LABEL=mac"
set "MODE=%~2"
if "%MODE%"=="" set "MODE=direct"

if /i "%MODE%"=="direct" goto :mode_ok
if /i "%MODE%"=="turn" goto :mode_ok
echo Usage: %~nx0 ^<mac^|win^> ^<direct^|turn^>
exit /b 2
:mode_ok

set "POLICY=all"
if /i "%MODE%"=="turn" set "POLICY=relay"

if not exist "packages\cli\dist\index.js" (
  echo Building CLI...
  call npm ci || exit /b 1
  call npm run build || exit /b 1
)

if not defined TOKIMEKI_MASTER_TOKEN (
  if not exist "%USERPROFILE%\.tokimeki\master-token" (
    echo Missing master token: set TOKIMEKI_MASTER_TOKEN or create "%USERPROFILE%\.tokimeki\master-token"
    exit /b 1
  )
  for /f "usebackq delims=" %%A in ("%USERPROFILE%\.tokimeki\master-token") do set "TOKIMEKI_MASTER_TOKEN=%%A"
)

if defined TOKIMEKI_SESSION_TOKEN goto :token_ok
set "TOKEN_FILE=%TEMP%\tokimeki-strictnat-token-%RANDOM%-%RANDOM%.txt"
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > "%TOKEN_FILE%"
for /f "usebackq delims=" %%A in ("%TOKEN_FILE%") do set "TOKIMEKI_SESSION_TOKEN=%%A"
del "%TOKEN_FILE%" >nul 2>nul
:token_ok

if not defined STAMP set "STAMP=%RANDOM%%RANDOM%"
if not defined TOKIMEKI_SESSION set "TOKIMEKI_SESSION=strictnat-local-%LABEL%-%MODE%-%STAMP%"

set "TOKIMEKI_RELAY_URL=wss://relay.tokiapi.app"
set "TOKIMEKI_P2P=auto"
set "TOKIMEKI_ICE_TRANSPORT_POLICY=%POLICY%"
set "TOKIMEKI_LOG_LEVEL=debug"
set "LOG=host-%LABEL%-%MODE%-%STAMP%.log"

echo.
echo Session: %TOKIMEKI_SESSION%
echo Token:   %TOKIMEKI_SESSION_TOKEN%
echo Viewer:  %LABEL%   Mode: %MODE%   Policy: %POLICY%
echo Log:     %LOG%
echo.
echo Start the viewer script with the Session and Token above, then press a key.
pause >nul

node packages\cli\dist\index.js run -- node scripts\perf\emit-tui.mjs 2> "%LOG%"
set "CODE=%ERRORLEVEL%"
echo Host exited with code %CODE%. Log: %LOG%
exit /b %CODE%
