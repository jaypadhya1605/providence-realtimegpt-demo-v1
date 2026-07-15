[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$SkipSmoke,
    [ValidateRange(1024, 65535)]
    [int]$SmokePort = 8765
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$devRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repoRoot = (Resolve-Path (Join-Path $devRoot "..")).Path
$backendRoot = Join-Path $devRoot "backend"
$frontendRoot = Join-Path $devRoot "frontend"
$frontendDist = Join-Path $frontendRoot "dist"
$artifactsRoot = Join-Path $devRoot "artifacts"
$stageRoot = Join-Path $artifactsRoot "app"
$zipPath = Join-Path $artifactsRoot "empathy-avatar-demo.zip"
$manifestPath = Join-Path $stageRoot "package-manifest.json"

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory)]
        [string]$Command,
        [Parameter(ValueFromRemainingArguments)]
        [string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $Command $($Arguments -join ' ')"
    }
}

function Get-ProjectPython {
    $relativePath = if ($IsWindows) { "Scripts/python.exe" } else { "bin/python" }
    $pythonPath = Join-Path (Join-Path $backendRoot ".venv") $relativePath
    if (-not (Test-Path $pythonPath -PathType Leaf)) {
        throw "Python environment not found. Run dev/scripts/bootstrap.ps1 first."
    }

    return $pythonPath
}

if (-not $SkipBuild) {
    Push-Location $frontendRoot
    try {
        Invoke-CheckedCommand npm run build
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-Path (Join-Path $frontendDist "index.html") -PathType Leaf)) {
    throw "Frontend build output is missing. Run without -SkipBuild or run npm run build first."
}

if (Test-Path $stageRoot) {
    Remove-Item $stageRoot -Recurse -Force
}
if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}

New-Item $stageRoot -ItemType Directory -Force | Out-Null
New-Item (Join-Path $stageRoot "frontend") -ItemType Directory -Force | Out-Null
Copy-Item (Join-Path $backendRoot "app") $stageRoot -Recurse
Copy-Item (Join-Path $backendRoot "requirements.txt") $stageRoot
Copy-Item $frontendDist (Join-Path $stageRoot "frontend") -Recurse
Copy-Item (Join-Path $repoRoot "doc") $stageRoot -Recurse

$startupScript = @'
#!/usr/bin/env bash
set -euo pipefail
python -m uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
'@
$startupPath = Join-Path $stageRoot "startup.sh"
$startupScript = $startupScript.Replace("`r`n", "`n").Replace("`r", "`n")
[IO.File]::WriteAllText($startupPath, $startupScript, [Text.UTF8Encoding]::new($false))
if ([IO.File]::ReadAllBytes($startupPath) -contains [byte]13) {
    throw "Generated startup.sh must use LF line endings."
}

$manifestFiles = Get-ChildItem $stageRoot -File -Recurse | ForEach-Object {
    [ordered]@{
        path = [IO.Path]::GetRelativePath($stageRoot, $_.FullName).Replace("\", "/")
        bytes = $_.Length
        sha256 = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

$manifest = [ordered]@{
    formatVersion = 1
    createdAtUtc = [DateTime]::UtcNow.ToString("o")
    startupCommand = "bash startup.sh"
    files = @($manifestFiles)
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content $manifestPath -Encoding utf8NoBOM

Compress-Archive -Path (Join-Path $stageRoot "*") -DestinationPath $zipPath -CompressionLevel Optimal

if (-not $SkipSmoke) {
    $pythonPath = Get-ProjectPython
    $smokeUrl = "http://127.0.0.1:$SmokePort"
    $stdoutPath = Join-Path $artifactsRoot "smoke.stdout.log"
    $stderrPath = Join-Path $artifactsRoot "smoke.stderr.log"
    $environmentNames = @(
        "APP_ENV",
        "APP_MODE",
        "ALLOWED_ORIGINS",
        "BUILD_LABEL",
        "FRONTEND_DIST_PATH",
        "PYTHONPATH"
    )
    $originalEnvironment = @{}
    foreach ($name in $environmentNames) {
        $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    }

    $process = $null
    try {
        $env:APP_ENV = "local"
        $env:APP_MODE = "mock"
        $env:ALLOWED_ORIGINS = $smokeUrl
        $env:BUILD_LABEL = "package-smoke"
        $env:FRONTEND_DIST_PATH = "frontend/dist"
        $env:PYTHONPATH = $stageRoot

        $processParameters = @{
            FilePath = $pythonPath
            ArgumentList = @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", $SmokePort)
            WorkingDirectory = $artifactsRoot
            RedirectStandardOutput = $stdoutPath
            RedirectStandardError = $stderrPath
            PassThru = $true
        }
        $process = Start-Process @processParameters

        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        $healthy = $false
        while ([DateTime]::UtcNow -lt $deadline) {
            if ($process.HasExited) {
                $stderr = if (Test-Path $stderrPath) { Get-Content $stderrPath -Raw } else { "" }
                throw "Package smoke process exited early with code $($process.ExitCode). $stderr"
            }

            try {
                $health = Invoke-RestMethod "$smokeUrl/healthz" -TimeoutSec 2
                if ($health.status -eq "ok") {
                    $healthy = $true
                    break
                }
            }
            catch {
                [Threading.Thread]::Sleep(250)
            }
        }

        if (-not $healthy) {
            throw "Package did not become healthy within 20 seconds. See $stderrPath."
        }

        $page = Invoke-WebRequest "$smokeUrl/" -TimeoutSec 5
        if ($page.StatusCode -ne 200 -or $page.Content -notmatch "EmpathyAI Avatar") {
            throw "Package health passed, but the compiled application HTML was not served."
        }
    }
    finally {
        if ($null -ne $process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -Force
            $process.WaitForExit()
        }
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
}

$zipHash = (Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "Package: $zipPath"
Write-Host "SHA-256: $zipHash"
if (-not $SkipSmoke) {
    Write-Host "Smoke test: passed"
}