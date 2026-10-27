# Coming from @graphty/visual-review

proofroom 1.0.0 is the next version of `@graphty/visual-review`, under a new name. Your config,
baselines, approvals and passkeys stay where they are, and nothing on disk is converted.

## Moving over

- **Install**: `npm install --save-dev proofroom`, then remove `@graphty/visual-review`. The command
  is `proofroom` instead of `visual-review`.
- **Config, baselines, approvals, passkeys**: nothing to change or move. `visual-review.config.json`,
  `visual-baselines/` (or your configured folder), story settings files, `renames.json`, tree
  statements under `visual-review-approvals/` and `visual-review/passkeys.json` are read as before.
  Existing tree statements keep verifying, and Finish keeps writing them until the config sets
  `"approvalFormat": "change"`. Set that once your repository's CI runs proofroom's gate; from then
  on approvals survive other changes landing (see [The approval format](approval-format.md)).
- **Decisions in progress** are kept: the server reads the same decision files, keyed by snapshot
  file and image hash. Moving in the middle of a review loses nothing.
- **Links** already posted in pull request comments open the right change and snapshot.
- **CI**: `proofroom init --force` writes the new workflow templates (`run` in place of `capture`,
  the JUnit upload, the inputs for capture requests, the version pinned at 1.0.0). A workflow you
  wrote by hand changes `npx @graphty/visual-review@<v> capture` to `npx proofroom@1.0.0 run`, and
  adds `--no-fail` when a later step must run even though a snapshot did not pass. The gate step
  changes only its package name.
- **The Vitest integration**: import from `proofroom/vitest` and `proofroom/vitest/setup`. Set
  `fail: "errors"` to keep the old behavior of passing a story test that has a difference.
  `merge-results` is now `collect`.
- **Flaky snapshots**: rely on your test runner's retries, or add `--retries 1` to `run`, and point
  your flaky-test tool at the JUnit file or the runner's own report.
- **Known-noise state files** (`<workDir>/state/noise-evidence.json` and `known-noise.json`) are
  ignored and can be deleted.
- **Mixed versions**: a capture made by proofroom is accepted by the gate of
  `@graphty/visual-review`, so you can move the capture first and the gate later. Approvals follow
  the gate, never ahead of it (`approvalFormat`).

## What is different

- **The review page** is new: one page with the Changes, Snapshots and viewer panes, a Baselines
  screen and a Captures screen (see [The screens](the-screens.md)). Its keys differ: `[` and `]` for
  projects are gone; digits are zoom levels; Shift+1, Shift+2 and Shift+3 fold the panes; Left and
  Right move between snapshots (see [Keys](keys.md)).
- **Removed**: known capture noise, the flaky list and Review together (deciding coupled pull
  requests at once).
- **One shot per snapshot.** `run` shoots each snapshot once (more only with `--retries`), never
  reshoots a failed render on its own, writes no `second/` folder and never reports `unstable`. An
  `unstable` snapshot in an old capture shows as "unstable (old capture)" and can only be excluded.
- **`capture` no longer judges.** It only takes the images; `run` is what `capture` was (capture
  and compare). `compare` writes `results.json` and the JUnit file and exits 1 when a snapshot did
  not pass. See [Capture and compare](capture-and-compare.md).
- **The Vitest integration fails a story test on a difference** unless `fail: "errors"`.
- **Internal routes removed**: `/api/noise`, `/api/img`, `/api/thumb`, `/api/spot`,
  `/api/decide-group` and `/api/accept-all-group`. `serve --ui` is gone.

`results.json` stays version 1, with `flaky` always written as `false`, so a gate of
`@graphty/visual-review` reads every capture proofroom makes.
