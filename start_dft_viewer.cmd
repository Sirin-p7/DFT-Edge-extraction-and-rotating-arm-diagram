@echo off
setlocal
cd /d "%~dp0"

echo LLM line-art Fourier viewer
echo.
echo Select channel:
echo   1. Normal channel (results_v2 / XDoG_Guide)
echo   2. API channel    (results_api / API_Line)
echo.
set /p VIEWER_CHANNEL_CHOICE=Enter 1 or 2 [2]:

if "%VIEWER_CHANNEL_CHOICE%"=="1" (
    set VIEWER_CHANNEL=normal
) else (
    set VIEWER_CHANNEL=api
)

powershell -NoExit -ExecutionPolicy Bypass -File "%~dp0run_dft_viewer_server.ps1" -Channel "%VIEWER_CHANNEL%"
