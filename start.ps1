# ResuForge startup script
# Starts the backend and frontend concurrently.
# Ensures Node.js and MiKTeX (pdflatex) are on PATH even if this terminal
# was opened before they were installed.

$ErrorActionPreference = "Stop"

# --- Ensure Node.js is on PATH ---
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  $nodeDir = "C:\Program Files\nodejs"
  if (Test-Path "$nodeDir\node.exe") {
    $env:Path = "$nodeDir;" + $env:Path
  } else {
    Write-Host "ERROR: Node.js not found. Install it or run install.ps1 first." -ForegroundColor Red
    exit 1
  }
}

# --- Ensure MiKTeX (pdflatex) is on PATH ---
if (-not (Get-Command pdflatex -ErrorAction SilentlyContinue)) {
  $miktexCandidates = @(
    "$env:LOCALAPPDATA\Programs\MiKTeX\miktex\bin\x64",
    "C:\Program Files\MiKTeX\miktex\bin\x64"
  )
  $miktexDir = $miktexCandidates | Where-Object { Test-Path "$_\pdflatex.exe" } | Select-Object -First 1
  if ($miktexDir) {
    $env:Path = "$miktexDir;" + $env:Path
  } else {
    Write-Host "WARNING: pdflatex not found. The Recompile button will fail until MiKTeX is installed." -ForegroundColor Yellow
  }
}

Write-Host "Starting ResuForge..." -ForegroundColor Cyan

# Pass the resolved PATH into the child terminals so they inherit node + pdflatex
$resolvedPath = $env:Path

# Start backend
Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$env:Path = '$resolvedPath'; cd '$PSScriptRoot\backend'; node server.js"

Start-Sleep -Seconds 1

# Start frontend
Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$env:Path = '$resolvedPath'; cd '$PSScriptRoot\frontend'; npm run dev"

Write-Host ""
Write-Host "Backend:  http://localhost:3001" -ForegroundColor Green
Write-Host "Frontend: http://localhost:3000" -ForegroundColor Green
Write-Host ""
Write-Host "Open http://localhost:3000 in your browser." -ForegroundColor Yellow
