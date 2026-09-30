#!/usr/bin/env bash
# Build the Runpane Cloud golden image from a published fork prerelease and prove it LIVE:
#   create sandbox -> provision (fork .deb, Tailscale not joined, Playwright Chromium in /opt) -> scrub ->
#   check (golden mode) -> named snapshot rp-loop-golden-<sha8> -> fork a gate sandbox from the snapshot ->
#   gate-fork.sh (identity check, daemon /health from the .deb, Chromium) -> destroy the source + gate sandboxes.
# Runs on the operator machine (agentbox).
# Usage: scripts/cloud-dist/make-golden.sh --tag rc-<sha8> [--name <snapshot-name>] [--keep-source] [--keep-gate]
# Env:   BOAT_HDR, RC_BIN, FORK_REPO, DIST_CURRENT (see publish-release.sh); EVIDENCE_DIR (default ~/rc-loop/evidence/m2-dist)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
BOAT_HDR=${BOAT_HDR:-$HOME/rc-loop/secrets/boat.hdr}
RC_BIN=${RC_BIN:-$HOME/rc-loop/bin}
FORK_REPO=${FORK_REPO:-jamari-morrison/Pane}
DIST_CURRENT=${DIST_CURRENT:-$HOME/rc-loop/results/dist-current.md}
EVIDENCE_DIR=${EVIDENCE_DIR:-$HOME/rc-loop/evidence/m2-dist}
BOAT=https://boat.dev/api/v1
TAG= NAME= KEEP_SOURCE=0 KEEP_GATE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG=$2; shift 2;;
    --name) NAME=$2; shift 2;;
    --keep-source) KEEP_SOURCE=1; shift;;
    --keep-gate) KEEP_GATE=1; shift;;
    *) echo "unknown arg $1" >&2; exit 2;;
  esac
done
[ -n "$TAG" ] || { echo "usage: $0 --tag rc-<sha8> [--name n] [--keep-source] [--keep-gate]" >&2; exit 2; }
DL="https://github.com/$FORK_REPO/releases/download/$TAG"
INFO=$(curl -fsSL "$DL/build-info.json")
jf() { python3 -c 'import json,sys;print(json.loads(sys.argv[1])[sys.argv[2]])' "$INFO" "$1"; }
VERSION=$(jf version); COMMIT=$(jf commit); SHA8=${COMMIT:0:8}
NAME=${NAME:-rp-loop-golden-$SHA8}
PW_VERSION=1.54.1
mkdir -p "$EVIDENCE_DIR"
EVID="$EVIDENCE_DIR/golden-$SHA8-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$EVID") 2>&1
T0=$(date +%s)
log() { echo "golden: +$(( $(date +%s) - T0 ))s $*"; }
log "tag=$TAG version=$VERSION name=$NAME evidence=$EVID"

sb_state() { curl -sS -H @"$BOAT_HDR" "$BOAT/sandboxes/$1" | python3 -c 'import json,sys;d=json.load(sys.stdin);print((d.get("sandbox") or d).get("state") or (d.get("sandbox") or d).get("status"))'; }
wait_idle() { for _ in $(seq 1 120); do [ "$(sb_state "$1")" = idle ] && return 0; sleep 2; done; log "sandbox $1 never became idle"; return 1; }
put() { # local file -> remote path (under /home/user)
  python3 -c 'import json,sys,base64;print(json.dumps({"path":sys.argv[2],"content":base64.b64encode(open(sys.argv[1],"rb").read()).decode(),"encoding":"base64"}))' "$2" "$3" |
    curl -sS -f -o /dev/null -X PUT -H @"$BOAT_HDR" -H 'Content-Type: application/json' --data-binary @- "$BOAT/sandboxes/$1/files"
}
run() { # sandbox, command, [timeout] -> prints output, returns exit code
  python3 -c 'import json,sys;print(json.dumps({"command":sys.argv[1],"timeoutSeconds":int(sys.argv[2])}))' "$2" "${3:-600}" |
    curl -sS -X POST -H @"$BOAT_HDR" -H 'Content-Type: application/json' --data-binary @- "$BOAT/sandboxes/$1/commands" |
    python3 -c '
import json,sys
d=json.load(sys.stdin); r=d.get("result",d)
sys.stdout.write(r.get("stdout","")); e=r.get("stderr","")
if e: sys.stdout.write("--stderr--\n"+e)
if "error" in d: print("##error", d["error"])
sys.exit(r.get("exitCode", 1) if isinstance(r.get("exitCode"), int) else 1)'
}
run_retry() { for i in $(seq 1 20); do out=$(run "$@") && { printf '%s\n' "$out"; return 0; }; [ "$i" -ge 3 ] && { printf '%s\n' "$out"; return 1; }; sleep 3; done; }

# 1. source sandbox
SRC=$("$RC_BIN/sb-create.sh" "golden-$SHA8" large)
log "source sandbox $SRC"
wait_idle "$SRC"; log "source idle"
for f in provision.sh scrub.sh check.sh gate-fork.sh; do put "$SRC" "$HERE/golden/$f" "rcl-golden/$f"; done
META=$(python3 -c 'import json,sys;print(json.dumps({"name":sys.argv[1],"paneVersion":sys.argv[2],"commit":sys.argv[3],"release":sys.argv[4],"playwright":sys.argv[5],"playwrightBrowsersPath":"/opt/ms-playwright"}))' "$NAME" "$VERSION" "$COMMIT" "$DL" "$PW_VERSION")

# 2. provision, record pre-scrub identity, scrub, golden check
run_retry "$SRC" "sudo bash /home/user/rcl-golden/provision.sh '$DL/pane_${VERSION}_amd64.deb' /home/user/rcl-golden/check.sh '$META' $PW_VERSION"
log "provisioned"
GMID=$(run "$SRC" "cat /etc/machine-id" | tr -d '\n')
GHK=$(run "$SRC" "cat /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null | sha256sum | cut -c1-16" | tr -d '\n')
log "pre-scrub machine-id=$GMID hostkey_sha=$GHK"
run "$SRC" "rm -rf /home/user/rcl-golden" >/dev/null
put "$SRC" "$HERE/golden/scrub.sh" "rcl-scrub.sh"
run "$SRC" "sudo U=user bash /home/user/rcl-scrub.sh; rm -f /home/user/rcl-scrub.sh" | tail -3
run "$SRC" "sudo U=user EXPECT_PANE_VERSION='$VERSION' /usr/local/sbin/rp-golden-check golden"
log "golden check PASS"

# 3. named snapshot
printf '{"sandboxId":"%s","name":"%s"}' "$SRC" "$NAME" > "$EVIDENCE_DIR/.ns-$SHA8.json"
"$RC_BIN/boat.sh" POST /named-snapshots "$EVIDENCE_DIR/.ns-$SHA8.json" | head -1
rm -f "$EVIDENCE_DIR/.ns-$SHA8.json"
for _ in $(seq 1 90); do
  st=$(curl -sS -H @"$BOAT_HDR" "$BOAT/named-snapshots/$NAME" | python3 -c 'import json,sys;d=json.load(sys.stdin);s=d.get("snapshot") or d;print(s.get("status"), s.get("sizeBytes"))')
  case "$st" in ready*) break;; failed*|error*) log "snapshot $st"; exit 1;; esac
  sleep 3
done
log "named snapshot $NAME: $st"

# 4. gate fork from the named snapshot
[ "$KEEP_SOURCE" = 1 ] || { "$RC_BIN/sb-destroy.sh" "$SRC" | tail -1; log "source destroyed (gate forks from the snapshot alone)"; }
TF=$(date +%s%3N)
GATE=$("$RC_BIN/sb-create.sh" "golden-gate-$SHA8" large "$NAME")
wait_idle "$GATE"; log "gate fork $GATE idle in $(( $(date +%s%3N) - TF ))ms"
put "$GATE" "$HERE/golden/gate-fork.sh" "rcl-gate.sh"
set +e
run_retry "$GATE" "bash /home/user/rcl-gate.sh '$VERSION' '$GMID' '$GHK'"; GATE_RC=$?
set -e
log "gate fork first-exec..gate done in $(( $(date +%s%3N) - TF ))ms total, rc=$GATE_RC"
[ "$KEEP_GATE" = 1 ] || { "$RC_BIN/sb-destroy.sh" "$GATE" | tail -1; }
[ "$GATE_RC" = 0 ] || { log "LIVE GATE FAILED"; exit 1; }

python3 - "$DIST_CURRENT" "$NAME" "$VERSION" "$COMMIT" "$EVID" <<'PY'
import sys, re, os, datetime
path, name, version, commit, evid = sys.argv[1:]
block = f"""<!-- golden:start -->
## Golden image (updated {datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%MZ')})
- Named snapshot: `{name}` (boat; fork with `POST /sandboxes` `{{"from":"{name}"}}` or `sb-create.sh <n> large {name}`)
- Contains: Pane `{version}` (.deb only, unpaired), Tailscale (not joined), Playwright Chromium in `/opt/ms-playwright`
  (`PLAYWRIGHT_BROWSERS_PATH` in /etc/environment), `/usr/local/sbin/rp-golden-check`, `/usr/local/sbin/rp-firstboot-identity`, `/etc/rp-golden.json`
- Commit: `{commit}`
- Per-sandbox bootstrap MUST run `sudo /usr/local/sbin/rp-firstboot-identity` before `tailscale up` / Pane setup (forks aren't rebooted)
- LIVE gate PASS: {evid}
<!-- golden:end -->"""
text = open(path).read() if os.path.exists(path) else "# dist-current\n\n<!-- golden:start -->\n<!-- golden:end -->\n"
text = re.sub(r"<!-- golden:start -->.*?<!-- golden:end -->", lambda _: block, text, flags=re.S)
open(path, "w").write(text)
PY
log "LIVE GATE PASS; updated $DIST_CURRENT"
