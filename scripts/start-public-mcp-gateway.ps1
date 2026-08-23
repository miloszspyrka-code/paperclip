param(
  [switch]$Replace
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$node = "C:\Program Files\nodejs\node.exe"
$secretsFile = Join-Path $root ".secrets\mcp-public.env.ps1"
$logs = Join-Path $root "logs"
$internalGateway = Join-Path $root "mcp-sse-gateway.mjs"
$publicGateway = Join-Path $root "mcp-public-gateway.mjs"

if (-not (Test-Path -LiteralPath $node)) { throw "Node executable is missing" }
if (-not (Test-Path -LiteralPath $secretsFile)) { throw "Missing public MCP secrets environment file" }
if (-not (Test-Path -LiteralPath $internalGateway)) { throw "Missing internal MCP gateway script" }
if (-not (Test-Path -LiteralPath $publicGateway)) { throw "Missing public MCP gateway script" }

. $secretsFile

$required = @("PAPERCLIP_API_URL", "PAPERCLIP_API_KEY", "PAPERCLIP_COMPANY_ID", "PAPERCLIP_AGENT_ID", "MCP_GATEWAY_TOKEN", "MCP_STDIO_CMD")
foreach ($name in $required) {
  if ([string]::IsNullOrWhiteSpace([string](Get-Item -Path "Env:$name" -ErrorAction SilentlyContinue).Value)) {
    throw "Missing required public MCP environment variable: $name"
  }
}
if ([string]::IsNullOrWhiteSpace($env:MCP_STDIO_ARGS) -and [string]::IsNullOrWhiteSpace($env:MCP_STDIO_ARGS_JSON)) {
  throw "Missing required public MCP stdio arguments"
}
if ($env:PAPERCLIP_AGENT_ID -ne $env:MCP_PUBLIC_EXECUTION_ACTOR_ID) {
  throw "Public MCP execution actor does not match the configured agent"
}

New-Item -ItemType Directory -Path $logs -Force | Out-Null

function Get-Listener($port) {
  Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Start-McpProcess($name, $port, $script, $stdout, $stderr) {
  $listener = Get-Listener $port
  if ($listener) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if ($process.CommandLine -notmatch [regex]::Escape((Split-Path -Leaf $script))) {
      throw "Port $port is owned by an unexpected process"
    }
    if (-not $Replace) { return }
    Stop-Process -Id $listener.OwningProcess -Force
    Start-Sleep -Milliseconds 500
  }
  $env:PORT = [string]$port
  Start-Process -FilePath $node -ArgumentList ('"' + $script + '"') -WorkingDirectory $root `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden | Out-Null
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    if (Get-Listener $port) { return }
    Start-Sleep -Milliseconds 200
  }
  throw "$name did not start on port $port"
}

# The internal bridge executes the Paperclip MCP as COO. The public gateway only
# receives its local authorization token and never receives a generic REST route.
Start-McpProcess "internal Paperclip MCP" 3101 $internalGateway (Join-Path $logs "paperclip-mcp.out.log") (Join-Path $logs "paperclip-mcp.err.log")
$env:MCP_PUBLIC_TARGETS = (@{ paperclip = @{ url = "http://127.0.0.1:3101/mcp"; token = $env:MCP_GATEWAY_TOKEN } } | ConvertTo-Json -Compress)
Start-McpProcess "public Paperclip MCP" 3103 $publicGateway (Join-Path $logs "public-mcp.out.log") (Join-Path $logs "public-mcp.err.log")
Remove-Item Env:MCP_PUBLIC_TARGETS -ErrorAction SilentlyContinue
Remove-Item Env:PORT -ErrorAction SilentlyContinue
