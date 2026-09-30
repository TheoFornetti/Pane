#!/usr/bin/env bash
# Run a list of live gates in order and refresh the matrix. Each gate keeps its own evidence directory.
#   tests/cloud-e2e/run-gates.sh m1-cli m2-resume m2-safestop m3-peers m4-coordinator
#   tests/cloud-e2e/run-gates.sh all
# Pass the build under test through the environment (E2E_DAEMON_DEB_URL, E2E_RUNPANE_TGZ_URL, E2E_GOLDEN, ...);
# default is ~/rc-loop/results/dist-current.md.
# The gates run from a snapshot copy of this directory, so editing the scripts never corrupts a run in progress
# (bash reads scripts incrementally).
SRC="$(cd "$(dirname "$0")" && pwd)"
SNAP="$(mktemp -d "${TMPDIR:-/tmp}/cloud-e2e-snap.XXXXXX")"
cp -a "$SRC/." "$SNAP/"
trap 'rm -rf "$SNAP"' EXIT
gates=("$@"); [ "${gates[0]:-all}" = all ] && gates=(m0-harness m1-cli m1-golden m2-resume m2-safestop m3-peers m4-coordinator)
rc=0
for g in "${gates[@]}"; do
  echo "=== $g ($(date -u +%FT%TZ))"
  E2E_NO_MATRIX=1 "$SNAP/gates/$g.sh" || rc=1
done
python3 "$SNAP/lib/cloudlab.py" matrix
exit $rc
