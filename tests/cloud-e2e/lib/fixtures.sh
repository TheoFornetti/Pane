# shellcheck shell=bash
# In-sandbox Pane fixtures, driven only through the documented runpane CLI (`rcl/rp` shim).

# fixture_shell_pane <sandbox-id> <name> -> prints {"paneId":..,"panelId":..} of a bash tool panel
fixture_shell_pane() {
  local sid="$1" name="$2"
  sbx "$sid" 300 <<SH
set -e
RP=/home/user/rcl/rp
if [ ! -d /home/user/e2e-repo/.git ]; then
  git init -q -b main /home/user/e2e-repo && cd /home/user/e2e-repo && git -c user.email=e2e@rc-loop -c user.name=e2e commit -q --allow-empty -m init
  \$RP repos add --path /home/user/e2e-repo --name e2e-repo --yes --json >/home/user/rcl/repos-add.json
fi
\$RP panes create --repo e2e-repo --name $name --tool-command bash --title $name-shell --source agent --no-focus --wait-ready --yes --json > /home/user/rcl/pane-$name.json || true
python3 - <<'PY'
import json
d=json.load(open('/home/user/rcl/pane-$name.json'))
it=(d.get('items') or [{}])[0]
pane=it.get('sessionId') or it.get('paneId')
panel=it.get('panelId')
print(json.dumps({"paneId":pane,"panelId":panel}))
PY
SH
}

# rp_in <sandbox-id> <runpane args...> : run the in-sandbox runpane CLI, print its stdout+stderr, keep exit code
rp_in() {
  local sid="$1"; shift
  local q; q=$(printf '%q ' "$@")
  sbx "$sid" 300 <<SH
/home/user/rcl/rp $q
SH
}
