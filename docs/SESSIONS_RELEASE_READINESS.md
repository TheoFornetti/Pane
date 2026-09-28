# Sessions release preparation — 28 September 2026

## Prepared PRs

| Track | Order | PR | Prepared head |
| --- | --- | --- | --- |
| Sessions | 1 | #728 Resume arguments | `d7357d79` |
| Sessions | 2 | #819 Session workspaces | `49718841` |
| Sessions | 3 | #821 Panels open and split tabs | `42dac2cf` |
| runpane | 1 | #844 Session watch | `587ecb66` |
| runpane | 2 | #845 Agent delivery | `c787b260` |
| runpane | 3 | #846 Pane lifecycle | `61095864` |

#816, #817 and #818 were already merged into main. #820 and the later
#821 title-bar / plus-menu redesign commits are excluded. Functional Session
workspace controls and split tabs remain.

## Merge order

1. Merge #844, #845 and #846 into main in order, retargeting stacked children
   after their parent merges.
2. Merge #728, #819 and #821 into `integration/sessions` in order, retargeting
   each child to the integration branch after its parent merges.
3. Merge main into the integration branch, preserving both tracks' behavior.
   Keep this shared branch current with merges. Do not rebase it while PRs
   target it.
4. Review the assembled release, then open the integration-to-main PR and
   release from clean main using `docs/RELEASE_INSTRUCTIONS.md`.

The prepared heads are individually mergeable against their current bases.
GitHub changes commit identities for squash/rebase merges, so stacked children
may need restacking after a parent merge.

## Combined candidate

`prep/sessions-combined` contains both prepared tracks and the tested conflict
resolutions. Use it for integrated testing and when assembling the release.
It was built from main `c6a468dc` (v2.4.135). No feature PR was merged and no
application release was published during preparation.

The combined merge preserves:

- Wrapper detection, original launch arguments, and custom resume templates.
  Reported custom IDs are captured only from explicit markers; generated IDs
  survive native agent banners. The source fix is in #728.
- Live Session membership events and first-association pin handling.
- Both tracks' CLI commands, response fields, examples, and regenerated
  TypeScript/Python contract artifacts.
- Explicit focus requests on reopened tabs and protection for edits made while
  a file refresh is pending.

## Validation

- Every component received sub-agent review; reported blockers were fixed and
  re-reviewed. The combined integration review is clean.
- Combined lint, typecheck, and `pnpm test:runpane-contract` passed.
- Combined main-process suite: 1,531 passed, 3 skipped before the last custom
  resume fix; all 94 terminal tests passed after that fix. The final change
  inherited from #846 only fixes Windows quoting in a test fixture; its 22
  focused tests passed.
- Combined Session Playwright suite: 16 passed, including focus/reuse and edits
  made during delayed file refresh. These use the Electron API fixture.
- Sessions-only and combined `pnpm build:mac:arm64` builds passed, using
  `CSC_DISABLE=true CSC_IDENTITY_AUTO_DISCOVERY=false`. The existing build
  configuration also generated x64 artifacts. These are local test builds.
- GitHub checks on each PR validate its latest pushed head. React Doctor has
  advisory warnings on the Session changes; there are no blocking findings
  from sub-agent review.

Live third-party agent sessions and signed/notarized release publishing were
not exercised. Publishing remains the normal release workflow after approval
and merge.
