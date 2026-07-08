# ResuForge - Install dependencies
# Run this once before starting the app

Write-Host "Installing ResuForge dependencies..." -ForegroundColor Cyan

Write-Host "`nInstalling backend deps..." -ForegroundColor Yellow
Set-Location "$PSScriptRoot\backend"
npm install

Write-Host "`nInstalling frontend deps..." -ForegroundColor Yellow
Set-Location "$PSScriptRoot\frontend"
npm install

Write-Host "`nDone! Run .\start.ps1 to launch ResuForge." -ForegroundColor Green
Set-Location $PSScriptRoot
