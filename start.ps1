# ResuForge startup script
# Starts the backend and frontend concurrently

Write-Host "Starting ResuForge..." -ForegroundColor Cyan

# Start backend
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$PSScriptRoot\backend'; node server.js" -WindowStyle Normal

# Give backend a moment to start
Start-Sleep -Seconds 1

# Start frontend
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$PSScriptRoot\frontend'; npm run dev" -WindowStyle Normal

Write-Host ""
Write-Host "Backend:  http://localhost:3001" -ForegroundColor Green
Write-Host "Frontend: http://localhost:3000" -ForegroundColor Green
Write-Host ""
Write-Host "Open http://localhost:3000 in your browser." -ForegroundColor Yellow
