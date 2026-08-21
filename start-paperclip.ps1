$ErrorActionPreference = "SilentlyContinue"
$runtimeRoot = Join-Path $PSScriptRoot ".paperclip-runtime\opencode"
$env:PAPERCLIP_OPENCODE_RUNTIME_ROOT = $runtimeRoot
$node = "C:\Program Files\nodejs\node.exe"
$pnpm = "C:\Users\milos\AppData\Roaming\npm\pnpm.cmd"
$gateway = "C:\paperclip\mcp-sse-gateway.mjs"
$envFile = "C:\Users\milos\.paperclip\mcp.env"
$bridgePorts = 8931, 8941, 8942, 8943, 8944, 8945, 8946, 8947, 4098, 3103

function Load-EnvFile($path) {
  foreach ($line in Get-Content $path) {
    if ($line -match "^\s*([^#=]+)=(.*)$") {
      Set-Item -Path "Env:$($matches[1].Trim())" -Value $matches[2].Trim()
    }
  }
}

if (Test-Path $envFile) { Load-EnvFile $envFile }

if (-not (Test-Path -LiteralPath $runtimeRoot)) {
  New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
}

$apiUp = [bool](Get-NetTCPConnection -State Listen -LocalPort 3100 -ErrorAction SilentlyContinue)
$mcpUp = [bool](Get-NetTCPConnection -State Listen -LocalPort 3101 -ErrorAction SilentlyContinue)
$bridgesUp = @($bridgePorts | Where-Object { Get-NetTCPConnection -State Listen -LocalPort $_ -ErrorAction SilentlyContinue }).Count

if (-not $apiUp) {
Write-Host "[0/3] Czyszcze martwe procesy PostgreSQL po poprzedniej sesji..."
  $stale = Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*\.paperclip\instances\default\db*' }
  foreach ($p in $stale) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep 2
  Remove-Item "C:\Users\milos\.paperclip\instances\default\db\postmaster.pid" -Force -ErrorAction SilentlyContinue
}

if (-not $apiUp) {
  Write-Host "[1/3] Startuje Paperclip (pnpm dev, port 3100)..."
  Start-Process -FilePath $pnpm -ArgumentList "dev" -WorkingDirectory "C:\paperclip" `
    -RedirectStandardOutput "C:\paperclip\dev.log" -RedirectStandardError "C:\paperclip\dev.err.log" -WindowStyle Hidden
}

if (-not $mcpUp) {
  Write-Host "[2/3] Startuje MCP gateway (SSE, port 3101)..."
  Start-Process -FilePath $node -ArgumentList $gateway -WorkingDirectory "C:\paperclip" `
    -RedirectStandardOutput "C:\paperclip\mcp.log" -RedirectStandardError "C:\paperclip\mcp.err.log" -WindowStyle Hidden
}

Write-Host "[2.5/3] Startuje mostki narzedzi MCP (playwright 8931, git 8941, magicui 8942, npmrun 8943, clarity 8944, sender 8945, opencode 8946 + serve 4098, obsidian 8947, publiczny OAuth gateway 3103)..."
if ($bridgesUp -lt $bridgePorts.Count) {
  Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File C:\paperclip\mcp-bridges.ps1" -WindowStyle Hidden | Out-Null
} else {
  Write-Host "[2.5/3] Mostki MCP juz dzialaja; pomijam ponowne uruchomienie."
}

$cf = Get-Service cloudflared -ErrorAction SilentlyContinue
if ($cf -and $cf.Status -ne "Running") {
  Write-Host "[3/3] Startuje cloudflared (tunel)..."
  Start-Service cloudflared -ErrorAction SilentlyContinue
} else {
  Write-Host "[3/3] cloudflared: $($cf.Status)"
}

$deadline = (Get-Date).AddSeconds(240)
while ((Get-Date) -lt $deadline) {
  $a = [bool](Get-NetTCPConnection -State Listen -LocalPort 3100 -ErrorAction SilentlyContinue)
  $b = [bool](Get-NetTCPConnection -State Listen -LocalPort 3101 -ErrorAction SilentlyContinue)
  $bridgesUp = @($bridgePorts | Where-Object { Get-NetTCPConnection -State Listen -LocalPort $_ -ErrorAction SilentlyContinue }).Count
  if ($a -and $b -and $bridgesUp -eq $bridgePorts.Count) { break }
  Start-Sleep 2
}

$finA = [bool](Get-NetTCPConnection -State Listen -LocalPort 3100 -ErrorAction SilentlyContinue)
$finB = [bool](Get-NetTCPConnection -State Listen -LocalPort 3101 -ErrorAction SilentlyContinue)
$upBridges = @($bridgePorts | Where-Object { Get-NetTCPConnection -State Listen -LocalPort $_ -ErrorAction SilentlyContinue } | ForEach-Object { "  $_" })

Write-Host ""
Write-Host "=== STATUS ==="
Write-Host ("Paperclip API  : {0}  -> http://127.0.0.1:3100 (UI: {1})" -f $(if ($finA) {"OK"} else {"DOWN"}), $(if ($finA) {"http://127.0.0.1:3100"} else {"-"}))
Write-Host ("MCP gateway    : {0}  -> http://127.0.0.1:3101/mcp" -f $(if ($finB) {"OK"} else {"DOWN"}))
Write-Host ("Mostki MCP     : {0}/{1}{2}" -f $upBridges.Count, $bridgePorts.Count, $(if ($upBridges) { "`n" + ($upBridges -join "`n") } else { "" }))
Write-Host "Publiczny MCP  : https://mcp.kompaszbiorek.pl/mcp (OAuth 2.1, agregat: tylko paperclip; opencode/obsidian lokalnie dla Paperclipa)"
Write-Host "OpenCode root  : $runtimeRoot (per-agent data, Paperclip-only cache, per-run config)"
Write-Host ""
Write-Host "W ChatGPT Connector (MCP) wpisz URL: https://mcp.kompaszbiorek.pl/mcp - jedno polaczenie daje 17 narzedzi operatora Paperclip."
Write-Host "Stary URL      : https://paperclip-mcp.kompaszbiorek.pl/mcp (bez OAuth, tylko paperclip)"
