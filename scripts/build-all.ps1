# Full production build for Synced on Windows.
# Builds frontend, Python sidecar, and Tauri installer.
$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $ProjectRoot

Write-Host "=== Synced Windows Build ===" -ForegroundColor Cyan
Write-Host ""

# --- Prerequisite checks ---
Write-Host "Checking prerequisites..." -ForegroundColor Yellow

$checks = @(
    @{ Cmd = "python"; Args = "--version"; Name = "Python" },
    @{ Cmd = "node";   Args = "--version"; Name = "Node.js" },
    @{ Cmd = "npm";    Args = "--version"; Name = "npm" },
    @{ Cmd = "rustc";  Args = "--version"; Name = "Rust" },
    @{ Cmd = "cargo";  Args = "--version"; Name = "Cargo" }
)

foreach ($check in $checks) {
    try {
        $output = & $check.Cmd $check.Args 2>&1
        Write-Host "  [OK] $($check.Name): $output"
    } catch {
        Write-Error "$($check.Name) not found. Please install it first."
        exit 1
    }
}

# Check for Tauri CLI
try {
    $tauriVer = cargo tauri --version 2>&1
    Write-Host "  [OK] Tauri CLI: $tauriVer"
} catch {
    Write-Host "  [!!] Tauri CLI not found. Installing..." -ForegroundColor Yellow
    cargo install tauri-cli
}

Write-Host ""

# --- Step 1: Build frontend ---
Write-Host "Step 1/3: Building frontend..." -ForegroundColor Yellow
Push-Location frontend
npm install
if ($LASTEXITCODE -ne 0) { Write-Error "npm install failed"; exit 1 }
npm run build
if ($LASTEXITCODE -ne 0) { Write-Error "npm run build failed"; exit 1 }
Pop-Location
Write-Host "  Frontend built -> backend/static/" -ForegroundColor Green
Write-Host ""

# --- Step 2: Build Python sidecar ---
Write-Host "Step 2/3: Building Python sidecar..." -ForegroundColor Yellow
& "$ProjectRoot\scripts\build-sidecar.ps1"
if ($LASTEXITCODE -ne 0) { Write-Error "Sidecar build failed"; exit 1 }
Write-Host ""

# --- Step 3: Build Tauri app ---
Write-Host "Step 3/3: Building Tauri app..." -ForegroundColor Yellow
Push-Location src-tauri
cargo tauri build
if ($LASTEXITCODE -ne 0) { Write-Error "Tauri build failed"; exit 1 }
Pop-Location
Write-Host ""

# --- Done ---
$msiFiles = Get-ChildItem -Path "src-tauri/target/release/bundle/msi/*.msi" -ErrorAction SilentlyContinue
if ($msiFiles) {
    Write-Host "=== Build complete! ===" -ForegroundColor Green
    Write-Host "Installer(s):" -ForegroundColor Green
    foreach ($msi in $msiFiles) {
        Write-Host "  $($msi.FullName)" -ForegroundColor Green
    }
} else {
    Write-Host "=== Build complete ===" -ForegroundColor Green
    Write-Host "Check src-tauri/target/release/bundle/ for output files." -ForegroundColor Yellow
}
