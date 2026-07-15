[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 8000
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$devRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$backendRoot = Join-Path $devRoot "backend"
$frontendRoot = Join-Path $devRoot "frontend"
$pythonPath = Join-Path (Join-Path $backendRoot ".venv") $(if ($IsWindows) { "Scripts/python.exe" } else { "bin/python" })

if (-not (Test-Path $pythonPath -PathType Leaf)) {
    throw "Python environment not found. Run dev/scripts/bootstrap.ps1 first."
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
    $env:APP_MODE = "mock"
    $env:ALLOWED_ORIGINS = "http://localhost:$Port,http://127.0.0.1:$Port"
    $env:BUILD_LABEL = "local-mock"
    $env:FRONTEND_DIST_PATH = Join-Path $frontendRoot "dist"

    Write-Host "EmpathyAI Avatar mock mode: http://localhost:$Port"
    Write-Host "Press Ctrl+C to stop."
    Push-Location $devRoot
    try {
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
