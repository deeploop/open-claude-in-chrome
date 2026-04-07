#Requires -Version 5.1
<#
.SYNOPSIS
    Windows installer for Open Claude in Chrome.
    Registers native messaging host, installs dependencies, and configures Claude Code MCP.

.DESCRIPTION
    This is the Windows equivalent of install.sh.
    It performs all setup steps needed to connect Chrome/Edge/Brave to Claude Code
    via the Open Claude in Chrome extension.

.PARAMETER ExtensionIds
    One or more Chrome extension IDs to authorize. Each Chromium browser assigns
    a different ID when loading unpacked extensions.

.PARAMETER Browsers
    Which browsers to register for. Default: all detected.
    Options: Chrome, Edge, Brave

.PARAMETER SkipMcp
    Skip Claude Code MCP server registration.

.PARAMETER Uninstall
    Remove all native messaging registrations and cleanup.

.EXAMPLE
    # Install for Chrome with extension ID
    powershell -ExecutionPolicy Bypass -File host/install.ps1 -ExtensionIds "abcdefghijklmnopqrstuvwxyz123456"

    # Install for Chrome and Edge with two different extension IDs
    powershell -ExecutionPolicy Bypass -File host/install.ps1 -ExtensionIds "chrome-id-here","edge-id-here"

    # Uninstall everything
    powershell -ExecutionPolicy Bypass -File host/install.ps1 -Uninstall
#>
param(
    [string[]]$ExtensionIds,
    [ValidateSet("Chrome","Edge","Brave")]
    [string[]]$Browsers,
    [switch]$SkipMcp,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

# --- Resolve paths ---
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$HostDir = $ScriptDir
$ExtensionDir = Join-Path $ProjectRoot "extension"

$HostName = "com.anthropic.open_claude_in_chrome"
$NativeHostJs = Join-Path $HostDir "native-host.js"
$McpServerJs = Join-Path $HostDir "mcp-server.js"

# Browser registry paths and manifest directories
$BrowserConfigs = @{
    Chrome = @{
        RegBase = "HKCU:\Software\Google\Chrome\NativeMessagingHosts"
        ManifestDir = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data\NativeMessagingHosts"
    }
    Edge = @{
        RegBase = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts"
        ManifestDir = Join-Path $env:LOCALAPPDATA "Microsoft\Edge\User Data\NativeMessagingHosts"
    }
    Brave = @{
        RegBase = "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts"
        ManifestDir = Join-Path $env:LOCALAPPDATA "BraveSoftware\Brave-Browser\User Data\NativeMessagingHosts"
    }
}

function Write-Step {
    param([string]$Icon, [string]$Message)
    Write-Host "$Icon $Message" -ForegroundColor Cyan
}

function Write-OK {
    param([string]$Message)
    Write-Host "  [OK] $Message" -ForegroundColor Green
}

function Write-Err {
    param([string]$Message)
    Write-Host "  [ERROR] $Message" -ForegroundColor Red
}

function Write-Info {
    param([string]$Message)
    Write-Host "  $Message" -ForegroundColor Gray
}

# ============================================================================
# Uninstall mode
# ============================================================================
if ($Uninstall) {
    Write-Host "`nUninstalling Open Claude in Chrome...`n" -ForegroundColor Yellow

    foreach ($browser in $BrowserConfigs.Keys) {
        $regKey = "$($BrowserConfigs[$browser].RegBase)\$HostName"
        if (Test-Path $regKey) {
            Remove-Item -Path $regKey -Force -ErrorAction SilentlyContinue
            Write-OK "Removed $browser registry key"
        }

        $manifestFile = Join-Path $BrowserConfigs[$browser].ManifestDir "$HostName.json"
        if (Test-Path $manifestFile) {
            Remove-Item -Path $manifestFile -Force -ErrorAction SilentlyContinue
            Write-OK "Removed $browser manifest file"
        }
    }

    # Remove native host wrapper
    $wrapperBat = Join-Path $HostDir "native-host-wrapper.bat"
    if (Test-Path $wrapperBat) {
        Remove-Item $wrapperBat -Force
        Write-OK "Removed native-host-wrapper.bat"
    }

    # Remove stale pidfile
    $pidFile = Join-Path $env:TEMP "open-claude-in-chrome-mcp-18765.pid"
    if (Test-Path $pidFile) {
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
        Write-OK "Removed stale PID file"
    }

    Write-Host "`nUninstall complete." -ForegroundColor Green
    Write-Host "To also remove Claude Code MCP config, run: claude mcp remove open-claude-in-chrome`n"
    exit 0
}

# ============================================================================
# Install mode — validate inputs
# ============================================================================
if (-not $ExtensionIds -or $ExtensionIds.Count -eq 0) {
    Write-Host ""
    Write-Host "Open Claude in Chrome — Windows Installer" -ForegroundColor White
    Write-Host "==========================================" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Usage:" -ForegroundColor Yellow
    Write-Host '  powershell -ExecutionPolicy Bypass -File host/install.ps1 -ExtensionIds "<extension-id>"'
    Write-Host ""
    Write-Host "Steps to get your extension ID:" -ForegroundColor Yellow
    Write-Host "  1. Open chrome://extensions (or edge://extensions, brave://extensions)"
    Write-Host "  2. Enable Developer Mode (toggle in top-right)"
    Write-Host "  3. Click 'Load unpacked' and select the extension/ directory"
    Write-Host "  4. Copy the extension ID shown under the extension name"
    Write-Host "  5. Run this script with that ID"
    Write-Host ""
    Write-Host "Multiple browsers:" -ForegroundColor Yellow
    Write-Host '  powershell -File host/install.ps1 -ExtensionIds "chrome-id","edge-id"'
    Write-Host ""
    exit 1
}

Write-Host ""
Write-Host "Open Claude in Chrome — Windows Installer" -ForegroundColor White
Write-Host "==========================================" -ForegroundColor Gray
Write-Host ""

# ============================================================================
# Step 1: Check Node.js
# ============================================================================
Write-Step "1/6" "Checking Node.js..."

$nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodePath) {
    Write-Err "Node.js not found in PATH. Install from https://nodejs.org"
    exit 1
}
$nodeVersion = & node -v
Write-OK "Node.js $nodeVersion at $nodePath"

# ============================================================================
# Step 2: Install npm dependencies
# ============================================================================
Write-Step "2/6" "Checking npm dependencies..."

$nodeModules = Join-Path $HostDir "node_modules"
$mcpSdk = Join-Path $nodeModules "@modelcontextprotocol" "sdk"
if (-not (Test-Path $mcpSdk)) {
    Write-Info "Installing dependencies..."
    Push-Location $HostDir
    & npm install 2>&1 | Out-Null
    Pop-Location
    if (Test-Path $mcpSdk) {
        Write-OK "Dependencies installed"
    } else {
        Write-Err "npm install failed. Run manually: cd host && npm install"
        exit 1
    }
} else {
    Write-OK "Dependencies already installed"
}

# ============================================================================
# Step 3: Create native host wrapper .bat
# ============================================================================
Write-Step "3/6" "Creating native host wrapper..."

# On Windows, Chrome native messaging needs a .bat or .exe.
# We create a .bat that launches node with native-host.js
$wrapperBat = Join-Path $HostDir "native-host-wrapper.bat"
$nodePathWin = $nodePath -replace '/', '\'
$nativeHostWin = $NativeHostJs -replace '/', '\'

$batContent = @"
@echo off
"$nodePathWin" "$nativeHostWin"
"@

Set-Content -Path $wrapperBat -Value $batContent -Encoding ASCII
Write-OK "Created $wrapperBat"

# ============================================================================
# Step 4: Register native messaging host for each browser
# ============================================================================
Write-Step "4/6" "Registering native messaging host..."

# Build allowed_origins
$origins = $ExtensionIds | ForEach-Object { "chrome-extension://$_/" }

# Manifest content
$manifest = @{
    name = $HostName
    description = "Open Claude in Chrome Native Messaging Host"
    path = $wrapperBat
    type = "stdio"
    allowed_origins = $origins
}
$manifestJson = $manifest | ConvertTo-Json -Depth 5

# Determine which browsers to install for
if (-not $Browsers) {
    $Browsers = @("Chrome", "Edge", "Brave")
}

foreach ($browser in $Browsers) {
    $config = $BrowserConfigs[$browser]
    if (-not $config) { continue }

    # Create manifest directory
    $manifestDir = $config.ManifestDir
    if (-not (Test-Path $manifestDir)) {
        New-Item -Path $manifestDir -ItemType Directory -Force | Out-Null
    }

    # Write manifest file
    $manifestFile = Join-Path $manifestDir "$HostName.json"
    Set-Content -Path $manifestFile -Value $manifestJson -Encoding UTF8
    Write-Info "Manifest: $manifestFile"

    # Create registry key
    $regKey = "$($config.RegBase)\$HostName"
    if (-not (Test-Path $config.RegBase)) {
        # Parent key might not exist (browser not installed), skip
        Write-Info "Skipping $browser (registry base not found — browser may not be installed)"
        continue
    }

    if (-not (Test-Path $regKey)) {
        New-Item -Path $regKey -Force | Out-Null
    }
    Set-ItemProperty -Path $regKey -Name "(default)" -Value $manifestFile -Type String
    Write-OK "$browser: registered at $regKey"
}

# ============================================================================
# Step 5: Verify extension directory
# ============================================================================
Write-Step "5/6" "Checking extension..."

$extensionManifest = Join-Path $ExtensionDir "manifest.json"
if (Test-Path $extensionManifest) {
    $extManifest = Get-Content $extensionManifest -Raw | ConvertFrom-Json
    Write-OK "Extension: $($extManifest.name) v$($extManifest.version)"
} else {
    Write-Err "Extension manifest not found at $extensionManifest"
    Write-Info "Make sure you cloned the full repository."
}

# ============================================================================
# Step 6: Register Claude Code MCP server
# ============================================================================
if (-not $SkipMcp) {
    Write-Step "6/6" "Configuring Claude Code MCP server..."

    $claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
    if ($claudeCmd) {
        try {
            $mcpServerPath = $McpServerJs -replace '\\', '/'
            & claude mcp add open-claude-in-chrome -- node $mcpServerPath 2>&1 | Out-Null
            Write-OK "MCP server registered: claude mcp add open-claude-in-chrome"
        } catch {
            Write-Info "Could not auto-register. Run manually:"
            Write-Info "  claude mcp add open-claude-in-chrome -- node $($McpServerJs -replace '\\','/')"
        }
    } else {
        Write-Info "Claude Code CLI not found. Register MCP manually:"
        Write-Info "  claude mcp add open-claude-in-chrome -- node $($McpServerJs -replace '\\','/')"
    }
} else {
    Write-Step "6/6" "Skipping MCP configuration (--SkipMcp)"
}

# ============================================================================
# Done
# ============================================================================
Write-Host ""
Write-Host "Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Restart your browser (close ALL windows and reopen)"
Write-Host "  2. Make sure the extension is loaded at chrome://extensions"
Write-Host "  3. Start a new Claude Code session and test:"
Write-Host ""
Write-Host '     Ask Claude: "Navigate to reddit.com and take a screenshot"' -ForegroundColor White
Write-Host ""
Write-Host "Troubleshooting:" -ForegroundColor Yellow
Write-Host "  powershell -ExecutionPolicy Bypass -File host/diagnose.ps1 -Verbose"
Write-Host ""
