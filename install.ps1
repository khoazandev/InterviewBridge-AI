<#
.SYNOPSIS
    One-line Windows 11 installer for InterviewBridge AI (.exe + LiveCaptionsTranslator + Agent Skill).
    Usage: irm https://raw.githubusercontent.com/khoazandev/InterviewBridge-AI/main/install.ps1 | iex
#>
$ErrorActionPreference = "Stop"

$RepoSlug = "khoazandev/InterviewBridge-AI"
$RawBase = "https://raw.githubusercontent.com/$RepoSlug/main"
$ReleaseBase = "https://github.com/$RepoSlug/releases/latest/download"
$InstallDir = Join-Path $HOME "InterviewBridge-AI"

Write-Host "=== InterviewBridge AI Installer (Windows 11) ===" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# 1. Install AI Agent Skill
$SkillTargets = @((Join-Path $HOME ".agents\skills\interview-bridge"))
if (Test-Path (Join-Path $HOME ".claude")) {
    $SkillTargets += (Join-Path $HOME ".claude\skills\interview-bridge")
}

$LocalRoot = if ($PSScriptRoot) { $PSScriptRoot } else { $null }
foreach ($SkillDest in $SkillTargets) {
    $ScriptsDir = Join-Path $SkillDest "scripts"
    New-Item -ItemType Directory -Force -Path $ScriptsDir | Out-Null

    if ($LocalRoot -and (Test-Path (Join-Path $LocalRoot "skills\interview-bridge\SKILL.md"))) {
        Copy-Item (Join-Path $LocalRoot "skills\interview-bridge\SKILL.md") (Join-Path $SkillDest "SKILL.md") -Force
        Copy-Item (Join-Path $LocalRoot "scripts\context_builder.py") (Join-Path $ScriptsDir "context_builder.py") -Force
    } else {
        curl.exe -fLsS --retry 3 -o (Join-Path $SkillDest "SKILL.md") "$RawBase/skills/interview-bridge/SKILL.md"
        curl.exe -fLsS --retry 3 -o (Join-Path $ScriptsDir "context_builder.py") "$RawBase/scripts/context_builder.py"
    }
    Write-Host "[1/3] Installed Agent Skill -> $SkillDest" -ForegroundColor Green
}

# 2. Download Desktop App Setup & LiveCaptions Translator
$SetupExe = Join-Path $InstallDir "InterviewBridge-AI-Setup.exe"
$LctExe = Join-Path $InstallDir "LiveCaptionsTranslator.exe"

Write-Host "[2/3] Downloading InterviewBridge-AI-Setup.exe..." -ForegroundColor Yellow
curl.exe -fL --retry 3 -o $SetupExe "$ReleaseBase/InterviewBridge-AI-Setup.exe"

Write-Host "      Downloading LiveCaptionsTranslator.exe..." -ForegroundColor Yellow
curl.exe -fL --retry 3 -o $LctExe "$ReleaseBase/LiveCaptionsTranslator.exe"

# 3. Create 1-click Desktop launcher
$LauncherPath = Join-Path $HOME "Desktop\Launch-InterviewBridge.bat"
$LauncherContent = @"
@echo off
chcp 65001 >nul
if exist "$LctExe" (
    start "" "$LctExe"
)
if exist "%LOCALAPPDATA%\InterviewBridgeAI\InterviewBridge AI.exe" (
    start "" "%LOCALAPPDATA%\InterviewBridgeAI\InterviewBridge AI.exe"
) else if exist "%USERPROFILE%\Desktop\InterviewBridge AI.lnk" (
    start "" "%USERPROFILE%\Desktop\InterviewBridge AI.lnk"
) else (
    echo InterviewBridge AI app not installed yet. Run $SetupExe first.
    pause
)
"@
Set-Content -Path $LauncherPath -Value $LauncherContent -Encoding ASCII
Write-Host "[3/3] Created Desktop launcher -> $LauncherPath" -ForegroundColor Green

Write-Host ""
Write-Host "Launching InterviewBridge-AI-Setup.exe..." -ForegroundColor Cyan
Start-Process $SetupExe

Write-Host ""
Write-Host "Done! Next tips:" -ForegroundColor Green
Write-Host "  - Press Win + Ctrl + L once on Windows 11 to download English (US) Live Captions."
Write-Host "  - Open 'CV + JD Studio' inside InterviewBridge AI to import your CV (.pdf/.docx/.md) and JD."
Write-Host "  - Use $LauncherPath before each interview to open both LiveCaptionsTranslator and InterviewBridge AI."
