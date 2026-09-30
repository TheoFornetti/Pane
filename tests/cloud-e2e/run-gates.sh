#!/usr/bin/env bash
# Run a list of live gates in order and refresh the matrix. Each gate keeps its own evidence directory.
#   tests/cloud-e2e/run-gates.sh m1-cli m2-resume m2-safestop m3-peers m4-coordinator
#   tests/cloud-e2e/run-gates.sh all
# Pass the build under test through the environment (E2E_DAEMON_DEB_URL, E2E_RUNPANE_TGZ_URL); default is
# ~/rc-loop/results/dist-current.md.
HERE="$(cd "$(dirname "$0")" && pwd)"
gates=("$@"); [ "${gates[0]:-all}" = all ] && gates=(m0-harness m1-cli m1-golden m2-resume m2-safestop m3-peers m4-coordinator)
rc=0
for g in "${gates[@]}"; do
  echo "=== $g ($(date -u +%FT%TZ))"
  E2E_NO_MATRIX=1 "$HERE/gates/$g.sh" || rc=1
done
python3 "$HERE/lib/cloudlab.py" matrix
exit $rc
