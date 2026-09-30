#!/bin/bash
# rp-bootstrap.sh: sandbox-side provisioning steps for a Runpane Cloud session.
# Uploaded and run by `runpane cloud new` (packages/runpane/src/cloud/bootstrap/provision.ts)
# as the sandbox login user, one step per call:  bash rp-bootstrap.sh <step> [args...]
#
# Every step ends with one line `RP_RESULT <json>` that the caller parses.
# No step ever prints a secret: the Tailscale auth key is read from a 0600 file and shredded,
# and the pane-remote:// pairing code only lands in $RP_STATE/pairing.code (0600).
set -euo pipefail
umask 077

RP_STATE="${RP_STATE:-$HOME/.runpane-cloud}"
RP_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$RP_STATE"
chmod 700 "$RP_STATE"
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

result() { printf 'RP_RESULT %s\n' "$1"; }
fail() { result "$(python3 -c 'import json,sys;print(json.dumps({"ok":False,"error":sys.argv[1]}))' "$1")"; exit 1; }

tailscale_backend_state() {
  tailscale status --json 2>/dev/null | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("BackendState") or "")
except Exception: print("")' || true
}

wait_for_tailscaled() {
  local i state
  for i in $(seq 1 60); do
    state="$(tailscale_backend_state)"
    if [ -n "$state" ]; then echo "$state"; return 0; fi
    sleep 0.5
  done
  return 1
}

# Tailnet identity as JSON (no secrets): node id, MagicDNS name, IPs, tags, RunSSH.
tailnet_identity_json() {
  local status prefs
  status="$(tailscale status --json)"
  prefs="$(sudo tailscale debug prefs 2>/dev/null || echo '{}')"
  python3 - "$status" "$prefs" <<'PY'
import json, sys
status = json.loads(sys.argv[1])
try:
    prefs = json.loads(sys.argv[2])
except Exception:
    prefs = {}
me = status.get("Self") or {}
print(json.dumps({
    "ok": True,
    "backendState": status.get("BackendState"),
    "nodeId": me.get("ID"),
    "hostname": me.get("HostName"),
    "magicDnsName": (me.get("DNSName") or "").rstrip("."),
    "tailscaleIps": me.get("TailscaleIPs") or [],
    "tags": me.get("Tags") or [],
    "runSsh": bool(prefs.get("RunSSH", False)),
}))
PY
}

pane_listen_port() {
  python3 - "$HOME/.pane_remote/config.json" <<'PY' 2>/dev/null || echo 42137
import json, sys
d = json.load(open(sys.argv[1]))
config = ((d.get("remoteDaemon") or {}).get("host") or {}).get("config") or {}
print(config.get("listenPort") or 42137)
PY
}

pane_version() {
  local pkg
  pkg="$(dpkg -S /opt/Pane 2>/dev/null | head -1 | cut -d: -f1 || true)"
  if [ -n "$pkg" ]; then dpkg-query -W -f='${Version}' "$pkg" 2>/dev/null || true; fi
}

# identity <sessionId>: explicit first-boot identity reset.
# M0: forks restore onto pre-booted pool machines, so boot-time units never run. A sandbox whose
# marker names another session (a fork of a golden or of a live session) is scrubbed with the same
# script as the golden, gets a fresh machine-id and SSH host keys, and the strip-list check must pass.
# Re-running for the same session is a no-op, so a retried `cloud new` never wipes a working install.
step_identity() {
  local session="$1" marker="$RP_STATE/session-id" previous="" reset=false
  [ -f "$marker" ] && previous="$(cat "$marker")"
  if [ "$previous" != "$session" ]; then
    sudo U="$(id -un)" bash "$RP_SCRIPTS/golden-scrub.sh" >"$RP_STATE/identity.log" 2>&1
    sudo /usr/local/sbin/rp-firstboot-identity >>"$RP_STATE/identity.log" 2>&1
    reset=true
  fi
  printf '%s' "$session" >"$marker"
  result "$(python3 -c 'import json,sys
mid=open("/etc/machine-id").read().strip()
print(json.dumps({"ok":True,"reset":sys.argv[1]=="true","previousSession":sys.argv[2] or None,"machineId":mid}))' "$reset" "$previous")"
}

# tailscale-install: install Tailscale when the image lacks it, start tailscaled.
step_tailscale_install() {
  local installed=false state
  if ! command -v tailscale >/dev/null 2>&1; then
    curl -fsSL https://tailscale.com/install.sh | sudo sh >"$RP_STATE/tailscale-install.log" 2>&1
    installed=true
  fi
  sudo systemctl enable --now tailscaled >/dev/null 2>&1
  state="$(wait_for_tailscaled)" || fail "tailscaled did not start"
  result "$(python3 -c 'import json,sys;print(json.dumps({"ok":True,"installed":sys.argv[1]=="true","backendState":sys.argv[2],"version":sys.argv[3]}))' \
    "$installed" "$state" "$(tailscale version | head -1)")"
}

# check: the golden strip-list check in fork mode (run after identity reset, before joining).
step_check() {
  local out rc=0
  out="$(sudo U="$(id -un)" bash "$RP_SCRIPTS/golden-check.sh" fork 2>&1)" || rc=$?
  printf '%s\n' "$out" >"$RP_STATE/check.log"
  result "$(python3 -c 'import json,sys
lines=sys.argv[2].splitlines()
print(json.dumps({"ok":sys.argv[1]=="0","failed":[l[5:] for l in lines if l.startswith("FAIL ")],"passed":sum(1 for l in lines if l.startswith("PASS "))}))' "$rc" "$out")"
}

# tailscale-up <authKeyFile> <hostname>: join with a single-use tagged key. Never --ssh.
# The key file is shredded whether or not the join works.
step_tailscale_up() {
  local keyfile="$1" hostname="$2" state
  RP_KEYFILE="$keyfile"
  trap 'shred -u "$RP_KEYFILE" 2>/dev/null || rm -f "$RP_KEYFILE"' EXIT
  chmod 600 "$keyfile"
  state="$(tailscale_backend_state)"
  if [ "$state" = Running ]; then fail "tailscale is already joined; use the re-enrol repair path"; fi
  sudo tailscale up --auth-key="file:$keyfile" --hostname="$hostname" --ssh=false >"$RP_STATE/tailscale-up.log" 2>&1 \
    || fail "tailscale up failed: $(tail -3 "$RP_STATE/tailscale-up.log" | tr '\n' ' ')"
  result "$(tailnet_identity_json)"
}

# tailnet-identity: current tailnet identity (read-only).
step_tailnet_identity() {
  result "$(tailnet_identity_json)"
}

# tailscale-reset: repair path, sandbox side. The caller deletes the old device through the API FIRST
# (M0: rejoining without that gives a -1 suffixed name). Wipes node state so the next `up` enrols fresh.
step_tailscale_reset() {
  sudo systemctl stop tailscaled
  sudo rm -f /var/lib/tailscale/tailscaled.state
  sudo systemctl start tailscaled
  local state
  state="$(wait_for_tailscaled)" || fail "tailscaled did not restart"
  result "$(python3 -c 'import json,sys;print(json.dumps({"ok":True,"backendState":sys.argv[1]}))' "$state")"
}

# serve-restore: Tailscale Serve config lives in tailscaled's state, so a re-enrol loses it.
# Re-point :443 (TLS terminated by Tailscale) at the daemon's loopback port.
step_serve_restore() {
  local port
  port="$(pane_listen_port)"
  sudo tailscale serve --bg --tls-terminated-tcp=443 "$port" >"$RP_STATE/serve.log" 2>&1 \
    || fail "tailscale serve failed: $(tail -3 "$RP_STATE/serve.log" | tr '\n' ' ')"
  result "$(python3 -c 'import json,sys;print(json.dumps({"ok":True,"listenPort":int(sys.argv[1])}))' "$port")"
}

# install-pane <mode> <debUrl> <debSha256> <runpaneSpec> <label>
#   mode: deb-url (install the given .deb, e.g. the fork build, then set up with runpane),
#         runpane-npm (runpane downloads the release .deb), preinstalled (the image already has /opt/Pane).
# Setup always runs `runpane install daemon --format deb --prefer-tunnel tailscale`. Its output (which carries
# the pairing code) goes to a 0600 log; the code is moved into pairing.code and redacted from the log.
step_install_pane() {
  local mode="$1" deb_url="$2" deb_sha="$3" spec="$4" label="$5" rc=0 code
  if [ -s "$RP_STATE/pairing.code" ] && systemctl --user is-active -q pane-remote-daemon.service; then
    result "$(python3 -c 'import json,sys;print(json.dumps({"ok":True,"skipped":True,"version":sys.argv[1] or None,"listenPort":int(sys.argv[2])}))' "$(pane_version)" "$(pane_listen_port)")"
    return 0
  fi
  case "$mode" in
    deb-url)
      curl -fsSL --retry 3 -o "$RP_STATE/pane.deb" "$deb_url" || fail "download of the Pane .deb failed"
      if [ -n "$deb_sha" ]; then
        echo "$deb_sha  $RP_STATE/pane.deb" | sha256sum -c --status || fail "Pane .deb sha256 mismatch"
      fi
      chmod 644 "$RP_STATE/pane.deb"
      sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$RP_STATE/pane.deb" >"$RP_STATE/pane-deb.log" 2>&1 \
        || fail "apt-get install of the Pane .deb failed: $(tail -3 "$RP_STATE/pane-deb.log" | tr '\n' ' ')"
      rm -f "$RP_STATE/pane.deb"
      ;;
    preinstalled)
      [ -x /opt/Pane/pane ] || fail "no Pane in the image (/opt/Pane/pane missing)"
      ;;
    runpane-npm) ;;
    *) fail "unknown pane source $mode" ;;
  esac
  sudo loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
  # Pane's setup runs `tailscale serve` as this user; make it the node's operator (no other rights).
  sudo tailscale set --operator="$(id -un)" >/dev/null 2>&1 || fail "tailscale set --operator failed"
  npx --yes --package="$spec" runpane install daemon --format deb --prefer-tunnel tailscale --auto-listen-port \
    --label "$label" >"$RP_STATE/install.log" 2>&1 || rc=$?
  code="$(awk '/^Connection code:/{getline; print; exit}' "$RP_STATE/install.log" | tr -d '\r')"
  sed -i -E 's#pane-remote://[^[:space:]]*#<pairing-redacted>#g' "$RP_STATE/install.log"
  if [ "$rc" -ne 0 ]; then fail "runpane install daemon exited $rc: $(tail -5 "$RP_STATE/install.log" | tr '\n' ' ')"; fi
  case "$code" in
    pane-remote://*) printf '%s' "$code" >"$RP_STATE/pairing.code"; chmod 600 "$RP_STATE/pairing.code" ;;
    *) fail "runpane install daemon printed no pane-remote:// connection code" ;;
  esac
  result "$(python3 -c 'import json,sys;print(json.dumps({"ok":True,"skipped":False,"version":sys.argv[1] or None,"listenPort":int(sys.argv[2])}))' "$(pane_version)" "$(pane_listen_port)")"
}

# add-client <slug> <label>: add another paired client (e.g. the coordinator's) to the running daemon.
# `pane --remote-setup` upserts a new client record each run; the daemon is restarted to load it.
# The code goes to $RP_STATE/client-<slug>.code (0600) and is read back with pairing-read <slug>.
step_add_client() {
  local slug="$1" label="$2" rc=0 code log="$RP_STATE/client-$1.log"
  [ -x /opt/Pane/pane ] || fail "Pane is not installed"
  # Keep the running daemon's port: --auto-listen-port would see it busy and move the daemon.
  /opt/Pane/pane --ozone-platform=headless --disable-gpu --remote-setup --label "$label" --prefer-tunnel tailscale \
    --no-install-service --listen-port "$(pane_listen_port)" >"$log" 2>&1 || rc=$?
  code="$(awk '/^Connection code:/{getline; print; exit}' "$log" | tr -d '\r')"
  sed -i -E 's#pane-remote://[^[:space:]]*#<pairing-redacted>#g' "$log"
  [ "$rc" -eq 0 ] || fail "pane --remote-setup exited $rc: $(tail -5 "$log" | tr '\n' ' ')"
  case "$code" in
    pane-remote://*) printf '%s' "$code" >"$RP_STATE/client-$slug.code"; chmod 600 "$RP_STATE/client-$slug.code" ;;
    *) fail "pane --remote-setup printed no connection code" ;;
  esac
  systemctl --user restart pane-remote-daemon.service
  result '{"ok":true}'
}

# pairing-read [slug]: prints the pairing code inside the result (the caller keeps it in memory and writes it
# to a local 0600 file). The only step whose output carries a secret; the caller never logs it.
step_pairing_read() {
  local file="$RP_STATE/pairing.code"
  [ -n "${1:-}" ] && file="$RP_STATE/client-$1.code"
  [ -s "$file" ] || fail "no pairing code"
  result "$(python3 -c 'import json,sys;print(json.dumps({"ok":True,"code":open(sys.argv[1]).read().strip()}))' "$file")"
}

# health-local: GET /health on the daemon's loopback port (diagnostics; readiness is checked over the tailnet).
step_health_local() {
  local port body
  port="$(pane_listen_port)"
  body="$(curl -fsS --max-time 5 "http://127.0.0.1:$port/health" 2>/dev/null)" || fail "daemon /health on 127.0.0.1:$port failed"
  result "$(python3 -c 'import json,sys;print(json.dumps({"ok":True,"listenPort":int(sys.argv[1]),"health":json.loads(sys.argv[2])}))' "$port" "$body")"
}

# clone <url> <ref> <dir>: public HTTPS clone (no credentials in the sandbox). Idempotent.
step_clone() {
  local url="$1" ref="$2" dir="$3"
  if [ ! -d "$dir/.git" ]; then
    mkdir -p "$(dirname "$dir")"
    GIT_TERMINAL_PROMPT=0 git clone -q "$url" "$dir" 2>"$RP_STATE/clone.log" || fail "git clone failed: $(tail -2 "$RP_STATE/clone.log" | tr '\n' ' ')"
  fi
  if [ -n "$ref" ]; then
    GIT_TERMINAL_PROMPT=0 git -C "$dir" fetch -q origin "$ref" 2>>"$RP_STATE/clone.log" || true
    git -C "$dir" checkout -q "$ref" 2>>"$RP_STATE/clone.log" || git -C "$dir" checkout -q FETCH_HEAD 2>>"$RP_STATE/clone.log" \
      || fail "git checkout $ref failed"
  fi
  result "$(python3 -c 'import json,sys;print(json.dumps({"ok":True,"dir":sys.argv[1],"head":sys.argv[2]}))' "$dir" "$(git -C "$dir" rev-parse HEAD)")"
}

step="${1:-}"; shift || true
case "$step" in
  identity) step_identity "$@" ;;
  tailscale-install) step_tailscale_install ;;
  check) step_check ;;
  tailscale-up) step_tailscale_up "$@" ;;
  tailnet-identity) step_tailnet_identity ;;
  tailscale-reset) step_tailscale_reset ;;
  serve-restore) step_serve_restore ;;
  install-pane) step_install_pane "$@" ;;
  add-client) step_add_client "$@" ;;
  pairing-read) step_pairing_read "$@" ;;
  health-local) step_health_local ;;
  clone) step_clone "$@" ;;
  *) fail "unknown step '$step'" ;;
esac
