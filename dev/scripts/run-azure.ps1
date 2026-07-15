[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 8000,
    [string]$SubscriptionId = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$devRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$backendRoot = Join-Path $devRoot "backend"
$frontendRoot = Join-Path $devRoot "frontend"
$pythonPath = Join-Path (Join-Path $backendRoot ".venv") $(if ($IsWindows) { "Scripts/python.exe" } else { "bin/python" })
$envPath = Join-Path $devRoot ".env.local"

if (-not (Test-Path $pythonPath -PathType Leaf)) {
    throw "Python environment not found. Run dev/scripts/bootstrap.ps1 first."
}
if (-not (Test-Path $envPath -PathType Leaf)) {
    throw "Create dev/.env.local from dev/.env.example and fill the non-secret Azure values."
}
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw "Azure CLI is required for Azure-connected local mode."
}

$accountJson = & az account show --output json 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "Azure CLI is not signed in. Sign in separately, then rerun this script."
}
$account = $accountJson | ConvertFrom-Json
if ($SubscriptionId -and $account.id -ne $SubscriptionId) {
    throw "Azure CLI is using subscription $($account.id), expected $SubscriptionId. Change context explicitly before running."
}

if (-not (Test-Path (Join-Path $frontendRoot "dist/index.html") -PathType Leaf)) {
    Push-Location $frontendRoot
    try {
        & npm run build
        if ($LASTEXITCODE -ne 0) {
            throw "Frontend build failed."
        }
    }
    finally {
        Pop-Location
    }
}

$environmentNames = @("APP_ENV", "APP_MODE", "ALLOWED_ORIGINS", "BUILD_LABEL", "FRONTEND_DIST_PATH")
$originalEnvironment = @{}
foreach ($name in $environmentNames) {
    $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

try {
    $env:APP_ENV = "local"
    $env:APP_MODE = "azure"
    $env:ALLOWED_ORIGINS = "http://localhost:$Port,http://127.0.0.1:$Port"
    $env:BUILD_LABEL = "local-azure"
    $env:FRONTEND_DIST_PATH = Join-Path $frontendRoot "dist"

    $settingsCheck = @'
import json
import sys

sys.path.insert(0, "backend")
from app.settings import Settings

settings = Settings()
required = {
    "AZURE_AI_ENDPOINT": settings.azure_ai_endpoint,
}
missing = [name for name, value in required.items() if not value]
if missing:
    raise SystemExit("Missing required settings: " + ", ".join(missing))
print(json.dumps({"mode": settings.app_mode}))
'@

    Push-Location $devRoot
    try {
        $settingsJson = & $pythonPath -c $settingsCheck
        if ($LASTEXITCODE -ne 0) {
            throw "Azure configuration validation failed."
        }
        $null = $settingsJson | ConvertFrom-Json

        Write-Host "EmpathyAI Avatar Azure mode: http://localhost:$Port"
        Write-Host "Azure context: $($account.name) ($($account.id))"
        Write-Host "No keys or client secrets are loaded by this workflow. Press Ctrl+C to stop."
        & $pythonPath -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port $Port
    }
    finally {
        Pop-Location
    }
}
finally {
    foreach ($name in $environmentNames) {
        $value = $originalEnvironment[$name]
        if ($null -eq $value) {
            Remove-Item "Env:$name" -ErrorAction SilentlyContinue
        }
        else {
            [Environment]::SetEnvironmentVariable($name, $value, "Process")
        }
    }
}
