[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$devRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$backendRoot = Join-Path $devRoot "backend"
$frontendRoot = Join-Path $devRoot "frontend"
$venvRoot = Join-Path $backendRoot ".venv"
$venvPython = Join-Path $venvRoot $(if ($IsWindows) { "Scripts/python.exe" } else { "bin/python" })

foreach ($command in @("node", "npm")) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "$command is required but was not found on PATH."
    }
}

$nodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
if ($LASTEXITCODE -ne 0 -or $nodeMajor -lt 24) {
    throw "Node.js 24 or later is required."
}

if (-not (Test-Path $venvPython -PathType Leaf)) {
    if (Get-Command uv -ErrorAction SilentlyContinue) {
        & uv venv --python 3.12 $venvRoot
    }
    elseif ($IsWindows -and (Get-Command py -ErrorAction SilentlyContinue)) {
        & py -3.12 -m venv $venvRoot
    }
    elseif (Get-Command python3.12 -ErrorAction SilentlyContinue) {
        & python3.12 -m venv $venvRoot
    }
    else {
        throw "Python 3.12 is required. Install it or make python3.12/py -3.12 available."
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Could not create the Python 3.12 environment."
    }
}

$pythonVersion = & $venvPython -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
if ($LASTEXITCODE -ne 0 -or $pythonVersion.Trim() -ne "3.12") {
    throw "The existing backend environment is not Python 3.12. Recreate dev/backend/.venv with Python 3.12."
}

$requirementsPath = Join-Path $backendRoot "requirements.txt"
if (Get-Command uv -ErrorAction SilentlyContinue) {
    & uv pip install --python $venvPython -r $requirementsPath
}
else {
    & $venvPython -m pip install --disable-pip-version-check -r $requirementsPath
}
if ($LASTEXITCODE -ne 0) {
    throw "Backend dependency installation failed."
}

Push-Location $frontendRoot
try {
    & npm ci
    if ($LASTEXITCODE -ne 0) {
        throw "Frontend dependency installation failed."
    }
}
finally {
    Pop-Location
}

Write-Host "Bootstrap complete: Node $(node --version), Python $pythonVersion"
