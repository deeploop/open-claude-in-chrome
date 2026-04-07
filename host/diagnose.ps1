#Requires -Version 5.1
<#
.SYNOPSIS
    Diagnostic script for Open Claude in Chrome project.
    Checks every component in the chain: Node.js, npm deps, native messaging,
    extension, TCP port, MCP config, and plugin system.

.DESCRIPTION
    Outputs structured JSON to stdout for AI Agent consumption.
    Human-readable summary to stderr when -Verbose is used.

.EXAMPLE
    # JSON output (for AI Agent)
    powershell -ExecutionPolicy Bypass -File host/diagnose.ps1

    # Human-readable + JSON
    powershell -ExecutionPolicy Bypass -File host/diagnose.ps1 -Verbose

    # Auto-fix mode (attempt to repair issues)
    powershell -ExecutionPolicy Bypass -File host/diagnose.ps1 -Fix
#>
param(
    [switch]$Fix,
    [switch]$Verbose
)

$ErrorActionPreference = "Continue"

# --- Resolve project paths ---
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$HostDir = $ScriptDir  # host/
$PluginsDir = Join-Path $HostDir "plugins"
$ExtensionDir = Join-Path $ProjectRoot "extension"

$HostName = "com.anthropic.open_claude_in_chrome"
$DefaultPort = 18765

$report = @{
    timestamp = (Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ")
    projectRoot = $ProjectRoot
    results = [System.Collections.ArrayList]::new()
    summary = @{ passed = 0; failed = 0; warned = 0; fixed = 0 }
}

function Add-Check {
    param(
        [string]$Name,
        [ValidateSet("PASS","FAIL","WARN","FIXED")]
        [string]$Status,
        [string]$Message,
        [string]$FixHint = ""
    )
    $entry = @{ name = $Name; status = $Status; message = $Message }
    if ($FixHint) { $entry.fix_hint = $FixHint }
    [void]$report.results.Add($entry)
    switch ($Status) {
        "PASS"  { $report.summary.passed++ }
        "FAIL"  { $report.summary.failed++ }
        "WARN"  { $report.summary.warned++ }
        "FIXED" { $report.summary.fixed++ }
    }
    if ($Verbose) {
        $icon = switch ($Status) { "PASS" { "[OK]" }; "FAIL" { "[FAIL]" }; "WARN" { "[WARN]" }; "FIXED" { "[FIXED]" } }
        Write-Host "$icon $Name - $Message" -ForegroundColor $(switch ($Status) { "PASS" { "Green" }; "FAIL" { "Red" }; "WARN" { "Yellow" }; "FIXED" { "Cyan" } })
    }
}

# ============================================================================
# 1. Node.js
# ============================================================================
if ($Verbose) { Write-Host "`n=== Node.js ===" -ForegroundColor White }

$nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($nodePath) {
    $nodeVersion = & node -v 2>$null
    Add-Check "node_installed" "PASS" "Node.js $nodeVersion at $nodePath"
} else {
    Add-Check "node_installed" "FAIL" "Node.js not found in PATH" "Install Node.js from https://nodejs.org or via nvm-windows"
}

# ============================================================================
# 2. npm dependencies
# ============================================================================
if ($Verbose) { Write-Host "`n=== Dependencies ===" -ForegroundColor White }

$nodeModules = Join-Path $HostDir "node_modules"
if (Test-Path $nodeModules) {
    $mcpSdk = Join-Path (Join-Path $nodeModules "@modelcontextprotocol") "sdk"
    if (Test-Path $mcpSdk) {
        Add-Check "npm_dependencies" "PASS" "node_modules exists with @modelcontextprotocol/sdk"
    } else {
        if ($Fix) {
            if ($Verbose) { Write-Host "  Fixing: running npm install..." -ForegroundColor Cyan }
            Push-Location $HostDir
            & npm install 2>$null
            Pop-Location
            if (Test-Path $mcpSdk) {
                Add-Check "npm_dependencies" "FIXED" "Ran npm install successfully"
            } else {
                Add-Check "npm_dependencies" "FAIL" "@modelcontextprotocol/sdk missing after npm install" "cd host && npm install"
            }
        } else {
            Add-Check "npm_dependencies" "FAIL" "@modelcontextprotocol/sdk not found in node_modules" "cd host && npm install"
        }
    }
} else {
    if ($Fix) {
        if ($Verbose) { Write-Host "  Fixing: running npm install..." -ForegroundColor Cyan }
        Push-Location $HostDir
        & npm install 2>$null
        Pop-Location
        if (Test-Path $nodeModules) {
            Add-Check "npm_dependencies" "FIXED" "Ran npm install successfully"
        } else {
            Add-Check "npm_dependencies" "FAIL" "npm install failed" "cd host && npm install"
        }
    } else {
        Add-Check "npm_dependencies" "FAIL" "node_modules not found" "cd host && npm install"
    }
}

# ============================================================================
# 3. Core files exist
# ============================================================================
if ($Verbose) { Write-Host "`n=== Core Files ===" -ForegroundColor White }

$coreFiles = @(
    @{ path = "host/mcp-server.js"; desc = "MCP Server" },
    @{ path = "host/native-host.js"; desc = "Native Host" },
    @{ path = "extension/manifest.json"; desc = "Extension Manifest" },
    @{ path = "extension/background.js"; desc = "Extension Background" }
)

foreach ($f in $coreFiles) {
    $fullPath = Join-Path $ProjectRoot $f.path
    if (Test-Path $fullPath) {
        Add-Check "file_$($f.path -replace '[/\\.]','_')" "PASS" "$($f.desc) exists"
    } else {
        Add-Check "file_$($f.path -replace '[/\\.]','_')" "FAIL" "$($f.desc) missing: $($f.path)"
    }
}

# ============================================================================
# 4. Native Messaging Host registration (Windows registry)
# ============================================================================
if ($Verbose) { Write-Host "`n=== Native Messaging ===" -ForegroundColor White }

$browsers = @(
    @{ name = "Chrome"; regBase = "HKCU:\Software\Google\Chrome\NativeMessagingHosts" },
    @{ name = "Edge"; regBase = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts" },
    @{ name = "Brave"; regBase = "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts" }
)

$anyBrowserRegistered = $false
foreach ($browser in $browsers) {
    $regKey = "$($browser.regBase)\$HostName"
    if (Test-Path $regKey) {
        $manifestPath = (Get-ItemProperty -Path $regKey -ErrorAction SilentlyContinue)."(default)"
        if ($manifestPath -and (Test-Path $manifestPath)) {
            try {
                $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
                if ($manifest.path -and $manifest.name -eq $HostName) {
                    # Check if the host binary/script exists
                    if (Test-Path $manifest.path) {
                        Add-Check "nmh_$($browser.name.ToLower())" "PASS" "$($browser.name): registered, manifest OK, host exists"
                        $anyBrowserRegistered = $true

                        # Check allowed_origins
                        if ($manifest.allowed_origins -and $manifest.allowed_origins.Count -gt 0) {
                            Add-Check "nmh_$($browser.name.ToLower())_origins" "PASS" "$($browser.name): $($manifest.allowed_origins.Count) allowed origin(s)"
                        } else {
                            Add-Check "nmh_$($browser.name.ToLower())_origins" "WARN" "$($browser.name): no allowed_origins in manifest" "Run install.ps1 with extension ID"
                        }
                    } else {
                        Add-Check "nmh_$($browser.name.ToLower())" "FAIL" "$($browser.name): manifest points to missing host: $($manifest.path)" "Run install.ps1 to regenerate"
                    }
                } else {
                    Add-Check "nmh_$($browser.name.ToLower())" "FAIL" "$($browser.name): manifest has wrong name or missing path" "Run install.ps1 to regenerate"
                }
            } catch {
                Add-Check "nmh_$($browser.name.ToLower())" "FAIL" "$($browser.name): cannot parse manifest at $manifestPath" "Run install.ps1 to regenerate"
            }
        } elseif ($manifestPath) {
            Add-Check "nmh_$($browser.name.ToLower())" "FAIL" "$($browser.name): registry points to missing manifest: $manifestPath" "Run install.ps1 to create manifest"
        } else {
            Add-Check "nmh_$($browser.name.ToLower())" "FAIL" "$($browser.name): registry key exists but no default value" "Run install.ps1"
        }
    } else {
        # Not registered — just info, not necessarily a failure (user might only use one browser)
        Add-Check "nmh_$($browser.name.ToLower())" "WARN" "$($browser.name): not registered (run install.ps1 if you use this browser)"
    }
}

if (-not $anyBrowserRegistered) {
    Add-Check "nmh_any_browser" "FAIL" "No browser has native messaging registered" "Run: powershell -File host/install.ps1 <extension-id>"
}

# ============================================================================
# 5. TCP Port
# ============================================================================
if ($Verbose) { Write-Host "`n=== TCP Port ===" -ForegroundColor White }

# Read port from config
$port = $DefaultPort
$configPath = Join-Path (Join-Path (Join-Path $env:USERPROFILE ".config") "open-claude-in-chrome") "config.json"
if (Test-Path $configPath) {
    try {
        $config = Get-Content $configPath -Raw | ConvertFrom-Json
        if ($config.port) { $port = $config.port }
        Add-Check "config_file" "PASS" "Config found, port=$port"
    } catch {
        Add-Check "config_file" "WARN" "Config file exists but cannot be parsed"
    }
} else {
    Add-Check "config_file" "PASS" "No config file (using default port $port)"
}

$portInUse = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
if ($portInUse) {
    $pid_ = ($portInUse | Select-Object -First 1).OwningProcess
    $proc = Get-Process -Id $pid_ -ErrorAction SilentlyContinue
    $procName = if ($proc) { $proc.ProcessName } else { "unknown" }
    Add-Check "tcp_port" "PASS" "Port $port is in use by $procName (PID $pid_) — MCP server likely running"
} else {
    Add-Check "tcp_port" "WARN" "Port $port is free - MCP server not running (normal if no Claude Code session active)"
}

# Check for stale pidfile
$pidFile = Join-Path $env:TEMP "open-claude-in-chrome-mcp-$port.pid"
if (Test-Path $pidFile) {
    $oldPid = (Get-Content $pidFile -Raw).Trim()
    $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
    if ($proc) {
        Add-Check "pidfile" "PASS" "PID file exists, process $oldPid is alive"
    } else {
        if ($Fix) {
            Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
            Add-Check "pidfile" "FIXED" "Removed stale PID file (process $oldPid is dead)"
        } else {
            Add-Check "pidfile" "WARN" "Stale PID file (process $oldPid is dead)" "Delete $pidFile or run with -Fix"
        }
    }
} else {
    Add-Check "pidfile" "PASS" "No stale PID file"
}

# ============================================================================
# 6. Plugin System
# ============================================================================
if ($Verbose) { Write-Host "`n=== Plugins ===" -ForegroundColor White }

if (Test-Path $PluginsDir) {
    $pluginFiles = Get-ChildItem -Path $PluginsDir -Filter "*.js" | Where-Object { $_.Name -notmatch "^(_|test)" }
    Add-Check "plugins_dir" "PASS" "plugins/ directory exists with $($pluginFiles.Count) plugin(s)"

    foreach ($pf in $pluginFiles) {
        # Quick syntax check: try to parse with node
        $syntaxResult = & node -e "import('file:///$($pf.FullName.Replace('\','/'))').then(() => console.log('OK')).catch(e => { console.log('ERR:' + e.message); process.exit(1) })" 2>&1
        if ($LASTEXITCODE -eq 0) {
            Add-Check "plugin_$($pf.BaseName)" "PASS" "$($pf.Name) loads OK"
        } else {
            Add-Check "plugin_$($pf.BaseName)" "FAIL" "$($pf.Name) load error: $syntaxResult"
        }
    }

    # Check __tests__ directory
    $testsDir = Join-Path $PluginsDir "__tests__"
    if (Test-Path $testsDir) {
        $testFiles = Get-ChildItem -Path $testsDir -Filter "*.test.js"
        Add-Check "plugin_tests" "PASS" "$($testFiles.Count) test spec(s) in __tests__/"
    } else {
        Add-Check "plugin_tests" "WARN" "No __tests__/ directory" "Create host/plugins/__tests__/<name>.test.js for automated testing"
    }
} else {
    Add-Check "plugins_dir" "WARN" "plugins/ directory not found (no plugins loaded)"
}

# ============================================================================
# 7. Claude Code MCP Configuration
# ============================================================================
if ($Verbose) { Write-Host "`n=== Claude Code MCP ===" -ForegroundColor White }

# Check project-level .mcp.json
$projectMcpJson = Join-Path $ProjectRoot ".mcp.json"
if (Test-Path $projectMcpJson) {
    try {
        $mcpConfig = Get-Content $projectMcpJson -Raw | ConvertFrom-Json
        if ($mcpConfig.mcpServers."open-claude-in-chrome") {
            Add-Check "claude_mcp_project" "PASS" "Project .mcp.json has open-claude-in-chrome configured"
        } else {
            Add-Check "claude_mcp_project" "WARN" "Project .mcp.json exists but missing open-claude-in-chrome entry" "Run: claude mcp add open-claude-in-chrome -- node $HostDir/mcp-server.js"
        }
    } catch {
        Add-Check "claude_mcp_project" "WARN" ".mcp.json exists but cannot be parsed"
    }
} else {
    Add-Check "claude_mcp_project" "WARN" "No project .mcp.json" "Run: claude mcp add open-claude-in-chrome -- node $($HostDir -replace '\\','/')/mcp-server.js"
}

# ============================================================================
# 8. Test Runner
# ============================================================================
if ($Verbose) { Write-Host "`n=== Test Runner ===" -ForegroundColor White }

$testRunnerPath = Join-Path $HostDir "test-runner.js"
if (Test-Path $testRunnerPath) {
    Add-Check "test_runner" "PASS" "test-runner.js exists"

    # Run tests if node is available
    if ($nodePath) {
        try {
            $testOutput = & node $testRunnerPath 2>$null
            if ($LASTEXITCODE -eq 0) {
                $testJson = $testOutput | ConvertFrom-Json
                $summary = $testJson.summary
                if (-not $summary -and $testJson.plugins) {
                    # Multi-plugin format
                    $total = ($testJson.plugins | ForEach-Object { $_.summary.total } | Measure-Object -Sum).Sum
                    $passed = ($testJson.plugins | ForEach-Object { $_.summary.passed } | Measure-Object -Sum).Sum
                    Add-Check "test_results" "PASS" "All tests pass ($passed/$total)"
                } elseif ($summary) {
                    Add-Check "test_results" "PASS" "All tests pass ($($summary.passed)/$($summary.total))"
                }
            } else {
                try {
                    $testJson = $testOutput | ConvertFrom-Json
                    $s = $testJson.summary
                    Add-Check "test_results" "FAIL" "$($s.failed) test(s) failed out of $($s.total)" "Run: node host/test-runner.js --verbose"
                } catch {
                    Add-Check "test_results" "FAIL" "Test runner exited with code $LASTEXITCODE" "Run: node host/test-runner.js --verbose"
                }
            }
        } catch {
            Add-Check "test_results" "WARN" "Could not run tests: $_"
        }
    }
} else {
    Add-Check "test_runner" "WARN" "test-runner.js not found"
}

# ============================================================================
# Output
# ============================================================================

if ($Verbose) {
    Write-Host "`n=== Summary ===" -ForegroundColor White
    Write-Host "  Passed: $($report.summary.passed)" -ForegroundColor Green
    Write-Host "  Failed: $($report.summary.failed)" -ForegroundColor $(if ($report.summary.failed -gt 0) { "Red" } else { "Green" })
    Write-Host "  Warned: $($report.summary.warned)" -ForegroundColor $(if ($report.summary.warned -gt 0) { "Yellow" } else { "Green" })
    if ($report.summary.fixed -gt 0) {
        Write-Host "  Fixed:  $($report.summary.fixed)" -ForegroundColor Cyan
    }
    Write-Host ""
}

# JSON to stdout
$report | ConvertTo-Json -Depth 10

# Exit code
if ($report.summary.failed -gt 0) { exit 1 } else { exit 0 }
