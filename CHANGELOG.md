# Changelog

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
