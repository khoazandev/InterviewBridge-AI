@echo off
chcp 65001 >nul
where python >nul 2>nul
if %errorlevel%==0 (
    echo [1/3] Dong bo CV + JD tu thu muc user-data ^(neu co^)...
    python "%~dp0scripts\context_builder.py" --auto-sync
)
if exist "%~dp0bin\LiveCaptionsTranslator.exe" (
    echo [2/3] Khoi dong LiveCaptions Translator ^(Phu de Anh - Viet 0ms^)...
    start "" /D "%~dp0bin" "%~dp0bin\LiveCaptionsTranslator.exe"
)
echo [3/3] Khoi dong InterviewBridge AI...
cd /d "%~dp0app"
call npm start
