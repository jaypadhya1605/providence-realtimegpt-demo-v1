[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$SkipPackageSmoke
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$devRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repoRoot = (Resolve-Path (Join-Path $devRoot "..")).Path
$backendRoot = Join-Path $devRoot "backend"
$frontendRoot = Join-Path $devRoot "frontend"
$pythonPath = Join-Path (Join-Path $backendRoot ".venv") $(if ($IsWindows) { "Scripts/python.exe" } else { "bin/python" })

function Assert-LastExitCode {
    param([Parameter(Mandatory)][string]$Step)
    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed with exit code $LASTEXITCODE."
    }
}

if (-not (Test-Path $pythonPath -PathType Leaf)) {
    throw "Python environment not found. Run dev/scripts/bootstrap.ps1 first."
}

Push-Location $frontendRoot
try {
    if (-not $SkipInstall) {
        & npm ci
        Assert-LastExitCode "Frontend dependency installation"
    }
    & npm run lint
    Assert-LastExitCode "Frontend lint"
    & npm test
    Assert-LastExitCode "Frontend tests"
    & npm run build
    Assert-LastExitCode "Frontend production build"
}
finally {
    Pop-Location
}

Push-Location $backendRoot
try {
    & $pythonPath -m ruff format --check app tests
    Assert-LastExitCode "Backend formatting"
    & $pythonPath -m ruff check app tests
    Assert-LastExitCode "Backend lint"
    & $pythonPath -m compileall -q app
    Assert-LastExitCode "Backend compilation"
    & $pythonPath -m pytest
    Assert-LastExitCode "Backend tests"
}
finally {
    Pop-Location
}

$prohibitedNames = @(
    "AZURE_OPENAI_API_KEY",
    "AZURE_SPEECH_KEY",
    "STORAGE_CONNECTION_STRING",
    "AZURE_CLIENT_SECRET"
)
$scanTargets = @(
    (Join-Path $backendRoot "app"),
    (Join-Path $frontendRoot "src"),
    (Join-Path $frontendRoot "public"),
    (Join-Path $devRoot ".env.example")
)
if (Test-Path (Join-Path $repoRoot "infra")) {
    $scanTargets += Join-Path $repoRoot "infra"
}
if (Test-Path (Join-Path $repoRoot "azure.yaml")) {
    $scanTargets += Join-Path $repoRoot "azure.yaml"
}

$filesToScan = foreach ($target in $scanTargets) {
    if (Test-Path $target -PathType Container) {
        Get-ChildItem $target -File -Recurse
    }
    elseif (Test-Path $target -PathType Leaf) {
        Get-Item $target
    }
}
$secretMatches = $filesToScan | Select-String -Pattern $prohibitedNames -SimpleMatch
if ($secretMatches) {
    $locations = $secretMatches | ForEach-Object { "$($_.Path):$($_.LineNumber)" }
    throw "Prohibited long-lived credential setting found: $($locations -join ', ')"
}
Write-Host "Credential-name scan: passed"

$deprecatedBrowserAuthNames = @(
    "@azure/msal-browser",
    "ENTRA_CLIENT_ID",
    "AZURE_API_AUDIENCE",
    "AZURE_API_SCOPE",
    "access_as_user"
)
$browserAuthScanTargets = @(
    (Join-Path $backendRoot "app"),
    (Join-Path $frontendRoot "src"),
    (Join-Path $frontendRoot "dist"),
    (Join-Path $frontendRoot "package.json"),
    (Join-Path $frontendRoot "package-lock.json"),
    (Join-Path $devRoot ".env.example")
)
if (Test-Path (Join-Path $repoRoot "infra")) {
    $browserAuthScanTargets += Join-Path $repoRoot "infra"
}
$browserAuthFiles = foreach ($target in $browserAuthScanTargets) {
    if (Test-Path $target -PathType Container) {
        Get-ChildItem $target -File -Recurse
    }
    elseif (Test-Path $target -PathType Leaf) {
        Get-Item $target
    }
}
$browserAuthMatches = $browserAuthFiles | Select-String -Pattern $deprecatedBrowserAuthNames -SimpleMatch
if ($browserAuthMatches) {
    $locations = $browserAuthMatches | ForEach-Object { "$($_.Path):$($_.LineNumber)" }
    throw "Deprecated browser authentication found in the public POC build: $($locations -join ', ')"
}
Write-Host "Anonymous-browser scan: passed"

$frontendAuthFiles = @(
    (Join-Path $frontendRoot "src"),
    (Join-Path $frontendRoot "dist"),
    (Join-Path $frontendRoot "package.json"),
    (Join-Path $frontendRoot "package-lock.json")
) | ForEach-Object {
    if (Test-Path $_ -PathType Container) {
        Get-ChildItem $_ -File -Recurse
    }
    elseif (Test-Path $_ -PathType Leaf) {
        Get-Item $_
    }
}
$frontendLoginEndpointMatches = $frontendAuthFiles | Select-String -Pattern "login.microsoftonline.com" -SimpleMatch
if ($frontendLoginEndpointMatches) {
    $locations = $frontendLoginEndpointMatches | ForEach-Object { "$($_.Path):$($_.LineNumber)" }
    throw "Microsoft login endpoint found in the anonymous frontend: $($locations -join ', ')"
}
Write-Host "Anonymous-frontend endpoint scan: passed"

$packageParameters = @{
    SkipBuild = $true
    SkipSmoke = [bool]$SkipPackageSmoke
}
& (Join-Path $PSScriptRoot "package.ps1") @packageParameters
Assert-LastExitCode "Release package"

Write-Host "Local release gate: passed"
