# CI only (rc-desktop.yml relay-proof): stands in for the cloud Session on a Windows runner that has no
# tailnet. It pairs and starts a real headless Pane daemon from the test build on loopback, registers two
# git repos (Hello-World, montlakev2) and a "morning" Session with the fork's runpane CLI, and writes the
# daemon's pane-remote:// code to -PairingFile the way the relay does on SOBECK. The code is never printed.
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$PairingFile,
  [Parameter(Mandatory = $true)][string]$RunpaneCli,
  [string]$HostDir = 'C:\rc-fake-host',
  [string]$ReposDir = 'C:\rc-fake-repos',
  [string]$Label = 'Scratch',
  [int]$Port = 42199
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $HostDir, $ReposDir | Out-Null

$setupOut = Join-Path $HostDir 'setup.out.txt'
$setup = Start-Process -FilePath $Exe -Wait -NoNewWindow -PassThru -RedirectStandardOutput $setupOut -RedirectStandardError (Join-Path $HostDir 'setup.err.txt') `
  -ArgumentList "--remote-setup --label $Label --pane-dir `"$HostDir`" --listen-port $Port --prefer-tunnel ssh --no-install-service"
if ($setup.ExitCode -ne 0) { throw "remote setup exited $($setup.ExitCode)" }
if (-not (Select-String -Path $setupOut -Pattern 'pane-remote://' -Quiet)) { throw 'remote setup printed no pane-remote:// code' }
# The ssh-tunnel code points at the host's loopback; the desktop here reaches it directly.
New-Item -ItemType Directory -Force -Path (Split-Path $PairingFile) | Out-Null
$rewrite = @'
const fs = require('node:fs');
const [setupOut, pairingFile, port] = process.argv.slice(2);
const code = fs.readFileSync(setupOut, 'utf8').match(/pane-remote:\/\/[A-Za-z0-9_-]+/)[0];
const payload = JSON.parse(Buffer.from(code.slice('pane-remote://'.length), 'base64url').toString('utf8'));
const direct = { v: 1, label: payload.label, baseUrl: `http://127.0.0.1:${port}`, token: payload.token, transport: 'http+sse' };
fs.writeFileSync(pairingFile, `pane-remote://${Buffer.from(JSON.stringify(direct)).toString('base64url')}`);
'@
$rewriteFile = Join-Path $HostDir 'rewrite-code.cjs'
Set-Content -Path $rewriteFile -Value $rewrite
node $rewriteFile $setupOut $PairingFile $Port
if ($LASTEXITCODE -ne 0) { throw 'could not rewrite the pairing code' }
Remove-Item $setupOut
Write-Host "Wrote the fake host's pairing code to $PairingFile (not shown)"

Start-Process -FilePath $Exe -ArgumentList "--daemon-headless --pane-dir `"$HostDir`"" -RedirectStandardOutput (Join-Path $HostDir 'daemon.out.txt') -RedirectStandardError (Join-Path $HostDir 'daemon.err.txt') | Out-Null
$deadline = (Get-Date).AddSeconds(120)
$healthy = $false
while (-not $healthy -and (Get-Date) -lt $deadline) {
  try { $healthy = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/health" -TimeoutSec 3).StatusCode -eq 200 } catch { Start-Sleep -Seconds 2 }
}
if (-not $healthy) { Get-Content (Join-Path $HostDir 'daemon.err.txt') -Tail 40 -ErrorAction SilentlyContinue; throw 'fake host daemon never answered /health' }
Write-Host "Fake host daemon healthy on 127.0.0.1:$Port"

foreach ($name in 'Hello-World', 'montlakev2') {
  $repo = Join-Path $ReposDir $name
  New-Item -ItemType Directory -Force -Path $repo | Out-Null
  git -C $repo init -q -b main
  Set-Content -Path (Join-Path $repo 'README.md') -Value "# $name"
  git -C $repo add README.md
  git -C $repo -c user.name=ci -c user.email=ci@invalid commit -q -m init
  node $RunpaneCli repos add --path $repo --name $name --yes --json --pane-dir $HostDir
  if ($LASTEXITCODE -ne 0) { throw "runpane repos add $name failed" }
}
'{"name":"morning","agent":"claude"}' | node $RunpaneCli sessions create --from-json - --json --pane-dir $HostDir
if ($LASTEXITCODE -ne 0) { throw 'runpane sessions create failed' }
node $RunpaneCli sessions list --json --pane-dir $HostDir | Select-String -SimpleMatch '"morning"' | Out-Null
