# Visual review: the owner's guide

CI screenshots every story of compact-mantine and graphty-element on every pull request and
compares each screenshot with its approved baseline PNG in `visual-baselines/<project>/`. A pull
request whose screenshots differ from the baselines cannot merge ("All Checks Pass" fails) until
you accept or reject each difference in the review page described here. Nothing is hosted: the
page runs on the development server and reads CI's artifacts with `gh`.

The baseline PNGs are stored in Git LFS; review records and story settings files are plain git.

The design is `design/visual-testing/design.md`; what exists today is its section 1a.

## Setup (once per machine)

Every machine that accepts baselines, or pushes a branch holding them, needs git-lfs:

- **Ubuntu 22.04:** `sudo apt-get install git-lfs`, then `git lfs install`.
- **Without root:** download the Linux tarball from https://github.com/git-lfs/git-lfs/releases,
  put its `git-lfs` binary in `~/bin` (on your `PATH`), then run `git lfs install`.

`git lfs install` sets up the filters in your global git configuration. It also tries to add a
pre-push hook and fails to, because this repository's hooks are husky's; that is expected:
`.husky/pre-push` runs `tools/lfs-pre-push.sh` first, which uploads the images a push points at.
Then run `git lfs pull` in each checkout that already existed, so its baselines are images rather
than pointer files.

What happens without it:

- `visual-review serve` refuses to start, naming the install steps, because an accept would
  commit raw PNGs instead of LFS pointers. Finish checks again, and also refuses a commit whose
  PNG did not become a pointer.
- `git push` of a branch holding baseline PNGs is refused with the same steps; a push holding
  none goes ahead with a note.
- A checkout made without git-lfs holds small pointer files instead of images. A local
  `capture` or `compare` against them stops with "baseline is an LFS pointer; run git lfs pull";
  it never reports every image as changed.
- `git push --no-verify` skips the upload too. After one that carried baseline images, run
  `git lfs push origin <branch>`, or CI's capture fails to fetch them and blocks the pull request.

## Opening the page

Ask an agent to start it, or start it yourself through servherd (the command is in CLAUDE.md,
"Visual review"). The page's address, including a session token after `#token=`, is printed in
the server's log every time it starts; servherd's `servherd_logs` for `visual-review` shows it.
Open that exact URL. Without the token the page shows "No session token". The URL stays valid
across restarts; deleting `tmp/visual-review/state/token` issues a new one.

Finish's commit is signed by the git environment the server was started from. When an agent
starts it, that is the agent's signing key, not yours. The top of the targets screen and Finish's
confirmation name the key that will sign, where git found it (a config file, or the command line
when the server's environment set it) and the committer, and print the exact command that starts
the same server from your own shell. To sign as yourself, stop the agent's server (servherd's
`servherd_stop` for `visual-review`) and run that command in your own terminal.

Variants of the command:

- `--master-run <run id>`: also lists master at that CI run, for seeding (below).
- `--results <dir>`: serves local captures offline, for looking at a story before a pull request
  exists (below). It is listed as "Local preview", never as master or a seed, and it is look
  only: no Accept, Reject or Exclude, and no Finish. Only CI captures of a pushed commit are
  decided.

## The screens

1. **Targets.** Each open pull request with a CI run, and master when started with
   `--master-run`. Per project: how many items need a decision, how many you decided, and badges:
    - **merge master first**: master has newer baselines for this project than the pull request.
      Merge master into the branch (by merge, never rebase) and wait for CI.
    - **capture failed**: the `visual` job produced no results. Re-run that job in GitHub Actions.
    - **incomplete: N of M stories**: the capture stopped part way. Re-run the job.
    - **not seeded from master**: this project is not reviewed on master (`seedFromMaster: false`
      in `projects.json`); its first baselines are accepted on a pull request.
2. **Grid.** It opens on **Needs a decision** (the undecided items, counted on the button); **All**
   and one button per status show the rest. A line above the grid splits what is shown into
   errors and images to compare, so the counts always add up. At the top, **Errors** lists every failed capture with its reason and,
   under "console and stack", the story's console output and the thrown error's stack (a play
   function's failed `expect` included). An error is never accepted: fix the story, re-run the
   `visual` job for a one-off timeout, or exclude it with a reason. Below it the items are grouped
   by component (the story id before `--`), components with a changed item first, then new,
   unstable and removed ones; each story's modes (light, dark) sit side by side under its name.
   Every tile is numbered, and the number is the story screen's "N of M". A component's
   **Accept N undecided** accepts that component's undecided items without opening them, after
   asking. **Filter by story id** narrows the grid; **Go to** opens item N, or the first item
   whose id contains the text. Coming back from a story, its tile is outlined and scrolled into
   view.
3. **Story.** One item, on one screen: the controls on top, then two panes of the same size side
   by side, the baseline on the left and the new capture on the right, filling the rest of the
   window. Images open at **Fit to screen**: both whole images fit their panes, across and down,
   at one scale (never above real size), so two captures of the same size line up pixel for pixel
   and nothing scrolls. With no baseline (a new story, or "no baseline yet") the left pane stays
   as an empty frame labelled "No baseline", so the new image sits exactly where it would beside
   one; a removed or failed story leaves the right pane empty the same way. **Real size (1x)** is
   one CSS pixel of the page for each CSS pixel the story was drawn at (a capture holds two image
   pixels per CSS pixel). **2x**, **4x** and **8x** enlarge it; from 4x pixels are drawn as hard
   squares. Zoomed, the images grow past their panes, which scroll: scrolling one scrolls the
   other to the same place, and **Fit to screen** returns to the whole image. (On an iPad,
   pinching zooms the whole page; use the zoom buttons to zoom the images.) **Next changed box**
   (N) scrolls both panes until the next region of changed pixels is in view and outlines it;
   "box i of k" counts them. The views, each shown in the right pane at the same scale and place:
   **Side by side**; **Flash**, which shows baseline and new one after the other in the same
   place, about 1.5 times a second (the images themselves, not an overlay), keeping the zoom and
   scroll it was opened at; **Highlight**, pixelmatch's changed pixels in red over the dimmed
   baseline; and **Spotlight**, the new image dimmed everywhere except around the changed pixels
   (each grown by 10 image pixels), which finds a one-pixel change. Flash, Highlight and
   Spotlight need two images; on a new or removed story they are off and the page says why
   ("New story, no baseline", "Only one image: this story was removed"). Badges here:
   **size changed** (in image pixels), **flaky** (the two captures differed, then matched), and
   **re-review** (an accept you made was replaced by master's newer baseline).

Statuses: `changed` (differs from its baseline), `new` (no baseline, and on a pull request the
story is new or looks different from master's newest capture of it), `no baseline yet` (status
`unseeded`: no baseline, and the pull request does not change it), `removed` (a baseline whose
story no longer exists, lost a mode, or whose story's own parameters now exclude it), `unstable`
(two captures of the same commit differed), `failed` (did not render, even after one retry).

`no baseline yet` items are listed under their own filter in the grid and never need a decision:
they do not block the pull request, Accept all skips them, and the story screen offers no buttons
for them. Seed them from master (below), or accept them on the pull request that changes them.

## Keys

| Key          | Action                                                                         |
| ------------ | ------------------------------------------------------------------------------ |
| J / K        | Next / previous item                                                           |
| A            | Accept an undecided item                                                       |
| R            | Reject an undecided item (asks for a reason, then Enter)                       |
| E            | Exclude an undecided item (asks for a reason, then Enter, then a confirmation) |
| U            | Undo the item's decision                                                       |
| F            | Flash between baseline and new; F again returns to side by side                |
| H            | Highlight changed pixels; H again returns to side by side                      |
| S            | Spotlight the changes; S again returns to side by side                         |
| Z            | Next zoom: fit to screen, real size, 2x, 4x, 8x, then fit again                |
| N            | Next changed box                                                               |
| Space (hold) | Flash while held                                                               |
| Shift+A      | Accept every undecided item of this project without opening it (asks first)    |
| Escape       | Back to the grid from a story, wherever the focus is (the reason box included) |

No key reverses a decision. A, R and E do nothing on an item that is already decided, and say
so; to change a decision, press U (or the Undo button) first. The same key twice never undoes.

## What each decision does

- **Accept**: the new screenshot becomes the baseline (or, for `removed`, the baseline is
  deleted). Allowed on `changed`, `new` and `removed`.
- **Reject**: the difference is a regression. It always needs a reason, which is posted to the pull
  request as a comment with a machine-readable block an agent can read. The pull request stays
  blocked until its code changes so the capture matches the baseline again.
- **Exclude**: stops capturing the story. It needs a reason and writes
  `visual-baselines/<project>/<story id>.json` with `disableSnapshot: true`. It drops **every mode
  of the story**, on every later pull request, until that file is deleted. It is the only
  decision for `unstable` and `failed` items; for a one-off `failed` item (a timeout on a busy
  runner), re-run the `visual` job instead, since the newest attempt replaces the old results.
- **Undo** (U) clears a decision before Finish; it is the only way to change one. Decisions are
  kept across server restarts.
- After Finish, accepts and exclusions are cleared; rejects stay, marked as already posted, and
  still show as rejected on the next CI run while the capture is unchanged. Finish does not post
  them twice. They live in this server's `tmp/visual-review/state/`, not in the repository.

## Finish

Finish applies every decision on one target at once:

- **A pull request:** one commit holding the accepted PNGs, the exclusion files and one review
  record in `visual-baselines/reviews/`, pushed to the pull request's branch, plus one comment
  holding every reject. CI then recaptures, and the accepted items read `unchanged`.
- **One commit status**, "Visual review", posted once when Finish completes (never per
  decision), on the commit Finish pushed, or on the captured commit when it pushed none. It
  fails when anything was rejected, is pending while items are left undecided, and succeeds
  otherwise; its description counts the accepts, rejects, exclusions and undecided items. It is
  information for the pull request page, not a required check: the merge gate is "All Checks
  Pass". If posting it fails, the page says so; what was pushed and posted stays.
- **Master (seeding):** a branch `visual/seed-<date>` with the same commit and a pull request
  from it, and one issue holding every reject (labelled `bug`) with the same machine-readable
  block, for an agent to fix the stories. Rejects alone, with nothing accepted, open only the issue.

The commit is signed by whatever git configuration the server process sees: yours when you
started it, the agent's key when an agent started it (the page names the key before Finish). If Finish fails, your decisions are kept and the page shows git's or GitHub's
message:

- **capture is stale, wait for CI**: someone pushed to the branch after the capture. Wait for the
  new CI run, then decide again what still differs.
- **merge master first**: see the badge above.
- **failed to write commit object** or a signing error: unlock or plug in the signing key, then
  Finish again.
- **the accepts were pushed ..., but the reject comment failed**: the accepts are done and cleared;
  press Finish again to post the rejects.

## Seeding: one story at a time

A story does not have to look right the first time, and nothing has to be seeded in one pass.
Seeding is per story:

1. Master's CI captures every story on every push. Start the server with `--master-run <run id>`
   (master's newest CI run) and open "master". Every story without a baseline is `new` there.
2. **Accept** the stories that look right. **Reject** the ones that do not, with a reason saying
   what is wrong. **Leave the rest** undecided; they simply stay without a baseline. Exclude only
   stories that are unstable. Press Finish: the accepts become the seed pull request, and the
   rejects become one issue whose machine-readable block an agent reads to fix the stories.
3. Merge the seed pull request once its own capture shows its accepted items `unchanged`.

To seed from an older, known-good commit instead of master's newest, capture it with master's
tool: `gh workflow run visual-seed.yml --ref master -f ref=<sha>`, then start the server with
`--master-run <that run's id>`. It is listed as "master"; its results.json names the captured
commit, so Finish's seed branch starts from that commit.

A story with no baseline on master is in the "no baseline yet" state. On every pull request, CI
compares its capture with master's newest capture of that story:

- **The pull request does not change it:** `no baseline yet` (`unseeded`). It is shown, it does
  not block the pull request, and it is never accepted by Accept all.
- **The pull request adds the story, or changes how it looks** (for example an agent fixing a
  story you rejected): `new`. It blocks that pull request until you decide. Review it there;
  accepting it creates its first baseline in that pull request's accept commit.

So seeding never restarts from scratch: each round accepts what now looks right, and the rest
waits, blocking nothing, until a pull request touches it. A project enters the merge gate when its
first baseline lands on master; before that the gate ignores it entirely.

If master's capture could not be downloaded (its artifacts expired, or no master run has finished
one), every story without a baseline is `new` on that pull request. Re-run its `visual` job once
master's CI has finished.

## Iterating on a story before a pull request exists

To try a story's look quickly, capture it locally and look at it, as a PNG or in the page:

```bash
pnpm exec nx run compact-mantine:build-storybook   # or graphty-element:build-storybook
node visual-review/trusted/cli.mjs capture --project compact-mantine \
    --out tmp/visual-preview/compact-mantine --stories button--,badge--
```

`--stories` captures only the story ids that start with one of the given prefixes, in seconds
rather than minutes, and then reports no baseline as removed. Start the server with
`--results tmp/visual-preview` to see the capture beside its baseline. Capture and look again
after each change. A local preview is look only: its fonts and graphics stack are not CI's, so
only a CI capture of a pushed commit becomes a baseline. Push, let CI capture, and accept it on
the pull request.

## How captures and baselines move

- **What a capture is.** Each story and mode is opened in a 1200 x 900 viewport at device scale
  factor 2, as Chromatic captures, so a PNG holds two image pixels per CSS pixel. It is cropped
  to the story's rendered content: its text, images and form controls and whatever paints a
  background, border or shadow, tooltips and popovers included, but not an empty full-width
  wrapper nor what a scroll area hides, plus a 32 px margin. graphty-element keeps its viewport: the full width, cropped only
  in height, never past the viewport, because capturing beyond it could resize the graph's
  canvas, which clears it. results.json records the scale as `scale`, and each review record
  copies it into its `subject`.
- **From GitHub Actions to the page.** Each `visual` job uploads `results.json` and the PNGs to
  review as an artifact `visual-<project>-<attempt>`, kept 30 days. The server lists open pull
  requests with `gh`, finds each one's newest CI run, and downloads those artifacts with
  `gh run download` into `tmp/visual-review/`. It downloads nothing from Git LFS: the baselines a
  capture was compared with travel inside the artifact.
- **What an accept does.** Finish writes the accepted PNGs (as LFS pointers, uploading the images
  with `git lfs push`) and one review record in a throwaway worktree at the captured head,
  commits, and pushes to the pull request's branch. CI then runs again on that branch.
- **Nothing restarts from scratch.** Every push captures again and compares with the baselines
  the branch holds now, so after an accept the accepted items read `unchanged` and only what is
  still undecided shows. Decisions you made but did not Finish are kept for every image whose
  hash did not change.

## What this does and does not guarantee (today)

- A pull request cannot pass "All Checks Pass" while its capture of a seeded project holds
  anything but `unchanged`, `excluded` or `no baseline yet` items, including after "Re-run failed
  jobs"; a missing, unfinished or invalid capture blocks it too. A rejected item stays blocking
  until a code change makes it match the baseline.
- `no baseline yet` rests on master's capture being honest and recent: a story is `new` (blocking)
  only when it looks different from master's newest complete capture of it. That capture may be a
  few merges older than the pull request's base; a story changed on master in between then shows
  as `new` on the pull request, which blocks rather than passes.
- Every baseline PNG, and every settings file that excludes a story, that the pull request adds,
  changes or deletes must be named with its new hash in a review record the pull request adds
  under `visual-baselines/reviews/`. A baseline PNG is a Git LFS pointer in git, and the gate reads
  the image's hash from the pointer, so it never downloads an image. Only the path and new hash are checked: any JSON file with
  an `items` entry naming them passes, and the hash need not match a CI capture; existing records may not be edited or deleted. This stops
  the shortcut of copying captured PNGs, or an exclusion, straight into `visual-baselines/`.
- It does not prove that you reviewed anything. A record is a plain JSON file: anyone who can push
  to the branch, including an agent on your machine, can write one that names the copied PNGs, and
  the gate cannot tell it from one Finish wrote. What the gate shows is that the captures match
  the pull request's baselines and that each baseline change carries a record; who wrote the
  record is unproven until passkey approval arrives (below).
- Review records are marked `"unproven": true`. The page runs on the development server, where
  agents run with your GitHub credentials and signing key, so an agent could press Accept or call
  the page's API. CLAUDE.md forbids it; nothing technical prevents it yet. In milestone 3 Finish
  asks for your passkey and Face ID on your iPhone, iPad or Mac, and the gate counts an accept
  only with that approval; the commit's git signature no longer matters
  (`design/visual-testing/design.md`, section 8).
- The projects the gate checks are the ones with baselines on the base branch, so editing
  `visual-review/projects.json` does not remove one from the gate.
- The gate is part of `.github/workflows/ci.yml`, which a pull request can edit, and a pull request
  can loosen a story's own `diffThreshold` or `delay`, or a settings file's non-excluding keys,
  without a review item. Read changes to those in code review.
- The CI half has not run yet: the visual jobs, the artifact download in "All Checks Pass", and
  whether captures are byte-identical from one CI runner to the next are unmeasured until the
  tooling pull request's own CI runs (`design/visual-testing/design.md`, section 1a).
- No pre-push visual check exists yet; it comes in milestone 2.
