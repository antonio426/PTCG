param(
  [int]$ServerPort = 3001,
  [int]$ClientPort = 5173
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerDir = Join-Path $ScriptDir "server"
$ClientDir = Join-Path $ScriptDir "client"

Write-Host "=== PTCG Game Development Server ===" -ForegroundColor Cyan
Write-Host "Starting server on port $ServerPort..." -ForegroundColor Yellow

$serverJob = Start-Job -Name "ptcg-server" -ScriptBlock {
  param($dir, $port)
  Set-Location $dir
  $env:PORT = $port
  & "C:\Program Files\nodejs\npx.cmd" tsx src/index.ts
} -ArgumentList $ServerDir, $ServerPort

Start-Sleep -Seconds 3

Write-Host "Starting client on port $ClientPort..." -ForegroundColor Yellow

$clientJob = Start-Job -Name "ptcg-client" -ScriptBlock {
  param($dir)
  Set-Location $dir
  & "C:\Program Files\nodejs\npx.cmd" vite --port $using:ClientPort
} -ArgumentList $ClientDir

Write-Host ""
Write-Host "Server: http://localhost:$ServerPort" -ForegroundColor Green
Write-Host "Client: http://localhost:$ClientPort" -ForegroundColor Green
Write-Host ""
Write-Host "Press Ctrl+C to stop all services" -ForegroundColor Cyan

while ($true) {
  Start-Sleep -Seconds 1
  $s = Get-Job -Name "ptcg-server" -ErrorAction SilentlyContinue
  $c = Get-Job -Name "ptcg-client" -ErrorAction SilentlyContinue
  if (-not $s -and -not $c) { break }
  if ($s.State -eq 'Failed') {
    Write-Host "Server failed!" -ForegroundColor Red
    Receive-Job $s
    break
  }
  if ($c.State -eq 'Failed') {
    Write-Host "Client failed!" -ForegroundColor Red
    Receive-Job $c
    break
  }
}

Get-Job -Name "ptcg-*" -ErrorAction SilentlyContinue | Stop-Job
Get-Job -Name "ptcg-*" -ErrorAction SilentlyContinue | Remove-Job
Write-Host "Services stopped." -ForegroundColor Yellow
