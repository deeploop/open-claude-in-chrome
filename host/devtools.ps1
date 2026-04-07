# Chrome DevTools Remote Debugging Launcher
# Usage: powershell -ExecutionPolicy Bypass -File host/devtools.ps1 [-Verbose]

param(
    [int]$Port = 9222,
    [string]$ChromePath = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    [string]$ProfileDir = "$HOME\Documents\ChromeRPAProfile",
    [string]$StartUrl = "https://www.coohom.com/pub/tool/bim/cloud"
)

# Create profile directory if needed
if (-not (Test-Path $ProfileDir)) {
    New-Item -Path $ProfileDir -ItemType Directory | Out-Null
    Write-Host "[OK] Created profile dir: $ProfileDir" -ForegroundColor Cyan
}

# Check for existing Chrome processes
$existingChrome = Get-Process chrome -ErrorAction SilentlyContinue
if ($existingChrome) {
    Write-Host "[WARN] Chrome is already running. Debug port may not bind." -ForegroundColor Yellow
    Write-Host "       Close all Chrome windows first, or use a different --Port." -ForegroundColor Yellow
}

# Launch Chrome with remote debugging
$arguments = @(
    "--remote-debugging-port=$Port"
    "--user-data-dir=`"$ProfileDir`""
    "--no-first-run"
    "--no-default-browser-check"
    $StartUrl
)

Write-Host "[START] Launching Chrome (debug port: $Port)..." -ForegroundColor Green
Start-Process -FilePath $ChromePath -ArgumentList $arguments

Write-Host "[READY] Chrome started with remote debugging on port $Port" -ForegroundColor Gray
Write-Host "        You can now use coohom_* tools in Claude Code." -ForegroundColor Gray
Write-Host ""
Write-Host "        Verify: http://localhost:$Port/json" -ForegroundColor DarkGray
