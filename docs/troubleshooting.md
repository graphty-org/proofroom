# Troubleshooting

- **Where the disk space goes, and "Images not on disk: opening downloads 68 MB".** `serve`
  keeps every capture it downloads in `workDir` (`<run>-<attempt>/<project>/`), with the
  pictures it makes from them (`thumbs/`, `spots/`) and your decisions (`state/`). After each
  refresh it adds up what `workDir` holds; Settings shows it beside the budget
  (`diskBudget`, 10 GB by default). Over the budget, it first deletes the downloads of runs no
  change lists any more, then removes the full images and pictures of whole changes: those that
  need nothing from you (finished, or nothing to decide) first, then the least recently opened.
  It never removes a change's `results.json` or your decisions, so its row keeps its counts, and
  it never touches a change a page has open or one opened in the last hour. Opening such a change
  downloads its images again. Once the code host has deleted the artifacts (GitHub keeps them 90
  days by default), its row says "Images deleted by the code host: capture again": re-run its
  capture job. To keep more on disk, raise `diskBudget`.
- **"baseline is an LFS pointer; run git lfs pull".** The checkout was made without git-lfs, so
  the baselines are small pointer files. Install git-lfs, run `git lfs install`, then
  `git lfs pull`.
- **`serve` refuses to start, or Finish says git-lfs is missing or its filter is not
  configured.** Install git-lfs and run `git lfs install` (it sets up the filters in your global
  git configuration).
- **A push of baselines left CI unable to fetch them.** `git lfs install` adds a pre-push hook
  that uploads the images a push points at. If your repository's hooks belong to husky (or any
  other `core.hooksPath`), that hook is not installed: call `git lfs pre-push "$@"` from your own
  pre-push hook. `git push --no-verify` skips the upload too; after one that carried baselines,
  run `git lfs push origin <branch>`.
- **download failed / failed to load: ...; reload the page to retry.** `serve` starts
  downloading every capture as soon as it starts, and retries a gh call that fails on the network
  (DNS, a dropped connection, a GitHub 5xx) three times over about 20 seconds; it logs each failed
  call and each retry to stderr. A project whose download still fails shows "download failed", a
  pull request (or the default branch's run) GitHub would not answer for shows "failed to load",
  or, when it loaded before, keeps what it showed with "could not refresh", and everything else
  loads as usual. Reload the page to try again; captures already downloaded are kept, and a
  damaged one is downloaded again.
- **A gh or git call hangs.** Every gh and git call `serve` and Finish make is stopped after 10
  minutes (`VISUAL_REVIEW_TIMEOUT_MS` sets another limit, in milliseconds), and git never waits
  for a credential prompt. A stopped Finish names the step it was on and keeps your decisions.
- **"the server stopped while this Finish was at ..."** The server restarted during a Finish.
  Look at the branch on origin to see whether its commit was pushed before pressing Finish again.
- **"... was pushed as ..., but opening its pull request failed"** (the seed). Press Finish
  again: it opens the pull request for the branch already pushed.
- **capture failed / no capture** on a target. The `visual` job produced no results. Open its
  log from the page and re-run the job. **incomplete: N of M stories**: the job stopped part way
  (a timeout); re-run it.
- **Every story is `new` on a pull request.** No reference capture of the default branch could be
  downloaded (none finished yet, or its artifacts expired after 30 days). Re-run the `visual` job
  once a run on the default branch has finished.
- **Finish says "capture is stale, wait for CI".** Someone pushed to the branch after the capture
  (anything other than a merge of the default branch that leaves the files you decided alone).
  Wait for the new run, then decide again what still differs.
- **Finish fails with "failed to write commit object"** or another signing error: unlock or plug
  in your signing key, then press Finish again. Your decisions are kept.
- **"the accepts were pushed ..., but the comment with the rejects failed".** The accepts are
  done; press Finish again to post the rejects. Accept notes it held are named in the message and
  not posted again.
- **"Passkey failed (This is an invalid domain.)"** or similar: the page is served from an IP
  address or plain http. Serve it over https from a host name.
- **"the record changed after you approved it; press Finish again".** The decisions, the capture
  or the default branch changed between your Face ID and the commit. Press Finish again and
  approve the new record. **"the approval is stale"** means the same, from another tab or after
  ten minutes.
- **"no passkey is registered for `<host>`".** Passkeys belong to the host name the page is served
  from. Serve the page from the host your passkey is for, or register one for this host.
- **"Not approved (the passkey prompt was cancelled or refused): nothing was changed".** Press
  Finish again.
- **The gate says "changed with no review record taking it from its base branch contents to
  these".** Either nothing approved the change, or the default branch changed the same file
  after your Finish, so the record starts from contents the base no longer has. Merge the default
  branch into the pull request, let CI capture again, and review the file again.
- **The gate says a record is "a copy of a record already on the base branch".** An approval
  counts once. Remove the copied record and its files, and review the change on this pull
  request.
- **The gate says a story is compared at a diffThreshold above 0.8.** Lower it in the story's
  parameters or its settings file.
- **The gate fails a change to `visual-review/passkeys.json`.** See [Replacing the
  passkey](../README.md#replacing-the-passkey).
- **The gate says "approval is from a key not in passkeys.json on the base branch".** The record
  was approved with a key that the base branch does not hold yet: merge the pull request that
  registers it first, then review again.
- **The gate says a record has no passkey approval** on a pull request Finished before your
  passkey was registered. Revert its accept commit (which takes the record and the baselines out
  of the diff), let CI capture again, and review it again with Face ID: the page keeps your
  decisions on unchanged images but no longer counts them as published, so Finish publishes them
  again. Never edit a record by hand: the gate only accepts what your device approved.
- **Opening the seed issue fails.** Every label in `issueLabels` must exist in the repository.
- **The pnpm setup step fails in CI.** `pnpm/action-setup` reads the pnpm version from the
  `packageManager` field of your root `package.json`; add one.
- **A merge conflict under the baselines directory.** Run `proofroom update <pr>` (or press
  **Update from master...**): it takes the default branch's side for every conflicting file there,
  pushes, and CI captures again; review what still differs. It refuses, changing nothing, when
  anything outside the baselines directory conflicts too.
- **Captures differ from what you see locally.** Only CI's captures are compared: fonts and the
  graphics stack differ from machine to machine unless the config's `fontconfig` pins the fonts.
  A local preview you accepted that CI draws differently comes back to you undecided on CI's
  capture: accept it there. See [local previews](https://github.com/graphty-org/graphty-monorepo/blob/master/design/visual-testing/local-previews.md).
