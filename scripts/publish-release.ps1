# publish-release.ps1
param(
    [Parameter(Mandatory=$true)]
    [string]$Version,

    [switch]$SkipTests,
    [switch]$CreateZip
)

$ErrorActionPreference = "Stop"
$publishDir = "./publish"
$testDir = "./publish-test"
$port = 15162
$projectFile = "WinWhisperServer.csproj"

function Stop-ServerProcess {
    param($Process)

    if ($Process -and -not $Process.HasExited) {
        Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue

        # Wait for process to fully exit (max 5 seconds)
        $waited = 0
        while (-not $Process.HasExited -and $waited -lt 50) {
            Start-Sleep -Milliseconds 100
            $waited++
        }

        if (-not $Process.HasExited) {
            Write-Host "  WARN: Process did not exit cleanly" -ForegroundColor Yellow
        }
    }
}

Write-Host "=== WinWhisperServer Release $Version ===" -ForegroundColor Cyan

# =============================================================================
# STEP 1: Smoke Tests
# =============================================================================
if (-not $SkipTests) {
    Write-Host "`n=== Running Smoke Tests ===" -ForegroundColor Cyan

    # Clean test directory
    if (Test-Path $testDir) {
        Remove-Item -Recurse -Force $testDir
    }

    # Publish to test directory
    Write-Host "Publishing test build..."
    dotnet publish $projectFile -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o $testDir -v quiet

    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAIL: Publish failed" -ForegroundColor Red
        exit 1
    }

    # Copy appsettings (not included in single-file)
    Copy-Item "appsettings.json" $testDir

    # Test normal startup
    Write-Host "`nTest 1: Normal startup..."
    $process = Start-Process -FilePath "$testDir/WinWhisperServer.exe" -ArgumentList "--urls", "http://localhost:$port" -PassThru

    try {
        Start-Sleep -Seconds 3
        $response = Invoke-RestMethod "http://localhost:$port/api/settings" -TimeoutSec 5
        Write-Host "  PASS: Server started and responded" -ForegroundColor Green
    } catch {
        Write-Host "  FAIL: Server did not respond - $_" -ForegroundColor Red
        Stop-ServerProcess $process
        exit 1
    }

    Stop-ServerProcess $process

    # Test service-like startup (from system32)
    Write-Host "`nTest 2: Windows Service simulation..."
    $process = Start-Process -FilePath "$testDir/WinWhisperServer.exe" -ArgumentList "--urls", "http://localhost:$port" -WorkingDirectory "C:\Windows\System32" -PassThru

    try {
        Start-Sleep -Seconds 3
        $response = Invoke-RestMethod "http://localhost:$port/api/settings" -TimeoutSec 5
        Write-Host "  PASS: Server started from system32" -ForegroundColor Green
    } catch {
        Write-Host "  FAIL: Server did not start from system32 - $_" -ForegroundColor Red
        Stop-ServerProcess $process
        exit 1
    }

    Stop-ServerProcess $process

    # Cleanup test directory
    Start-Sleep -Seconds 1  # Extra safety margin
    Remove-Item -Recurse -Force $testDir

    Write-Host "`n=== All Tests Passed ===" -ForegroundColor Green
}

# =============================================================================
# STEP 2: Clean Publish Directory
# =============================================================================
Write-Host "`n=== Preparing Publish Directory ===" -ForegroundColor Cyan

if (Test-Path $publishDir) {
    Write-Host "Cleaning existing publish directory..."
    Remove-Item -Recurse -Force $publishDir
}

# =============================================================================
# STEP 3: Publish
# =============================================================================
Write-Host "`n=== Publishing Release Build ===" -ForegroundColor Cyan

dotnet publish $projectFile -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o $publishDir -v quiet

if ($LASTEXITCODE -ne 0) {
    Write-Host "FAIL: Publish failed" -ForegroundColor Red
    exit 1
}

# Copy additional files
Copy-Item "appsettings.json" $publishDir -Force

# Ensure wwwroot is present (should be automatic, but verify)
if (-not (Test-Path "$publishDir/wwwroot")) {
    Write-Host "WARN: wwwroot missing, copying manually..." -ForegroundColor Yellow
    Copy-Item -Recurse "wwwroot" "$publishDir/wwwroot"
}

# Create whisper placeholder
if (-not (Test-Path "$publishDir/whisper")) {
    New-Item -ItemType Directory -Path "$publishDir/whisper" | Out-Null
    Write-Host "Created empty whisper/ directory"
}

# =============================================================================
# STEP 4: Create ZIP (optional)
# =============================================================================
if ($CreateZip) {
    Write-Host "`n=== Creating Release ZIP ===" -ForegroundColor Cyan

    $zipName = "WinWhisperServer_v${Version}_win-x64.zip"
    $zipPath = "./releases/$zipName"

    # Create releases folder if needed
    if (-not (Test-Path "./releases")) {
        New-Item -ItemType Directory -Path "./releases" | Out-Null
    }

    # Remove old zip if exists
    if (Test-Path $zipPath) {
        Remove-Item $zipPath
    }

    # Create zip excluding whisper contents
    $tempDir = "./temp-release"
    if (Test-Path $tempDir) { Remove-Item -Recurse -Force $tempDir }

    Copy-Item -Recurse $publishDir $tempDir

    # Empty the whisper folder (keep folder, remove contents)
    Get-ChildItem "$tempDir/whisper" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force

    # Remove logs if any
    Remove-Item -Recurse -Force "$tempDir/logs" -ErrorAction SilentlyContinue

    Compress-Archive -Path "$tempDir/*" -DestinationPath $zipPath
    Remove-Item -Recurse -Force $tempDir

    Write-Host "Created: $zipPath" -ForegroundColor Green
}

# =============================================================================
# Done
# =============================================================================
Write-Host "`n=== Release $Version Ready ===" -ForegroundColor Green
Write-Host "Location: $publishDir"

if ($CreateZip) {
    Write-Host "ZIP: $zipPath"
}

Write-Host "`nNext steps:"
Write-Host "  1. Test the published exe manually if needed"
Write-Host "  2. Commit and tag: git tag v$Version && git push --tags"
Write-Host "  3. Create GitHub release"
