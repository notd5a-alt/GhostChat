# Build the Python sidecar binary with PyInstaller and rename it
# with the Rust target triple (required by Tauri's externalBin).
# Usage: powershell -ExecutionPolicy Bypass -File scripts/build-sidecar.ps1

$ErrorActionPreference = "Stop"

# Resolve project root (parent of scripts/)
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$ProjectRoot = Split-Path -Parent $ScriptDir

Write-Host "Project root: $ProjectRoot"
Set-Location $ProjectRoot

# Get the Rust target triple
$RustcOutput = rustc -vV
$Triple = ($RustcOutput | Select-String "host:").ToString().Split(" ")[1]
if (-not $Triple) {
    Write-Error "Could not determine Rust target triple. Is rustc installed?"
    exit 1
}

Write-Host "Building sidecar for target: $Triple"

# Ensure output directory exists
$DistPath = Join-Path (Join-Path $ProjectRoot "src-tauri") "binaries"
New-Item -ItemType Directory -Force -Path $DistPath | Out-Null

# Build with PyInstaller
pyinstaller `
    --onefile `
    --name synced-server `
    --add-data "$(Join-Path (Join-Path $ProjectRoot 'backend') 'static');backend\static" `
    --distpath $DistPath `
    --workpath (Join-Path (Join-Path $ProjectRoot "build") "pyinstaller") `
    --specpath (Join-Path $ProjectRoot "build") `
    --exclude-module numpy `
    --exclude-module PIL `
    --exclude-module Pillow `
    --exclude-module tkinter `
    --exclude-module _tkinter `
    --exclude-module matplotlib `
    --exclude-module scipy `
    --exclude-module pandas `
    --exclude-module pytest `
    --exclude-module pygments `
    --exclude-module rich `
    --exclude-module chardet `
    backend\sidecar_entry.py

if ($LASTEXITCODE -ne 0) {
    Write-Error "PyInstaller failed with exit code $LASTEXITCODE"
    exit 1
}

# Rename with target triple suffix
$Exe = Join-Path $DistPath "synced-server.exe"
$Target = Join-Path $DistPath "synced-server-$Triple.exe"

Write-Host "Looking for: $Exe"

if (Test-Path $Exe) {
    Move-Item -Force $Exe $Target
    Write-Host "Sidecar built: $Target"
} else {
    Write-Host "Contents of ${DistPath}:"
    Get-ChildItem $DistPath | ForEach-Object { Write-Host "  $_" }
    Write-Error "PyInstaller output not found at $Exe"
    exit 1
}

Write-Host "Done."
