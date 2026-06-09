param(
    [int]$Port = 5174,
    [ValidateSet("api", "normal")]
    [string]$Channel = "api"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$localEnv = Join-Path $root "local_environment.ps1"
if (Test-Path -LiteralPath $localEnv) {
    . $localEnv
}

if ($env:OPENCV_DIR) {
    $opencvBin = Join-Path $env:OPENCV_DIR "x64\vc16\bin"
    if (Test-Path -LiteralPath $opencvBin) {
        $env:PATH = "$opencvBin;$env:PATH"
    }
}

$potraceCandidates = @()
$potraceCandidates += $root
if ($env:POTRACE_DIR) {
    $potraceCandidates += $env:POTRACE_DIR
}
$potraceCandidates += Join-Path $env:USERPROFILE "Documents\POTRACE\potrace-1.16.win64"
foreach ($potraceDir in $potraceCandidates) {
    if ($potraceDir -and (Test-Path -LiteralPath (Join-Path $potraceDir "potrace.exe"))) {
        $env:PATH = "$potraceDir;$env:PATH"
        break
    }
}

Write-Host "LLM line-art Fourier viewer"
Write-Host "Root: $root"
Write-Host "Channel: $Channel"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host ""
    Write-Host "Node.js was not found in PATH. Install Node.js or add node.exe to PATH."
    Read-Host "Press Enter to close"
    exit 1
}

Write-Host "Node: $($node.Source)"
Write-Host ""
Write-Host "Starting local viewer server..."
Write-Host "The server will choose $Port, or the next free port if $Port is busy."
Write-Host "Keep this window open while using the viewer."
Write-Host ""

node dft_static_server.mjs $Port --open --channel $Channel

Write-Host ""
Write-Host "Viewer server stopped."
Read-Host "Press Enter to close"
