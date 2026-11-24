<#
.SYNOPSIS
    Bootstrap InterviewBridge-AI dependencies and Windows 11 LiveCaptions binary.
#>
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "=== InterviewBridge AI Setup ===" -ForegroundColor Cyan

foreach ($cmd in @("node", "npm")) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Error "Missing required tool '$cmd'. Please install Node.js LTS first."
    }
}

Write-Host "[1/3] Installing Electron app dependencies in app\..." -ForegroundColor Yellow
Push-Location (Join-Path $RepoRoot "app")
try {
    npm install
} finally {
    Pop-Location
}

$BinDir = Join-Path $RepoRoot "bin"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$LctPath = Join-Path $BinDir "LiveCaptionsTranslator.exe"

if (-not (Test-Path $LctPath)) {
    Write-Host "[2/3] Downloading LiveCaptionsTranslator-win-x64-withruntime.exe..." -ForegroundColor Yellow
    $LctUrl = "https://github.com/SakiRinn/LiveCaptions-Translator/releases/download/v1.7.1300.1822/LiveCaptionsTranslator-win-x64-withruntime.exe"
    curl.exe -fL --retry 3 -o $LctPath $LctUrl
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Could not download LiveCaptionsTranslator.exe automatically. Download it from https://github.com/SakiRinn/LiveCaptions-Translator/releases"
    }
} else {
    Write-Host "[2/3] LiveCaptionsTranslator.exe already exists in bin\" -ForegroundColor Green
}

if (Get-Command python -ErrorAction SilentlyContinue) {
    Write-Host "[3/3] Checking Python document extraction support..." -ForegroundColor Yellow
    python (Join-Path $RepoRoot "scripts\context_builder.py") --self-test
} else {
    Write-Warning "Python 3 not found. Text/DOCX CLI auto-sync and PDF extraction require Python 3."
}

Write-Host ""
Write-Host "Setup complete! Next steps:" -ForegroundColor Green
Write-Host "  1. On Windows 11, press Win + Ctrl + L once to download English (US) Live Captions."
Write-Host "  2. Double-click start.bat to launch LiveCaptionsTranslator + InterviewBridge AI."
Write-Host "  3. Open 'CV + JD Studio' inside the app to import your CV & JD (or drop cv.pdf + jd.pdf in user-data\)."
