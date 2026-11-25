@echo off
chcp 65001 >nul
where python >nul 2>nul
if %errorlevel%==0 (
    echo [1/4] Dong bo CV + JD tu thu muc user-data ^(neu co^)...
    python "%~dp0scripts\context_builder.py" --auto-sync
    echo [2/4] Khoi dong CTranslate2 GPU Speech + En-^>Vi Engine ^(cong 8989^)...
    powershell -NoProfile -WindowStyle Hidden -Command "if (-not (Get-NetTCPConnection -LocalPort 8989 -State Listen -ErrorAction SilentlyContinue)) { Start-Process python -ArgumentList '\"%~dp0scripts\ct2_engine.py\" --port 8989' -WindowStyle Hidden }"
)
if exist "%~dp0bin\LiveCaptionsTranslator.exe" (
    echo [3/4] Khoi dong LiveCaptions Translator ^(Phu de Anh - Viet 0ms^)...
    start "" /D "%~dp0bin" "%~dp0bin\LiveCaptionsTranslator.exe"
)
echo [4/4] Khoi dong InterviewBridge AI...
cd /d "%~dp0app"
call npm start
