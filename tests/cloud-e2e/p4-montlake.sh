#!/usr/bin/env bash
# P4 (phase3-design §9): the broker against REAL GitHub (jamari-morrison/montlakev2), one command.
#
#   tests/cloud-e2e/p4-montlake.sh <credential-file> <host> [options]
#
# <credential-file>  a GitHub App private key (.pem; pass --app-id / --app-id-file) or a fine-grained PAT file
#                    (github_pat_…; classic ghp_/gho_/… tokens are refused). Red-created, BYOK.
# <host>             the cloud Session (e.g. rp-red-zd56pin5) whose coordinator gets the credential.
#
# What it does (evidence in ~/rc-loop/evidence/p3-e2e/p4-<utc>/):
#   0. preflight (read-only, agentbox gh): master is at --expect-master (78086cb3…); no leftover cloud/<host>/p3-proof
#   1. `cloud coordinator github set` on the user's coordinator (in place; --redeploy first runs `coordinator deploy --yes`)
#   2. `cloud github connect <host> --repo <repo> --broker`
#   3. IN THE SESSION (boat exec, not the tailnet): branch p3-proof from origin/master (+1 file), push through the broker,
#      `gh issue create` + `gh pr create --draft`, titles "[runpane-cloud test] …"; then the refusals: master-escape
#      branch names, a workflow-file change, gh pr merge / ready, ready-for-review via PATCH. (--mode agent: a Claude
#      panel in the Session is given the same task instead of the scripted steps; refusals stay scripted.)
#   4. verify on GitHub (read-only): draft PR from cloud/<host>/p3-proof, author, issue, master unchanged, no other
#      cloud/<host>/ refs
#   5. cleanup, ALWAYS (trap): close PR + issue through the broker from the Session; anything still open is closed with
#      the user's credential from here; the branch is deleted with the user's credential (the broker never deletes refs);
#      then re-verify: PR closed, issue closed, branch 404, master still the expected sha. Exit 0 only if all hold.
#
# Options: --app-id N | --app-id-file F   --installation-id N   --repo owner/name (jamari-morrison/montlakev2)
#          --expect-master SHA (78086cb3)  --rpc CMD (~/.local/bin/rpc)  --path DIR (the clone in the Session; auto)
#          --mode script|agent (script)    --redeploy   --skip-set (credential already on the coordinator)
#          --keep-open (skip closing; branch still deleted unless --keep-branch)   --dry-run (preflight only)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; LIB="$HERE/lib"
. "$LIB/broker.sh"
cl() { python3 "$LIB/cloudlab.py" "$@"; }

[ $# -ge 2 ] || { sed -n 2,30p "$0"; exit 2; }
CRED="$1"; HOST="$2"; shift 2
REPO=jamari-morrison/montlakev2; EXPECT=78086cb3; RPC="$HOME/.local/bin/rpc"; APP_ID=""; INST=""; SPATH=""
MODE=script; REDEPLOY=0; SKIP_SET=0; KEEP_OPEN=0; KEEP_BRANCH=0; DRY=0; BR=p3-proof
while [ $# -gt 0 ]; do case "$1" in
  --app-id) APP_ID="$2"; shift 2;; --app-id-file) APP_ID=$(tr -d ' \r\n' < "$2"); shift 2;;
  --installation-id) INST="$2"; shift 2;; --repo) REPO="$2"; shift 2;; --expect-master) EXPECT="$2"; shift 2;;
  --rpc) RPC="$2"; shift 2;; --path) SPATH="$2"; shift 2;; --mode) MODE="$2"; shift 2;; --branch) BR="$2"; shift 2;;
  --redeploy) REDEPLOY=1; shift;; --skip-set) SKIP_SET=1; shift;; --keep-open) KEEP_OPEN=1; shift;;
  --keep-branch) KEEP_BRANCH=1; shift;; --dry-run) DRY=1; shift;;
  *) echo "unknown option $1" >&2; exit 2;; esac; done

EV="${P4_EVIDENCE_DIR:-$HOME/rc-loop/evidence/p3-e2e/p4-$(date -u +%Y%m%dT%H%M%SZ)}"; mkdir -p "$EV"
SEC="$EV/.secrets"; (umask 077; mkdir -p "$SEC")
exec > >(tee -a "$EV/p4.log") 2>&1
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
RESULTS="$EV/results.txt"; : > "$RESULTS"; FAILS=0
rec() { printf '%-6s %-34s %s\n' "$2" "$1" "$3" | tee -a "$RESULTS"; [ "$2" = FAIL ] && FAILS=$((FAILS+1)); true; }
E2E_RUN_DIR="$EV"; E2E_SECRETS="$SEC"; E2E_LIB="$LIB"; export E2E_LIB
sbx() { { echo 'export XDG_RUNTIME_DIR=/run/user/$(id -u) PATH="$HOME/.local/bin:$HOME/.pane_remote/bin:$PATH"'; cat; } | cl boat exec "$1" - --timeout "${2:-600}"; }
rpc() { env -u PANE_SESSION_ID -u PANE_PANEL_ID -u PANE_ORCHESTRATION_SESSION_ID $RPC "$@"; }
ghro() { gh api "$@"; }   # agentbox gh: READ-ONLY calls only (GUARDS PHASE 3)
PFX="cloud/$HOST/"; FULL="$PFX$BR"; OWNER="${REPO%%/*}"; NAME="${REPO##*/}"

# ---------------------------------------------------------------- credential kind (never printed)
if grep -q "BEGIN .*PRIVATE KEY" "$CRED" 2>/dev/null; then
  KIND=app; [ -n "$APP_ID" ] || { [ -f "$(dirname "$CRED")/github-app-id" ] && APP_ID=$(tr -d ' \r\n' < "$(dirname "$CRED")/github-app-id"); }
  [ -n "$APP_ID" ] || { echo "App key given: pass --app-id or --app-id-file" >&2; exit 2; }
else
  KIND=pat
  case "$(head -c 11 "$CRED")" in github_pat_) ;; *) echo "refusing: not a fine-grained PAT (github_pat_…) nor an App .pem" >&2; exit 2;; esac
fi
[ "$(stat -c %a "$CRED")" = 600 ] || { echo "refusing: $CRED must be mode 0600" >&2; exit 2; }
log "P4 repo=$REPO host=$HOST credential=$KIND mode=$MODE evidence=$EV"

# user-credential REST (cleanup only): installation token (App) or the PAT, in a 0600 header file
user_auth_header() {
  local hf="$SEC/gh-auth.hdr"
  if [ "$KIND" = app ]; then
    local jwt inst tok
    jwt=$(app_jwt "$CRED" "$APP_ID")
    inst=${INST:-$(curl -sS -H "Authorization: Bearer $jwt" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/installation" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id",""))')}
    tok=$(curl -sS -X POST -H "Authorization: Bearer $jwt" -H 'Accept: application/vnd.github+json' \
      -d "{\"repositories\":[\"$NAME\"],\"permissions\":{\"contents\":\"write\",\"pull_requests\":\"write\",\"issues\":\"write\"}}" \
      "https://api.github.com/app/installations/$inst/access_tokens" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("token",""))')
    [ -n "$tok" ] || return 1
    (umask 077; printf 'Authorization: token %s\n' "$tok" > "$hf")
  else
    (umask 077; printf 'Authorization: token %s\n' "$(tr -d '\r\n' < "$CRED")" > "$hf")
  fi
  echo "$hf"
}
ghw() {  # ghw <METHOD> <path> [json] : a write with the USER's credential (cleanup); prints the HTTP status
  local hf; hf=$(user_auth_header) || { echo 000; return 1; }
  curl -sS -o "$EV/.ghw.json" -w '%{http_code}' -X "$1" -H @"$hf" -H 'Accept: application/vnd.github+json' ${3:+-d "$3"} "https://api.github.com/repos/$REPO$2"
  shred -u "$hf"
  echo " $(date -u +%FT%TZ) GITHUB $1 $REPO$2 (p3-e2e P4 cleanup)" >> "$HOME/rc-loop/mutations.log"
}

# ---------------------------------------------------------------- 0. preflight
M0=$(ghro "repos/$REPO/git/ref/heads/master" --jq .object.sha)
[[ "$M0" == "$EXPECT"* ]] && rec preflight.master PASS "master $M0" || { rec preflight.master FAIL "master is $M0, expected $EXPECT"; exit 1; }
if ghro "repos/$REPO/git/ref/heads/$FULL" >/dev/null 2>&1; then rec preflight.no-leftover FAIL "$FULL already exists"; exit 1; fi
rec preflight.no-leftover PASS "no $FULL on GitHub"
REC_FILE="${RUNPANE_CLOUD_DIR:-$HOME/.config/runpane-cloud}/hosts/$HOST.json"
S_ID=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["profile"]["cloud"]["sandboxId"])' "$REC_FILE") || { echo "no host record $REC_FILE" >&2; exit 1; }
export CLOUDLAB_BOAT_ORG=$(python3 -c 'import json,sys;print(((json.load(open(sys.argv[1])).get("meta") or {}).get("boatOrg") or {}).get("id") or "")' "$REC_FILE")
[ -n "$CLOUDLAB_BOAT_ORG" ] || unset CLOUDLAB_BOAT_ORG
st=$(cl boat get "$S_ID" --field state); rec preflight.session "$([[ "$st" =~ ^(idle|ready|running)$ ]] && echo PASS || echo FAIL)" "$HOST $S_ID state=$st (P4 never wakes it: wake it first if asleep)"
[[ "$st" =~ ^(idle|ready|running)$ ]] || exit 1
[ "$DRY" = 1 ] && { log "dry run: preflight only"; exit $((FAILS > 0)); }

CLEANED=0
cleanup() {
  [ "$CLEANED" = 1 ] && return; CLEANED=1
  log "== cleanup"
  local prn issn
  prn=$(cat "$EV/.pr" 2>/dev/null); issn=$(cat "$EV/.issue" 2>/dev/null)
  [ -z "$prn" ] && prn=$(ghro "repos/$REPO/pulls?state=open&head=$OWNER:$FULL" --jq '.[0].number // empty' 2>/dev/null)
  if [ "$KEEP_OPEN" != 1 ]; then
    sbx "$S_ID" 120 <<SH > "$EV/cleanup-session.txt" 2>&1
${prn:+gh pr close $prn --comment "closed by the P4 proof (runpane cloud broker)"; echo "gh pr close exit=\$?"}
${issn:+gh issue close $issn --comment "closed by the P4 proof (runpane cloud broker)"; echo "gh issue close exit=\$?"}
SH
    for n in $prn $issn; do
      s=$(ghro "repos/$REPO/issues/$n" --jq .state 2>/dev/null)
      [ "$s" = closed ] || { log "issue/PR #$n still $s after the broker close: closing with the user credential"; ghw PATCH "/issues/$n" '{"state":"closed"}' >/dev/null; }
    done
  fi
  if [ "$KEEP_BRANCH" != 1 ] && ghro "repos/$REPO/git/ref/heads/$FULL" >/dev/null 2>&1; then
    c=$(ghw DELETE "/git/refs/heads/$FULL"); log "delete $FULL -> $c"
  fi
  # refusal probes must not have left anything under our prefix
  for r in $(ghro "repos/$REPO/git/matching-refs/heads/$PFX" --jq '.[].ref' 2>/dev/null); do
    log "unexpected leftover $r: deleting"; ghw DELETE "/git/${r#refs/}" >/dev/null
  done
  sbx "$S_ID" 60 <<SH >/dev/null 2>&1
cd "${SPATH:-/nonexistent}" 2>/dev/null && git worktree remove --force /home/user/rcl/p4-proof 2>/dev/null; git branch -D $BR wf-p4 2>/dev/null; rm -f /home/user/rcl/p4-*.b64
SH
  # final verification
  local m1 b; m1=$(ghro "repos/$REPO/git/ref/heads/master" --jq .object.sha)
  [ "$m1" = "$M0" ] && rec final.master PASS "master still $m1" || rec final.master FAIL "master is $m1 (was $M0)"
  ghro "repos/$REPO/git/ref/heads/$FULL" >/dev/null 2>&1 && b=present || b=deleted
  [ "$b" = deleted ] || [ "$KEEP_BRANCH" = 1 ] && rec final.branch PASS "$FULL $b" || rec final.branch FAIL "$FULL still present"
  left=$(ghro "repos/$REPO/git/matching-refs/heads/$PFX" --jq 'length' 2>/dev/null)
  [ "${left:-0}" = 0 ] || [ "$KEEP_BRANCH" = 1 ] && rec final.no-refs-under-prefix PASS "0 refs under $PFX" || rec final.no-refs-under-prefix FAIL "$left refs under $PFX"
  if [ "$KEEP_OPEN" != 1 ]; then for n in $prn $issn; do
    s=$(ghro "repos/$REPO/issues/$n" --jq .state); [ "$s" = closed ] && rec "final.closed-#$n" PASS closed || rec "final.closed-#$n" FAIL "$s"; done; fi
  shred -u "$SEC"/* 2>/dev/null; rm -rf "$SEC"
  grep -rlE 'ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|BEGIN (RSA )?PRIVATE' "$EV" 2>/dev/null | while read -r f; do rec evidence.no-secret FAIL "secret-looking text in $f"; done
  log "P4: $FAILS failure(s); results $RESULTS"
}
trap 'cleanup; exit $((FAILS > 0))' EXIT
trap 'exit 143' TERM INT

# ---------------------------------------------------------------- 1-2. broker credential + allowlist
if [ "$REDEPLOY" = 1 ]; then rpc cloud coordinator deploy --yes --json > "$EV/coordinator-deploy.json" 2>&1 && rec coordinator.redeploy PASS "in place" || rec coordinator.redeploy FAIL "see coordinator-deploy.json"; fi
if [ "$SKIP_SET" != 1 ]; then
  if [ "$KIND" = app ]; then out=$(rpc cloud coordinator github set --app-id "$APP_ID" --private-key-file "$CRED" ${INST:+--installation-id "$INST"} --json 2>&1)
  else out=$(rpc cloud coordinator github set --pat-file "$CRED" --json 2>&1); fi
  rc=$?; printf '%s\n' "$out" > "$EV/github-set.json"; rec broker.set "$([ $rc = 0 ] && echo PASS || echo FAIL)" "coordinator github set ($KIND) rc=$rc"
  [ $rc = 0 ] || exit 1
fi
rpc cloud coordinator github status --json > "$EV/github-status.json" 2>&1
out=$(rpc cloud github connect "$HOST" --repo "$REPO" --broker --json 2>&1); rc=$?; printf '%s\n' "$out" > "$EV/connect.json"
rec broker.connect "$([ $rc = 0 ] && echo PASS || echo FAIL)" "github connect $HOST --repo $REPO --broker rc=$rc"; [ $rc = 0 ] || exit 1

# ---------------------------------------------------------------- 3. in the Session
[ -n "$SPATH" ] || SPATH=$(sbx "$S_ID" 60 <<'SH' | tail -1
for d in /home/user/*/ /home/user/*/*/; do [ -d "$d/.git" ] && git -C "$d" remote get-url origin 2>/dev/null | grep -qi montlakev2 && { echo "${d%/}"; exit; }; done
SH
)
[ -n "$SPATH" ] || { rec session.clone FAIL "no montlakev2 clone found in the Session (pass --path)"; exit 1; }
rec session.clone PASS "$SPATH"
bcall_install "$S_ID" > "$EV/bcall-install.txt" 2>&1
TITLE="[runpane-cloud test] P4 broker proof $(date -u +%FT%H%MZ)"
BODY="Opened from the runpane cloud Session $HOST through its coordinator's GitHub broker (no laptop in the path). Test only: it will be closed and its branch deleted within minutes. master must stay at $EXPECT."
if [ "$MODE" = agent ]; then
  log "== agent mode: giving the task to a Claude panel in $HOST"
  TASK="$EV/agent-task.txt"
  cat > "$TASK" <<EOF
In $SPATH (a clone of $REPO) do exactly this, then stop. You have no GitHub credentials; use only the commands named here.
1. \`git fetch origin master\` then \`git worktree add /home/user/rcl/p4-proof -b $BR origin/master\`; in that worktree add
   .runpane-cloud-test/p3-proof.md with the line "runpane cloud broker proof", commit "test: runpane cloud broker proof".
2. \`runpane cloud agent github push --path /home/user/rcl/p4-proof --branch $BR\`
3. \`gh issue create --title "$TITLE" --body "$BODY"\`
4. \`gh pr create --draft --head $BR --title "$TITLE" --body "$BODY"\`
Never push to master and never merge. Reply with one line: RESULT issue=<n> pr=<n>
EOF
  pane=$(rpc --host "$HOST" panes create --repo "$(basename "$SPATH")" --name p4-proof --agent claude --no-focus --wait-ready --ready-timeout-ms 120000 --yes --json 2>&1)
  panel=$(python3 -c 'import json,sys;print(((json.loads(sys.argv[1]).get("items") or [{}])[0]).get("panelId") or "")' "$pane" 2>/dev/null)
  [ -n "$panel" ] || { rec agent.pane FAIL "panes create: $(head -c 300 <<<"$pane")"; exit 1; }
  rpc --host "$HOST" panels submit --panel "$panel" --input-file "$TASK" --yes --json > "$EV/agent-submit.json" 2>&1
  for _ in $(seq 60); do
    n=$(ghro "repos/$REPO/pulls?state=open&head=$OWNER:$FULL" --jq '.[0].number // empty' 2>/dev/null); [ -n "$n" ] && break; sleep 20; done
  [ -n "$n" ] && echo "$n" > "$EV/.pr"
  ghro "repos/$REPO/issues?state=open&creator=" --jq ".[] | select(.pull_request==null) | select(.title==\"$TITLE\") | .number" 2>/dev/null | head -1 > "$EV/.issue"
  rpc --host "$HOST" panels last-message --panel "$panel" --json > "$EV/agent-last-message.json" 2>&1
else
  log "== script mode: the same CLI the agent uses, driven over boat exec"
  q=$(printf '%q ' "$TITLE"); qb=$(printf '%q ' "$BODY")
  sbx "$S_ID" 600 <<SH > "$EV/session-steps.txt" 2>&1
set -x
cd $SPATH && git fetch -q origin master && git worktree add -q /home/user/rcl/p4-proof -b $BR origin/master
cd /home/user/rcl/p4-proof && mkdir -p .runpane-cloud-test && echo "runpane cloud broker proof" > .runpane-cloud-test/p3-proof.md
git add -A && git commit -qm "test: runpane cloud broker proof" && git log --oneline -1
runpane cloud agent github push --path /home/user/rcl/p4-proof --branch $BR --json; echo "push exit=\$?"
gh issue create --title $q --body $qb; echo "issue exit=\$?"
gh pr create --draft --head $BR --title $q --body $qb; echo "pr exit=\$?"
SH
  grep -oE "github.com/$REPO/pull/[0-9]+" "$EV/session-steps.txt" | head -1 | grep -oE '[0-9]+$' > "$EV/.pr"
  grep -oE "github.com/$REPO/issues/[0-9]+" "$EV/session-steps.txt" | head -1 | grep -oE '[0-9]+$' > "$EV/.issue"
fi
PR=$(cat "$EV/.pr" 2>/dev/null); ISSUE=$(cat "$EV/.issue" 2>/dev/null)
log "PR=#${PR:-none} issue=#${ISSUE:-none}"

# ---------------------------------------------------------------- refusals (always scripted, from inside the Session)
sbx "$S_ID" 120 <<SH > "$EV/.bundles.txt" 2>&1
cd $SPATH && git fetch -q origin master
git branch -f wf-p4 origin/master && git worktree add -q /home/user/rcl/p4-wf wf-p4 && cd /home/user/rcl/p4-wf
f=\$(ls .github/workflows/*.y*ml | head -1); echo "# runpane-cloud test" >> "\$f"; git commit -qam "test: touch a workflow"
git bundle create /home/user/rcl/p4-wf.bundle wf-p4 --not origin/master >/dev/null 2>&1 && base64 -w0 /home/user/rcl/p4-wf.bundle > /home/user/rcl/p4-wf.b64
cd $SPATH && git worktree remove --force /home/user/rcl/p4-wf
git bundle create /home/user/rcl/p4-ok.bundle $BR --not origin/master >/dev/null 2>&1 && base64 -w0 /home/user/rcl/p4-ok.bundle > /home/user/rcl/p4-ok.b64
ls -l /home/user/rcl/p4-*.b64
SH
probe() {  # probe <check> <http-regex> <cmd...> (runs in the Session)
  local c="$1" want="$2"; shift 2
  local q r; q=$(printf '%q ' "$@"); r=$(sbx "$S_ID" 120 <<<"/home/user/rcl/$q" | tail -1)
  printf '%s -> %s\n' "$*" "$r" >> "$EV/refusals.txt"
  [[ "$(awk '{print $1}' <<<"$r")" =~ ^($want)$ ]] && rec "refuse.$c" PASS "$(head -c 160 <<<"$r")" || rec "refuse.$c" FAIL "$(head -c 200 <<<"$r")"
}
probe master-dotdot    '400|403' pushprobe "$REPO" "../../master" /home/user/rcl/p4-ok.b64
probe master-slash     '400|403' pushprobe "$REPO" "/master" /home/user/rcl/p4-ok.b64
probe master-force     '400|403' pushprobe "$REPO" "../../master" /home/user/rcl/p4-ok.b64 '{"force":true}'
probe workflow-change  '403'     pushprobe "$REPO" "p4-wf" /home/user/rcl/p4-wf.b64
[ -n "$PR" ] && probe merge-put       '403|404|405' bcall PUT "/cloud/github/pulls/$PR/merge" '{}'
[ -n "$PR" ] && probe ready-for-review '400|403'    bcall PATCH "/cloud/github/pulls/$PR" '{"draft":false}'
sh=$(sbx "$S_ID" 60 <<SH
cd $SPATH; gh pr merge ${PR:-1} --merge >/dev/null 2>&1; echo "merge=\$?"; gh pr ready ${PR:-1} >/dev/null 2>&1; echo "ready=\$?"
git push origin HEAD:master >/dev/null 2>&1; echo "gitpush=\$?"
SH
)
printf '%s\n' "$sh" >> "$EV/refusals.txt"
grep -q '^merge=2$' <<<"$sh" && grep -q '^ready=2$' <<<"$sh" && grep -qE '^gitpush=[1-9]' <<<"$sh" \
  && rec refuse.shim-and-direct-push PASS "gh pr merge/ready exit 2; direct git push to master fails (read-only Session)" || rec refuse.shim-and-direct-push FAIL "$(tr '\n' ' ' <<<"$sh")"

# ---------------------------------------------------------------- 4. verify on GitHub (read-only)
if [ -n "$PR" ]; then
  ghro "repos/$REPO/pulls/$PR" > "$EV/github-pr.json"
  v=$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["draft"],d["head"]["ref"],d["base"]["ref"],d["user"]["login"],d["title"].startswith("[runpane-cloud test]"),d["merged"])' "$EV/github-pr.json")
  read -r draft head base user tprefix merged <<<"$v"
  [ "$draft" = True ] && [ "$head" = "$FULL" ] && [ "$base" = master ] && [ "$tprefix" = True ] && [ "$merged" = False ] \
    && rec github.draft-pr PASS "#$PR draft from $head into $base by $user" || rec github.draft-pr FAIL "$v"
  [ "$KIND" = app ] && { [[ "$user" == *"[bot]" ]] && rec github.pr-author PASS "$user (the App, not Red: Red can approve it)" || rec github.pr-author FAIL "$user"; }
else rec github.draft-pr FAIL "no PR number (see session-steps.txt / agent-last-message.json)"; fi
if [ -n "$ISSUE" ]; then
  t=$(ghro "repos/$REPO/issues/$ISSUE" --jq .title); [[ "$t" == "[runpane-cloud test]"* ]] && rec github.issue PASS "#$ISSUE $t" || rec github.issue FAIL "#$ISSUE $t"
else rec github.issue FAIL "no issue number"; fi
m=$(ghro "repos/$REPO/git/ref/heads/master" --jq .object.sha); [ "$m" = "$M0" ] && rec github.master-unchanged PASS "$m" || rec github.master-unchanged FAIL "$m"
refs=$(ghro "repos/$REPO/git/matching-refs/heads/$PFX" --jq '.[].ref' | tr '\n' ' ')
[ "$refs" = "refs/heads/$FULL " ] && rec github.only-proof-ref PASS "refs under $PFX: $refs" || rec github.only-proof-ref FAIL "refs under $PFX: $refs"
rpc cloud coordinator github audit --json > "$EV/coordinator-github-audit.json" 2>&1
# cleanup + final verification run from the EXIT trap
