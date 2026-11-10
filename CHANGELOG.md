# Changelog

## 1.1.0

Everything 1.0.0 publishes is kept. What changes:

**A simpler review page.**

- Each changed row's picture is cropped onto its change and shown in Spotlight, with nothing drawn
  over it.
- The list says each count once, groups have one-line headers, and the toolbar has seven controls.
- Every keyboard shortcut has a visible button that shows its key. Previous [Up] and Next [Down]
  buttons are on every list.
- "Behind master" and "a newer capture" are small chips on the first line, not paragraphs.
- The held candidate and the rolling renders are named by their commit, and the candidate is listed
  first.

**Finish.**

- The approval is prepared as soon as the decisions are complete, and its progress is shown.
- The Finish sheet no longer reports a false conflict.
- A candidate's approval commit names the candidate.
- Finish never signs a candidate's tree while one of its projects is not loaded.

**The review server.**

- Pages answer at once. Before, every refresh started one git process for each review record of
  each open pull request, and with many pull requests a page took seconds to load or stayed blank.
- Older rolling renders are deleted while a pull request waits for CI. Before, they filled the
  disk budget, and a held candidate lost its images every hour it sat unopened.
- A run with a gated `visual-final` capture is reviewed from that capture.
- An unchanged item's baseline is read from git, never reported as a damaged image.
- A damaged download replaces only its own capture.

**Capture.**

- The capture browser renders at 2x for the whole run, not only during each shot.
- A story whose play function threw is recorded as failed.
- A flaky story keeps its differing first shot, named.
- A retried split capture keeps its shard.
- A whole story id is captured alone, not every id it is a prefix of.
- A changed story is shot once when it is master's capture.
- Master's reference capture comes from master's first-parent line.

## 1.0.0

The first version published as `proofroom`. It was `@graphty/visual-review` until 0.2.35; moving
over is described in [Coming from @graphty/visual-review](docs/coming-from-visual-review.md), and
the history before 1.0.0 is in this repository's git log.

What 1.0.0 publishes, and so keeps through every 1.x version:

1. **The command line**: `init`, `capture`, `compare`, `run`, `collect`, `junit`, `reference`,
   `parity`, `serve`, `gate`, `notify`, `update`, `usage` and `install-browser`, their options, and
   their exit codes: 0 passed, 1 a snapshot did not pass, 2 the tool failed (`--no-fail` makes 1
   into 0).
2. **The library entry points**: `proofroom/capture` (`capture()`, `openCapture()`),
   `proofroom/compare` (`compareSnapshot()`, `assertSnapshot()`), `proofroom/vitest` and
   `proofroom/vitest/setup` (with the `fail` option).
3. **The capture line and the result line**: a result line is a `results.json` item plus `project`,
   `attempt` and `passed` ([Test results](docs/test-results.md)).
4. **`results.json` version 1**, with the optional `areas`, `pictures`, `renderer` and `attempts`;
   `flaky` is always written, as `false`, and `unstable` is never written, so the gate of
   `@graphty/visual-review` reads every capture 1.0.0 makes.
5. **The JUnit file** that `run`, `compare` and `collect` write ([Test
   results](docs/test-results.md)).
6. **The config keys** of `visual-review.config.json`, including `diskBudget`, `captureCommand`,
   `codeHost`, `captureStore`, `stories`, `renderer`, `approvalFormat`, `repositoryId` (required
   for plain git) and `selfApproval`, and the review page's addresses. The passkey list's path is
   not a key: it is `visual-review/passkeys.json`.
7. **The approval format**: the change statement's fields, its id, its layout
   `<approvals>/<change>/<approvedAt>-<id12>.json`, the gate's rule (settings read from the base
   only, append-only history, the chain), its JSON Schema and the example statements; the passkey
   list's optional `identity`. Version 1 tree statements keep verifying through 1.x, in tree mode,
   when the change adds them ([The approval format](docs/approval-format.md)).

1.0.0 still reads, unchanged: `visual-review.config.json`, the baselines folder, story settings
files, `renames.json`, Git LFS pointers; `results.json` version 1 from `@graphty/visual-review`,
`unstable` items and `second/` folders included, and `skipped.json` markers; tree statements and
their signatures; the per-pull-request review records under the baselines folder; decision files;
the usage log, old and new event names; and old page addresses in posted comments.

### Removed

- The review page before 1.0.0, and `serve --ui`: the page at `/` is the only page, and `/next/`
  sends its links there.
- Known capture noise (`noise-evidence.json`, `known-noise.json`, `GET /api/noise`) and the flaky
  list: use `run --retries` or your test runner's retries.
- Review together (`POST /api/decide-group`, `POST /api/accept-all-group`, `groups.jsonl`).
- The `zoom` and `both` pictures, and `GET /api/img`, `/api/thumb` and `/api/spot`.
- The `merge-results` name for `collect`.
