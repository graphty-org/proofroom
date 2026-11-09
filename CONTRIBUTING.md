# Developing proofroom

Node 22 or later, git and git-lfs:

```sh
npm ci
npx playwright install chromium
npm run lint    # ESLint and the TypeScript type check
npm test        # the Node tests, the Playwright page tests and the published-files check
```

`package-lock.json` is committed; `npm ci` installs exactly it. To change a dependency, use npm
11 or later (`npx npm@11 install ...`): npm 10 fails to resolve vitest 4's optional peers ("Cannot
read properties of null (reading 'edgesOut')"), though its `npm ci` installs the lock file fine.

`scripts/check-old-gate.mjs <graphty-monorepo checkout>` checks that `test/fixtures/old-gate/`
still holds the gate graphty-monorepo runs, which proofroom's output must keep passing until that
repository moves to proofroom.

## Owner rules a design pass must not undo

- **Row pictures are always Spotlight, never tinted** (owner, 2026-11-09: "i never asked for tint.
  always spotlight"). The small pictures in the Changes list dim what did not change, at every size
  of change; they never show Highlight's red. Tinting rows was built twice from design passes and
  reverted twice (4ec4c00, and the one-third rule of 55ee338 that 74b0bb6 kept). `shownKind` in
  `trusted/lib/thumbs.mjs` holds it and the test "row pictures are always Spotlight" pins it. A
  design document that says otherwise is wrong.

## Acceptance test

`scripts/uat.mjs` walks a reviewer's journey through a running review page in Chromium, on that
page's real captures, and works against any repository's page. Start a page from a checkout of
the repository to review, with this working copy's CLI (`--candidate <run id>` also lists the
default branch at that run):

```sh
cd <repository to review>
PORT=4800 node <proofroom>/trusted/cli.mjs serve
```

`serve` prints the page's URL with its `#token=...`. Then, from this repository:

```sh
npm run uat -- '<page URL with #token=...>' [--shots <dir>]
```

It prints one PASS, FAIL or SKIP line per step and a summary, saves a screenshot per step to
`--shots` (default `tmp/uat-shots`), and exits 1 when any step failed. A step the page has nothing
for (no second change, no Approved before group, no captures) is skipped with the reason. It picks
what to open from the list: the candidate or seed run when one is listed, else the first change with
snapshots to decide, and then the first other change with snapshots to decide.

What it touches: it accepts and rejects snapshots, and accepts a group and a selection, only to
undo each at once, and its last step checks that the opened changes' counts are as they were. Use
a page whose decisions nobody is in the middle of; a run interrupted mid-step can leave one
decision behind. It never presses Finish's final confirm, Exclude or Start capture, never
registers a passkey and never creates a virtual authenticator. Opening a change whose images are
not on disk downloads them.
