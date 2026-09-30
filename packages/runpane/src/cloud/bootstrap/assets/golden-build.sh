#!/bin/bash
# golden-build.sh — build a Runpane Cloud golden image in a fresh sandbox. Run as the login user (uses sudo).
# Afterwards take the provider snapshot (boat: POST /named-snapshots). Source of truth:
# packages/runpane/src/cloud/bootstrap/assets. Usage:
#   PANE_DEB_URL=<url> [PANE_DEB_SHA256=<hex>] bash golden-build.sh
# Recipe (M0 m0d-golden findings):
#   - Tailscale installed, NOT joined (the scrub deletes tailscaled.state; forks start NeedsLogin).
#   - Pane .deb only: every `runpane install daemon` writes a paired client, so setup happens per sandbox.
#   - Playwright Chromium installed straight into /opt/ms-playwright (~/.cache, /tmp are not snapshotted,
#     and a directory mv'd into a kept path arrives empty on forks: never mv into kept paths).
#   - golden-scrub.sh, then golden-check.sh golden must pass.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
: "${PANE_DEB_URL:?set PANE_DEB_URL to the Pane .deb to bake in}"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
t0=$(date +%s)

echo "golden: tailscale"
command -v tailscale >/dev/null 2>&1 || curl -fsSL https://tailscale.com/install.sh | sudo sh >/dev/null
sudo systemctl enable tailscaled >/dev/null 2>&1

echo "golden: pane .deb"
curl -fsSL --retry 3 -o "$work/pane.deb" "$PANE_DEB_URL"
if [ -n "${PANE_DEB_SHA256:-}" ]; then echo "$PANE_DEB_SHA256  $work/pane.deb" | sha256sum -c --status; fi
chmod 644 "$work/pane.deb"
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$work/pane.deb" >/dev/null

echo "golden: playwright chromium -> /opt/ms-playwright"
sudo install -d -m 755 -o "$(id -u)" -g "$(id -g)" /opt/ms-playwright
if ! grep -q '^PLAYWRIGHT_BROWSERS_PATH=' /etc/environment; then
  echo 'PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright' | sudo tee -a /etc/environment >/dev/null
fi
(cd "$work" && PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright npx --yes playwright@latest install --with-deps chromium >/dev/null)

echo "golden: runpane cloud state dir"
rm -rf "$HOME/.runpane-cloud"

echo "golden: scrub + check"
sudo U="$(id -un)" bash "$HERE/golden-scrub.sh"
sudo U="$(id -un)" bash "$HERE/golden-check.sh" golden
echo "golden: done in $(( $(date +%s) - t0 )) s; pane $(dpkg-query -W -f='${Version}' pane 2>/dev/null || echo '?')"
