# Visual review: the owner's guide

CI screenshots every story of compact-mantine and graphty-element on every pull request and
compares each screenshot with its approved baseline PNG in `visual-baselines/<project>/`. A pull
request whose screenshots differ from the baselines cannot merge ("All Checks Pass" fails) until
you accept or reject each difference in the review page described here. Nothing is hosted: the
page runs on the development server and reads CI's artifacts with `gh`.

The design is `design/visual-testing/design.md`; what exists today is its section 1a.

## Opening the page

Ask an agent to start it, or start it yourself through servherd (the command is in CLAUDE.md,
"Visual review"). The page's address, including a session token after `#token=`, is printed in
the server's log every time it starts; servherd's `servherd_logs` for `visual-review` shows it.
Open that exact URL. Without the token the page shows "No session token". The token changes when
the server restarts, so a stale tab needs the new URL.

Variants of the command:

- `--master-run <run id>`: also lists master at that CI run, for seeding a project (below).
- `--results <dir> --branch <name>`: serves local captures offline. They are marked "local
  preview, not acceptable": only CI captures of a pushed commit can be accepted.

## The screens

1. **Targets.** Each open pull request with a CI run, and master when started with
   `--master-run`. Per project: how many items need a decision, how many you decided, and badges:
    - **merge master first**: master has newer baselines for this project than the pull request.
      Merge master into the branch (by merge, never rebase) and wait for CI.
    - **capture failed**: the `visual` job produced no results. Re-run that job in GitHub Actions.
    - **incomplete: N of M stories**: the capture stopped part way. Re-run the job.
    - **not seeded from master**: this project has no baselines, so every item is `new`.
2. **Grid.** A thumbnail per item that needs a decision, with its status and your decision.
3. **Story.** One item: baseline and new side by side, the changed-pixel count and box, and the
   buttons. Badges here: **size changed**, **flaky** (the two captures differed, then matched),
   and **re-review** (an accept you made was replaced by master's newer baseline).

Statuses: `changed` (differs from its baseline), `new` (no baseline), `removed` (a baseline whose
story no longer exists, lost a mode, or whose story's own parameters now exclude it), `unstable`
(two captures of the same commit differed), `failed` (did not render, even after one retry).

## Keys

| Key          | Action                                                                      |
| ------------ | --------------------------------------------------------------------------- |
| J / K        | Next / previous item                                                        |
| A            | Accept                                                                      |
| R            | Reject (asks for a reason, then Enter)                                      |
| E            | Exclude (asks for a reason, then Enter, then a confirmation)                |
| F            | Flash between baseline and new; F again returns to side by side             |
| H            | Highlight changed pixels; H again returns to side by side                   |
| Z            | Full frame at 4x (otherwise images are cropped to their content, enlarged)  |
| Space (hold) | Flash while held                                                            |
| Shift+A      | Accept every undecided item of this project without opening it (asks first) |
| Escape       | Back to the grid, or out of the reason box                                  |

## What each decision does

- **Accept**: the new screenshot becomes the baseline (or, for `removed`, the baseline is
  deleted). Allowed on `changed`, `new` and `removed`.
- **Reject**: the difference is a regression. It needs a reason, which is posted to the pull
  request as a comment with a machine-readable block an agent can read. The pull request stays
  blocked until its code changes so the capture matches the baseline again.
- **Exclude**: stops capturing the story. It needs a reason and writes
  `visual-baselines/<project>/<story id>.json` with `disableSnapshot: true`. It drops **every mode
  of the story**, on every later pull request, until that file is deleted. It is the only
  decision for `unstable` and `failed` items; for a one-off `failed` item (a timeout on a busy
  runner), re-run the `visual` job instead, since the newest attempt replaces the old results.
- **Undo** clears a decision before Finish. Decisions are kept across server restarts.

## Finish

Finish applies every decision on one target at once:

- **A pull request:** one commit holding the accepted PNGs, the exclusion files and one review
  record in `visual-baselines/reviews/`, pushed to the pull request's branch, plus one comment
  holding every reject. CI then recaptures, and the accepted items read `unchanged`.
- **Master (seeding):** a branch `visual/seed-<date>` with the same commit, and a pull request
  from it.

The commit is signed as your git configuration signs any commit, so the signing key or agent must
be available. If Finish fails, your decisions are kept and the page shows git's or GitHub's
message:

- **capture is stale, wait for CI**: someone pushed to the branch after the capture. Wait for the
  new CI run, then decide again what still differs.
- **merge master first**: see the badge above.
- **failed to write commit object** or a signing error: unlock or plug in the signing key, then
  Finish again.
- **the accepts were pushed ..., but the reject comment failed**: the accepts are done and cleared;
  press Finish again to post the rejects.

## Seeding a project

A project is "seeded" once its baselines are on master; until then the merge gate ignores it.

1. After a change to what is captured merges, note master's CI run id for that commit.
2. Start the server with `--master-run <run id>` and open "master".
3. Review the project's grid, exclude unstable stories with a reason, accept the rest, and press
   Finish. This opens the seed pull request.
4. Merge the seed pull request once its own capture shows every item `unchanged` or `excluded`
   (apart from stories changed on master in between, which are ordinary review items).

## What this does and does not guarantee (today)

- A pull request cannot pass "All Checks Pass" while its capture of a seeded project holds
  anything but `unchanged` or `excluded` items, including after "Re-run failed jobs"; a missing,
  unfinished or invalid capture blocks it too. A rejected item stays blocking until a code change
  makes it match the baseline.
- Every baseline PNG, and every settings file that excludes a story, that the pull request adds,
  changes or deletes must be named with its new hash in a review record the pull request adds
  under `visual-baselines/reviews/`; existing records may not be edited or deleted. This stops
  the shortcut of copying captured PNGs, or an exclusion, straight into `visual-baselines/`.
- It does not prove that you reviewed anything. A record is a plain JSON file: anyone who can push
  to the branch, including an agent on your machine, can write one that names the copied PNGs, and
  the gate cannot tell it from one Finish wrote. What the gate shows is that the captures match
  the pull request's baselines and that each baseline change carries a record; who wrote the
  record is unproven until signing arrives (below).
- Review records are marked `"unproven": true`. The page runs on the development server, where
  agents run with your GitHub credentials and signing key, so an agent could press Accept or call
  the page's API. CLAUDE.md forbids it; nothing technical prevents it yet. Signing with a hardware
  security key on your own computer replaces this in milestone 3 (`design/visual-testing/roadmap.md`).
- The gate is part of `.github/workflows/ci.yml`, which a pull request can edit, and a pull request
  can loosen a story's own `diffThreshold` or `delay`, or a settings file's non-excluding keys,
  without a review item. Read changes to those in code review.
- The CI half has not run yet: the visual jobs, the artifact download in "All Checks Pass", and
  whether captures are byte-identical from one CI runner to the next are unmeasured until the
  tooling pull request's own CI runs (`design/visual-testing/design.md`, section 1a).
- No pre-push visual check exists yet; it comes in milestone 2.
