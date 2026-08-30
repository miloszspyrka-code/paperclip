$ErrorActionPreference = "Stop"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "scripts\runtime\start-core.ps1")
exit $LASTEXITCODE
