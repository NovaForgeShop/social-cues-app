param(
  [switch]$Production
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$CodexRoot = "C:\Users\barto\Documents\Codex"
$CliHome = Join-Path $CodexRoot ".vercel-cli-home"
$NpmCache = Join-Path $CodexRoot ".npm-cache2"

New-Item -ItemType Directory -Force -Path `
  $CliHome, `
  (Join-Path $CliHome "AppData"), `
  (Join-Path $CliHome "LocalAppData"), `
  (Join-Path $CliHome "xdg-data"), `
  $NpmCache | Out-Null

$env:npm_config_cache = $NpmCache
$env:APPDATA = Join-Path $CliHome "AppData"
$env:LOCALAPPDATA = Join-Path $CliHome "LocalAppData"
$env:XDG_DATA_HOME = Join-Path $CliHome "xdg-data"

Set-Location $ProjectRoot

Write-Host "Social Cues Vercel deploy helper"
Write-Host "Project folder: $ProjectRoot"
Write-Host ""
Write-Host "If Vercel prints a device-login URL and code, approve it in Chrome."
Write-Host "After login, this script creates a preview deployment. Run with -Production to deploy production."
Write-Host ""

if ($Production) {
  npx.cmd vercel deploy --prod
} else {
  npx.cmd vercel deploy
}
