# Installs the Pane desktop side-by-side test build and its proof kit from a fork prerelease, next to
# (never over) an installed Pane. Everything lands in one folder, by default %USERPROFILE%\PaneCloudTest:
#   app\        the unpacked test build (app\Pane.exe)
#   kit\        seed-profile.cjs, proof.mjs, run-proof.ps1, remove.ps1, node_modules\playwright-core
#   downloads\  the verified zips
# Nothing else is written: no installer, registry, Start menu or PATH change. The test build keeps its
# data in %USERPROFILE%\.pane_cloudtest once it runs. Undo with kit\remove.ps1.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Tag rc-desktop-<sha8> -AppSha256 <hex> -KitSha256 <hex>
param(
  [Parameter(Mandatory = $true)][string]$Tag,
  [Parameter(Mandatory = $true)][string]$AppSha256,
  [Parameter(Mandatory = $true)][string]$KitSha256,
  [string]$Repo = 'jamari-morrison/Pane',
  [string]$Root = (Join-Path $env:USERPROFILE 'PaneCloudTest')
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = [IO.Path]::GetFullPath($Root)
$installedPane = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\Pane'))
$installedData = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.pane'))
foreach ($protected in @($installedPane, $installedData)) {
  if ($Root.TrimEnd('\').Equals($protected, 'OrdinalIgnoreCase') -or $Root.StartsWith("$protected\", 'OrdinalIgnoreCase') -or $protected.StartsWith("$Root\", 'OrdinalIgnoreCase')) {
    throw "Refusing to install into or around $protected"
  }
}
if ($Repo -like 'greenfield-inc/*') { throw "Refusing: $Repo is upstream; test builds come from the fork" }

$downloads = Join-Path $Root 'downloads'
New-Item -ItemType Directory -Force -Path $downloads | Out-Null
$base = "https://github.com/$Repo/releases/download/$Tag"
$sums = Invoke-WebRequest -UseBasicParsing "$base/SHA256SUMS.txt"
$sumsText = [Text.Encoding]::UTF8.GetString($sums.Content)
function AssetName([string]$pattern) {
  $line = $sumsText -split "`n" | Where-Object { $_ -match $pattern } | Select-Object -First 1
  if (-not $line) { throw "No asset matching $pattern in $Tag" }
  return ($line -split '\s+', 2)[1].Trim().TrimStart('*')
}
function Fetch([string]$name, [string]$expected) {
  $file = Join-Path $downloads $name
  Write-Host "Downloading $name"
  Invoke-WebRequest -UseBasicParsing "$base/$name" -OutFile $file
  $actual = (Get-FileHash -Algorithm SHA256 $file).Hash.ToLower()
  if ($actual -ne $expected.ToLower()) {
    Remove-Item -Force $file
    throw "SHA-256 mismatch for ${name}: got $actual, expected $expected. Nothing was installed."
  }
  Write-Host "  sha256 $actual OK"
  Unblock-File $file
  return $file
}
$appZip = Fetch (AssetName '-Windows-x64\.zip$') $AppSha256
$kitZip = Fetch (AssetName 'relay-kit.*\.zip$') $KitSha256

# A running test build would hold files open; stop only processes started from this folder.
Get-Process -Name Pane -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith("$Root\", 'OrdinalIgnoreCase') } | Stop-Process -Force
Start-Sleep -Seconds 1

foreach ($pair in @(@($appZip, 'app'), @($kitZip, 'kit'))) {
  $target = Join-Path $Root $pair[1]
  $staging = Join-Path $Root "$($pair[1]).staging"
  foreach ($dir in @($target, $staging)) { if (Test-Path $dir) { Remove-Item -Recurse -Force $dir } }
  Expand-Archive -Path $pair[0] -DestinationPath $staging
  $inner = @(Get-ChildItem $staging)
  # Each zip holds one top-level folder; its contents become app\ or kit\.
  if ($inner.Count -eq 1 -and $inner[0].PSIsContainer) { Move-Item $inner[0].FullName $target; Remove-Item -Recurse -Force $staging }
  else { Move-Item $staging $target }
}
$exe = Join-Path $Root 'app\Pane.exe'
if (-not (Test-Path $exe)) { throw "Pane.exe missing after unpacking: $exe" }
$versionFile = Join-Path $downloads 'version.txt'
Start-Process -FilePath $exe -ArgumentList '--version' -Wait -NoNewWindow -RedirectStandardOutput $versionFile
Write-Host "Installed test build $((Get-Content -Raw $versionFile).Trim()) at $exe"
Write-Host "Proof kit at $(Join-Path $Root 'kit')"
Write-Host "Installed Pane untouched: $installedPane"
