@echo off
setlocal EnableExtensions

rem Strict-NAT viewer using the published GitHub Packages CLI (cmd.exe).
rem Usage: viewer-github-windows.cmd [direct|turn] [session]
rem Requires a GitHub token with read:packages. The token is passed via
rem GITHUB_TOKEN and referenced from a local .npmrc; it is not written there.

set "SCRIPT_DIR=%~dp0"
set "WORK_DIR=%USERPROFILE%\.tokimeki-strictnat-viewer"
if defined TOKIMEKI_VIEWER_DIR set "WORK_DIR=%TOKIMEKI_VIEWER_DIR%"

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
if not defined GITHUB_TOKEN set /p GITHUB_TOKEN=GitHub token (read:packages):
if not defined TOKIMEKI_SESSION (
  echo Session name is required
  exit /b 2
)
if not defined TOKIMEKI_SESSION_TOKEN (
  echo Session token is required
  exit /b 2
)
if not defined GITHUB_TOKEN (
  echo GitHub token is required
  exit /b 2
)

if not exist "%WORK_DIR%" mkdir "%WORK_DIR%"
(
  echo @limccn:registry=https://npm.pkg.github.com
  echo //npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
) > "%WORK_DIR%\.npmrc"

echo Installing @limccn/tokimeki from GitHub Packages...
pushd "%WORK_DIR%"
call npm install --no-save --no-audit --no-fund @limccn/tokimeki
if errorlevel 1 (
  popd
  exit /b 1
)
popd

set "TOKIMEKI_VIEWER_WORKDIR=%WORK_DIR%"
set "TOKIMEKI_VIEWER_CLI=%WORK_DIR%\node_modules\@limccn\tokimeki\dist\index.js"
set "TOKIMEKI_RELAY_URL=wss://relay.tokiapi.app"
set "TOKIMEKI_P2P=auto"
set "TOKIMEKI_LOG_LEVEL=debug"

node "%SCRIPT_DIR%viewer-runner.mjs" --mode %MODE% --bytes 1048576 --label github-win 2> "attach-github-win-%MODE%.log"
set "CODE=%ERRORLEVEL%"
echo Viewer exited with code %CODE%. Log: attach-github-win-%MODE%.log
exit /b %CODE%
