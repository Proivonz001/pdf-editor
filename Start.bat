@echo off
chcp 65001 >nul
cd /d "%~dp0"
title PDF Editor - local server (do NOT close this window)
echo ============================================================
echo    PDF EDITOR - starting...
echo.
echo    The app will open in your browser at:
echo        http://localhost:8799/
echo.
echo    Do NOT close this window while using the app.
echo    To quit the app: close this window.
echo ============================================================
echo.

rem Open the browser (the server starts right after)
start "" "http://localhost:8799/"

rem Start the local mini-server (Python). Everything stays on your PC.
where python >nul 2>nul
if %errorlevel%==0 (
  python -m http.server 8799
) else (
  py -m http.server 8799
)

echo.
echo Server stopped. You can close this window.
pause >nul
