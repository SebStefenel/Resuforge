# ResuForge - Install dependencies
# Run this once before starting the app.

$ErrorActionPreference = "Stop"

# --- Ensure Node.js is on PATH ---
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  $nodeDir = "C:\Program Files\nodejs"
  if (Test-Path "$nodeDir\node.exe") {
    $env:Path = "$nodeDir;" + $env:Path
  } else {
    Write-Host "ERROR: Node.js not found. Install from https://nodejs.org (LTS)." -ForegroundColor Red
    exit 1
  }
}

Write-Host "Installing ResuForge dependencies..." -ForegroundColor Cyan

Write-Host "`nInstalling backend deps..." -ForegroundColor Yellow
Set-Location "$PSScriptRoot\backend"
npm install

Write-Host "`nInstalling frontend deps..." -ForegroundColor Yellow
Set-Location "$PSScriptRoot\frontend"
npm install

# Some npm security configs hold back esbuild's postinstall, which downloads
# the platform binary Vite needs. Run it explicitly to be safe.
if (Test-Path ".\node_modules\esbuild\install.js") {
  Write-Host "`nEnsuring esbuild platform binary..." -ForegroundColor Yellow
  node ".\node_modules\esbuild\install.js"
}

Write-Host "`nDone! Run .\start.ps1 to launch ResuForge." -ForegroundColor Green
Set-Location $PSScriptRoot
