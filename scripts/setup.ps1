param(
    [string]$Agent,
    [switch]$Project,
    [switch]$DryRun,
    [switch]$Yes
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js 20 or later is required."
}

Push-Location $projectRoot
try {
    npm install --omit=dev
    $arguments = @("bin/ai-coding.js", "setup")
    if ($Agent) { $arguments += @("--agent", $Agent) }
    if ($Project) { $arguments += "--project" }
    if ($DryRun) { $arguments += "--dry-run" }
    if ($Yes) { $arguments += "--yes" }
    & node @arguments
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
    Pop-Location
}
