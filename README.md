# @graphty/visual-review

Visual regression review for Storybook, hosted by nobody. GitHub Actions screenshots every story
on every pull request and compares each screenshot with an approved baseline PNG kept in your
repository (in Git LFS). You open a review page on your own machine, see every difference side by
side, and accept, reject or exclude each one. Accepting commits the new baselines to the pull
request's branch. A required check, the "Visual gate", keeps a pull request from merging while it
holds a difference nobody accepted.

There is no service, account or per-snapshot bill: the captures live in GitHub Actions artifacts
for 30 days, the baselines live in git, and the review page reads both through the `gh` CLI with
your login.

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install and set up](#install-and-set-up)
- [Configuration](#configuration)
- [The GitHub Actions workflows](#the-github-actions-workflows)
- [Your first review: seeding baselines](#your-first-review-seeding-baselines)
- [Opening the review page](#opening-the-review-page), [the screens](#the-screens), [keys](#keys),
  [decisions](#what-each-decision-does), [Finish](#finish), [the passkey](#approving-with-a-passkey)
- [Updating from the default branch](#updating-from-the-default-branch)
- [Seeding one story at a time](#seeding-one-story-at-a-time)
- [Iterating on a story before a pull request exists](#iterating-on-a-story-before-a-pull-request-exists)
- [Story parameters](#story-parameters)
- [Reorganizing stories: renames](#reorganizing-stories-renames)
- [What the gate does and does not guarantee](#what-the-gate-does-and-does-not-guarantee)
- [Troubleshooting](#troubleshooting)

## How it works

1. **Capture (CI).** On every pull request and every push to your default branch, a workflow job
   per Storybook builds it, opens every story in Chromium (1200 x 900 at device scale factor 2,
   a fixed clock, software WebGL, WebGPU removed), screenshots it, and compares the screenshot
   with its baseline. Anything that differs is captured a second time, so a real change, an
   unstable story and a one-off flake are told apart. The results (`results.json` and the PNGs
   worth looking at) are uploaded as an artifact.
2. **Review (your machine).** `visual-review serve` lists your open pull requests, downloads their
   captures, and serves a page with a grid of every change and a side-by-side, flash, highlight
   and spotlight view of each. You accept, reject (with a reason) or exclude each item.
3. **Finish.** One button applies your decisions: the accepted PNGs and a review record are
   committed and pushed to the pull request's branch, and the rejects are posted as one comment.
   CI captures again, and the accepted items now read `unchanged`.
4. **Gate (CI).** The "Visual gate" job fails while a pull request holds a difference nobody
   accepted, or a baseline file changed without a review record naming it.

Every story needs a baseline you approved before a pull request can merge. A story with no
baseline blocks every pull request until you accept it, either on a pull request or by seeding it
from the default branch, so seed a project's baselines before its stories start blocking work.

## Requirements

- **A git repository on GitHub, with GitHub Actions.** The review page talks to GitHub through
  the [`gh` CLI](https://cli.github.com), logged in (`gh auth login`) as someone who can push to
  the repository's branches.
- **Node.js 20 or newer**, locally and in CI.
- **Storybook 7 or newer**, built as a static site (`storybook build`), which writes the
  `index.json` the capture reads.
- **Playwright**, a peer dependency: install it next to this package. `visual-review
install-browser` installs the Chromium that version of Playwright drives.
- **git-lfs**, on every machine that accepts baselines or pushes a branch holding them. GitHub's
  runners have it. Install it with your package manager (`brew install git-lfs`,
  `sudo apt-get install git-lfs`), or without root put the `git-lfs` binary from
  https://github.com/git-lfs/git-lfs/releases on your `PATH`; then run `git lfs install` once,
  and `git lfs pull` in every checkout that already existed.
- **jq** on the runners, which GitHub's Ubuntu runners have.

## Install and set up

```bash
npm install --save-dev @graphty/visual-review playwright
npx visual-review init
```

(`pnpm add -D` and `yarn add -D` work the same way; `init` notices the lockfile and writes
workflows for that package manager.)

`init` writes, at the root of your repository, and never overwrites a file you already have:

| File                                  | What it is                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `visual-review.config.json`           | Your Storybooks and your repository's settings ([Configuration](#configuration))         |
| `.gitattributes`                      | `visual-baselines/**/*.png filter=lfs diff=lfs merge=lfs -text`: baselines go to Git LFS |
| `.gitignore`                          | `/.visual-review/`, where the review page downloads captures and keeps its state         |
| `.github/workflows/visual-review.yml` | Captures every pull request and push, and gates pull requests                            |
| `.github/workflows/visual-seed.yml`   | Captures an older commit on demand, to seed baselines from                               |

Then:

1. Edit `visual-review.config.json`: one entry under `projects` per Storybook, with the directory
   its build writes and the command that builds it.
2. Commit everything and open a pull request. Its "Visual review" run captures every story; with
   no baselines yet, nothing blocks.
3. Make **Visual gate** a required status check (Settings, then Branches or Rulesets).
4. Merge, then seed your first baselines ([below](#your-first-review-seeding-baselines)).

`visual-review init --force` rewrites the two workflows when they still start with the line
`init` writes ("Generated by visual-review init"), to pick up a newer template after an upgrade.
It never replaces the config or a workflow you wrote yourself.

Every command has `--help`; `visual-review --help` lists them.

## Configuration

`visual-review.config.json` sits at the root of the repository. Only `projects` is required.

```json
{
    "defaultBranch": "main",
    "workflow": "visual-review.yml",
    "baselines": "visual-baselines",
    "workDir": ".visual-review",
    "commitPrefix": "test",
    "issueLabels": ["bug"],
    "projects": {
        "web": {
            "storybook": "packages/web/storybook-static",
            "build": "npm run build-storybook --workspace packages/web",
            "workers": 4
        },
        "charts": {
            "storybook": "packages/charts/storybook-static",
            "build": "npm run build-storybook --workspace packages/charts",
            "seedFromDefaultBranch": false,
            "waitFor": { "selector": "my-chart", "method": "whenRendered", "failOnConsole": "render timeout" }
        }
    }
}
```

| Key             | Default             | Meaning                                                                                                             |
| --------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `defaultBranch` | `main`              | The branch baselines are seeded from and pull requests merge into                                                   |
| `workflow`      | `visual-review.yml` | The workflow file whose runs hold the captures; the review page looks runs up by it                                 |
| `baselines`     | `visual-baselines`  | Where baselines live: `<baselines>/<project>/<story id>[.<mode>].png`, and review records in `<baselines>/reviews/` |
| `workDir`       | `.visual-review`    | Where `serve` downloads captures and keeps its decisions and session token; keep it out of git                      |
| `commitPrefix`  | `test`              | The conventional-commit type and scope of the commits Finish makes, e.g. `test(ui)`                                 |
| `issueLabels`   | `["bug"]`           | Labels of the issue Finish opens for rejects on the default branch; each must exist                                 |
| `projects`      | (required)          | One entry per Storybook; the id names its baselines directory, CI job and artifact                                  |

Per project:

| Key                     | Default    | Meaning                                                                                                                                                                                                                                        |
| ----------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storybook`             | (required) | The built Storybook's directory, relative to the repository root                                                                                                                                                                               |
| `build`                 | none       | The shell command CI runs to build it (from the repository root)                                                                                                                                                                               |
| `workers`               | `4`        | How many browsers capture in parallel                                                                                                                                                                                                          |
| `seedFromDefaultBranch` | `true`     | `false`: the project's first baselines are accepted on a pull request, not seeded from the default branch                                                                                                                                      |
| `waitFor`               | none       | After a story renders, call `method()` on every element matching `selector` and wait for the promise it returns, for a component that keeps drawing after Storybook says it is done. A console line containing `failOnConsole` fails the story |

Project ids are lowercase letters, digits and `-` (results.json allows no others), and so are
the names of Chromatic modes, which a capture refuses before it starts. Every project is gated;
there is no setting that turns the gate off, and a config that sets `gate` is refused. The pull
request gate reads the config as it is on the base branch, so a pull request cannot move
`baselines` out from under it or drop a project from the gate; a project that a pull request adds
to its own config is gated too.

## The GitHub Actions workflows

**`visual-review.yml`** runs on every pull request and every push to the default branch:

- **Plan** reads the projects from the config.
- **visual (&lt;project&gt;)**, one job per project: fetches that project's baselines from Git LFS
  (cached), installs your dependencies, installs Chromium, runs the project's `build`, downloads
  the default branch's newest capture as a reference (on pull requests), captures, and uploads
  the artifact `visual-<project>-<attempt>` (kept 30 days). It never fails because of a
  difference; `continue-on-error` keeps even a crash of the tool from failing the run.
- **Visual gate** (pull requests only) downloads every capture of the run and runs
  `visual-review gate` at the version `init` pinned, with `npx`, so a pull request's own
  dependencies cannot change it. It passes `--pr` with the pull request's number, which the
  passkey check needs (see [Approving with a passkey](#approving-with-a-passkey)). Make it a
  required check.

The review page finds captures by the workflow's file name (the config's `workflow`), the jobs by
their names, `visual (<project>)`, and the artifacts by `visual-<project>-<attempt>`. If you would
rather capture inside an existing CI workflow (to reuse a Storybook your build job already made),
copy the `visual` job and the gate's steps into it, keep those names, and set `workflow` to that
file.

**`visual-seed.yml`** is started by hand to capture an older commit with the default branch's
tool: `gh workflow run visual-seed.yml --ref main -f ref=<sha>`. It captures every project seeded
from the default branch; add `-f projects="web charts"` to capture only those. Each project is
built and captured on its own, so one whose Storybook does not build at that commit fails alone.
See [Seeding](#seeding-one-story-at-a-time).

Both need nothing but the default `GITHUB_TOKEN`: the capture job reads Actions artifacts
(`actions: read`); nothing in CI writes to the repository.

## Your first review: seeding baselines

A project has no baselines until you accept some, and the gate fails closed until it has them:
every pull request is blocked by each of its stories (`new` or `no baseline yet`), with a message
saying to seed the project. After the setup pull request merges, the default branch's push runs
the capture:

1. Find that run's id: `gh run list --workflow visual-review.yml --branch main --limit 1`.
2. Start the page with `--master-run <run id>` ([Opening the review page](#opening-the-review-page))
   and open `<branch> seed` (for example "main seed"). Every story is `new` there.
3. Accept what looks right, reject what does not (with a reason), leave the rest, and press
   Finish. You get a pull request `visual/seed-<date>` holding the accepted baselines, and one
   issue listing the rejects.
4. Merge the seed pull request once its own run shows its accepted items `unchanged`. From then
   on, every pull request that changes how a seeded story looks is blocked until you accept it.

## Opening the review page

```bash
PORT=4800 npx visual-review serve
```

It prints the address to open, with a session token after `#token=`; open that exact URL. The
token is kept in the work directory, so the URL stays valid across restarts; delete
`<workDir>/state/token` to issue a new one. Without the token the page shows "No session token".

- Without a certificate it serves plain HTTP, and only on `localhost` (`HOST` defaults to it).
  To open the page from another device (an iPad, say), serve HTTPS: set `HOST` to the machine's
  name and `HTTPS_CERT_PATH` and `HTTPS_KEY_PATH` to a certificate and key for it.
- `serve` refuses to start without git-lfs: an accept would commit raw PNGs.
- `--master-run <run id>` also lists the default branch at that run, for seeding.
- `--results <dir>` serves local captures offline (a directory of `<project>/results.json`), for
  looking at a story before a pull request exists. It is listed as "Local preview" and is look
  only: no Accept, Reject or Exclude, and no Finish. Only CI captures of a pushed commit are
  decided.

### Links to a screen

The address always names the screen you are on, after the token: the targets list; a pull
request (or the default branch's seed) and project with the grid's filter and Find text; or one
story with its pass, view, zoom, outline, blink and Spotlight flash, for example
`#token=...&target=123&project=web&filter=undecided&item=button--primary.dark.png&pass=undecided&view=flash&zoom=2&box=on&blink=off&flash=off`.
A link's `box`, `blink` and `flash` apply to the page it opens; the choice this browser remembers
for B, L and F in Spotlight is left as it was. Flash, Blink and Spotlight flash open stopped from
a link; the first press of F, L or the button starts them.
Opening that address, in another tab or on another device, opens the same screen. **Copy link**
at the top right copies it. The link carries your session token, so it works on your iPad the way
the printed URL does; keep it to yourself as you would that URL. All of it sits after `#`, which a
browser never sends to any server or in a Referer, so the page never hands the token to another
site. Back and Forward move between the targets list, a grid and a story, at once: they read the
server's cached list and never wait on GitHub. Moving between stories or views of one grid
updates the address in place. A reload of a story reopens the same pass at the same place (the
pass is kept in the tab's session storage; a link opened in a new tab rebuilds it from its
filter).

A link to something that is gone opens the nearest screen that still exists, and the status row
says why: a story not in the newest CI run opens its grid, and a pull request no longer listed
(closed, or no CI run) opens the targets list.

Finish's commit is signed by the git configuration of the process that runs the server. If
someone else started it for you (an agent, a service manager), the commit carries their
identity: the page names the key that will sign before every Finish and prints the command that
starts the same server from your own shell.

## The screens

Every screen has the same frame. The header holds **Visual review** (the targets list), the
**Target** and **Project** menus (on the grid and story screens: jump to any pull request or
project, each with its count of undecided items), **Finish** with the number of decisions it
would publish ("Finish #201 (12)"; at 0 it is unavailable and says "Nothing new to finish",
shortened to "Nothing new" on an iPad; whether a passkey must approve it is said in Finish's
sheet), **Keys** and **Copy link**. Finish never shrinks: on a narrow window the
menus give up their width first. Under the header is the screen's own bar, then the status row: the one
place the page writes messages, one line tall on a wide screen and two on an iPad, so a message
never moves anything; a longer one shows **More**, which opens the row to its full length.
Errors are shown there in red. **Keys** (or `?`) lists every key, the last
20 messages in full, and a switch that turns the single-letter keys off.

No wait is silent: anything that takes longer than a third of a second says what it is waiting
for, with a count or the time spent, and a failed one offers Retry. A wait that keeps you from
working (the first list after the server starts, opening a project, a project whose captures are
still downloading, Finish) is a box in the middle of the screen, over the page: what it waits for,
its progress ("1 of 2 artifacts, 41 MB of 120 MB"), the time spent, GitHub's network retries
("GitHub did not answer (Could not resolve host: api.github.com). Trying again in 4 s, try 2 of
4."), and **Cancel** where there is something to go back to. A wait that fails becomes the error
in the same box, with **Retry**. Work in the background (checking GitHub for new CI runs,
downloading captures nobody has opened yet) is said in the status row and never blocks.

1. **Targets.** Each open pull request with a run of the capturing workflow, and the default
   branch (shown as `<branch> seed`, for example "master seed") when started with
   `--master-run`. The list is the server's, shown at once with "Updated 40 s ago" and
   **Refresh**; it is checked again with GitHub when you press Refresh or when it is over a minute
   old, and the server checks every two minutes on its own, downloading the captures of every CI
   run that finished, so they are there before you open them. The status row shows a check's step
   ("Checking GitHub for new CI runs", then "Finding CI runs: 3 of 5, 12 s"). The server keeps the
   list on disk, so after a restart it shows at once and is checked behind; only the very first
   start waits for GitHub, in the box. Above the cards, one line says whether Finish is approved with your passkey ("Finish is
   approved with your passkey (iPad passkey, 2026-10-01), and the CI gate refuses accepts
   without it."), or that accepts are not yet protected ("No passkey registered: accepts are not
   yet protected. ..."), with **Register passkey**, or **Register another device** once one is
   registered ([the passkey](#approving-with-a-passkey)); a problem reading
   `visual-review/passkeys.json` is named there too. Each card says which commit and CI run it captured, any warning the server
   has (with Retry), how many decisions are not yet finished, how many an earlier Finish already
   put on the branch ("Finished: 266 decisions already on the branch, waiting for the next CI
   run, which no longer shows them."), and a table per project: **Project**,
   **Results** (count per status), **Decided** ("12 of 40") and **Review**. Projects with nothing
   to review are one line ("3 projects unchanged: ..."). Badges:
    - **merge master first**: the default branch has newer baselines for this project than the
      pull request. **Update from master** beside it merges the default branch into the pull
      request's branch for you ([Updating from the default branch](#updating-from-the-default-branch)).
    - **Downloading...**: the captures are still downloading from GitHub. The card says how many
      artifacts and bytes have landed and for how long ("Downloading: 2 of 5 artifacts, 41 MB of
      120 MB, 14 s"), and each row fills in by itself as its own download lands. Pressing it
      opens the project as soon as it lands: its download goes ahead of the others, and the box
      shows its progress.
    - **capture failed**, **CI still running**, **waiting for CI**: there is nothing to review
      yet. **Job log** opens the capturing job; **Retry** checks GitHub again.
    - **artifact expired**: GitHub deleted the capture after 30 days and it was never
      downloaded here. Re-run the `visual` job.
    - **incomplete: N of M stories**: the capture stopped part way. Re-run the job.
    - **Reject only here: accept on a pull request**: this project is not reviewed on the default
      branch (`"seedFromDefaultBranch": false` in the config); its first baselines are accepted on
      a pull request.
2. **Grid.** When the default branch has newer baselines for the project than the capture was
   compared with, the grid starts with "master has 3 newer compact-mantine baselines since this
   capture; this review is out of date", the changed files under **Changed on master**, and
   **Update from master and recapture**. A bar that stays at the top: "18 of 170 decided"; **Review 152 undecided**, the main
   way in, which opens the first undecided item and walks every undecided item; **Needs a
   decision** and **All**, each counted, and **More filters** (each status, and what you
   **Accepted**, **Rejected** and **Excluded**, each counted); **Find story**; **Accept all
   undecided (N)**; and **More**, with **Undo all decisions...** and **Copy link to this grid**.
   Failed captures come first as one line, "6 failed captures: only Exclude applies"; opened (the
   page remembers), it lists each with its reason and, under "console and stack", the story's
   console output and the thrown error's stack (a play function's failed `expect` included). An
   error is never accepted: fix the story, re-run the `visual` job for a one-off timeout, or
   exclude it with a reason. Below it the items are grouped by component (the story id before
   `--`), in the order failed, changed, moved, new, unstable, removed, no baseline yet; each
   story's modes (light, dark) sit side by side under its name. Every item has a number that
   stays the same however the grid is filtered or decided (its place under All), and the story
   screen shows it too. Tiles show small copies the server makes once, loaded as they come near
   the screen; one that fails reads "Failed -- tap to retry". A component's **Accept N** accepts
   its undecided items without opening them, and **Undo N** clears its decisions; both ask first,
   naming the count. Under every decided tile its decision is spelled out: "Accepted",
   "Accepted (not opened)" for one Accept all took, or "Rejected" or "Excluded" with the reason,
   with an **Undo** that clears it without opening the story. A reject an earlier Finish already
   posted says "Posted by an earlier Finish: it stays.", and an accept or exclusion it pushed says
   "Finished: it is on the branch, and the next CI run no longer shows it."; neither has an Undo. Many Undos at once show
   their progress, with Stop. **Find story** narrows the grid as you type; Enter opens the first
   match, or the item with that number. Coming back from a story, its tile is outlined and
   scrolled into view.
3. **Story.** One item, on one screen that never scrolls (only the panes do). From the top:
    - **The decision bar**: **Grid** (Escape), **Prev** (K), "12 of 230 -- 18 left" (in this
      pass), **Next** (J), **Accept** (A), **Reject** (R), **Exclude** (E), **Undo** (U) and the
      **Note** box ("Needed to Reject or Exclude"; a note typed before Accept is published with
      it). Below 1280 px it is two rows, the decisions, then the movement and the note; on an
      iPad held upright and below 900 px (Split View, a zoomed page) three, the note on a row of
      its own, and the bar never runs past the window's edge. While the images load, Accept shows a
      small spinner at its left edge; its label and key stay whole. Every button is always there, in the same place on every item, at every zoom; one
      that does not apply is shown unavailable, the line under it says why, and pressing it says
      why in the status row. Each button shows its key.
    - **The item line**: the item's number, name, status and badges (**moved from ...**, its
      decision, **size changed**, **flaky**, **re-review** when an accept you made was replaced by
      the default branch's newer baseline), then one explanation: what changed ("880 pixels
      changed, in a 40 x 40 area at (160, 80). Threshold 0.063."), what a decision will do
      ("Removed from the Storybook: Accept deletes its baseline."), or why one does not apply.
      Tap it to read all of a long line.
    - **The view bar**: **Side by side**, **Flash** (F), **Highlight** (H), **Spotlight** (S);
      **Blink** (L) while Highlight is on and **Spotlight flash** (F) while Spotlight is on;
      **Outline** (B); **Next change** (N) with "1 of 3"; the zoom, **Fit**, **1x**, **2x**,
      **4x**, **8x** (Z cycles it); and **Details** (the threshold, the anti-aliasing setting, the
      capture's scale, and any console output). Below 1280 pixels wide (an iPad either way up) it
      is always two rows, the views on the first, so the zoom is always on screen and the panes
      start at the same height on every item and in every view.
    - **The two panes**, the baseline on the left and the new capture on the right, filling the
      rest of the window. Both are drawn at once with "Loading baseline..." and "Loading new
      image..." in them, so nothing moves when the images arrive; Accept shows a spinner until
      they have. The next two items load in the background. A load that fails says so in its pane,
      with Retry.

    Images open at **Fit**: both whole images fit their panes, across and down, at one scale
    (never above real size), so two captures of the same size line up pixel for pixel and nothing
    scrolls. With no baseline (a new story, or "no baseline yet") the left pane stays as an empty
    frame labeled "No baseline", so the new image sits exactly where it would beside one; a
    removed story leaves the right pane empty the same way, and a failed one shows its log there.
    **1x** is one CSS pixel of the page for each CSS pixel the story was drawn at (a capture holds
    two image pixels per CSS pixel). **2x**, **4x** and **8x** enlarge it; from 4x pixels are
    drawn as hard squares. Zoomed, the images grow past their panes, which scroll: scrolling one
    scrolls the other to the same place, and **Fit** returns to the whole image. (On an iPad,
    pinching zooms the whole page; use the zoom buttons to zoom the images. Held upright, each
    pane is small: **2x** or Spotlight shows a fine change large.) **Next change** scrolls both
    panes until the next region of changed pixels is in view and outlines it; **Outline** turns
    that purple outline on and off, remembered in this browser. The views, each shown in the right
    pane at the same scale and place: **Side by side**; **Flash**, which shows baseline and new one
    after the other in the same place, about 1.5 times a second (the images themselves, not an
    overlay), keeping the zoom and scroll it was opened at; **Highlight**, the changed pixels in
    solid red laid over both images themselves, in both panes, where **Blink** flashes the red
    pixels on and off at Flash's pace (remembered in this browser); and **Spotlight**, the new
    image dimmed everywhere except around the changed pixels (each grown by 10 image pixels),
    which finds a one-pixel change, where **Spotlight flash** shows the spotlighted baseline and
    the spotlighted new image one after the other at Flash's pace, the pane's label saying which
    (remembered in this browser). Flash, Highlight and Spotlight need two images; on a new or
    removed story pressing them says so.

    **Next** and **Prev** (J and K) walk one pass: the items the grid showed when you opened
    the story (or every undecided item, from **Review N undecided**), in the grid's order, frozen
    until you go back to the grid. Deciding an item never drops it from the pass: the decision
    moves on to the next item, and **Prev** comes back to the one just decided, showing its
    decision pressed and its **Undo**. Going back to the grid shows what its filter now selects.

    **The end of a pass.** Next on the last item, or deciding it, does not wrap to the first: it
    shows what is next in place of the panes. "End of graphty-element: 164 of 170 decided, 6
    undecided." **Next project: layout (42 undecided)** comes first (focused, so Enter takes it)
    and opens that project's first undecided item, with no wait for GitHub. **Review the 6
    undecided** walks the ones left here, and comes first when no other project has any; when
    every one left can only be excluded (unstable or failed) it says so: "Review the 6 undecided
    (Exclude only)". Then **Back to the grid** and **Finish #201 (12)**. A project still downloading is listed under them ("layout: downloading
    (2 of 5 projects done)"). When every project of the target is decided it says so, offers
    **Finish** first, and **Next: #202 (340 undecided)**, the next pull request with something to
    review. K comes back to the last item.

Statuses: `changed` (differs from its baseline), `moved` (a renamed story that looks exactly as
its old id's baseline; see [renames](#reorganizing-stories-renames)), `new` (no baseline, and on a pull request the
story is new or looks different from the default branch's newest capture of it), `no baseline yet` (status
`unseeded`: no baseline, and the pull request does not change it), `removed` (a baseline whose
story no longer exists, lost a mode, or whose story's own parameters now exclude it), `unstable`
(two captures of the same commit differed), `failed` (did not render, even after one retry).

`no baseline yet` items block the pull request like `new` ones: they count as needing a decision,
Accept all includes them, and the story screen offers Accept, Reject and Exclude for them. Accepting
one makes its capture the story's first baseline. The grid also lists them under their own filter.
Seed them from the default branch (below), or accept them on the pull request.

## Keys

Keys work on the screen named, never while a question, Finish's sheet or the key list is open,
and never in a text box except where listed. **Keys** (or `?`) shows this list, and can turn the
single-letter keys off. The list opens with focus on itself, so a key pressed as it opens changes
nothing. Turning the letters off says so in the status row, and so does every letter typed while
they are off (the switch is remembered in this browser). On a touch screen every control is at
least 44 px tall.

| Key              | Action                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------- |
| J / K            | Next / previous item of this pass; J on the last item shows what is next                      |
| A                | Accept, once the images are shown                                                             |
| (type), Esc, A   | Accept with a note: type it in the note box, leave the box, accept                            |
| R                | Reject; with an empty note box, type the reason, then Enter                                   |
| E                | Exclude; with an empty note box, type the reason, then Enter, then confirm                    |
| U                | Undo the item's decision; you stay on the item                                                |
| Enter (note box) | Send the Reject or Exclude waiting for its reason; otherwise just leave the box               |
| F                | Flash between baseline and new; F again returns to side by side                               |
| F                | In Spotlight: flash the spotlighted baseline and new, or stop flashing                        |
| Space (hold)     | Flash while held                                                                              |
| H                | Highlight changed pixels; H again returns to side by side                                     |
| L                | In Highlight: blink the red changed pixels, or hold them on                                   |
| S                | Spotlight the changes; S again returns to side by side                                        |
| B                | Outline the changed area, or stop outlining it                                                |
| N                | Next change                                                                                   |
| Z                | Next zoom: Fit, 1x, 2x, 4x, 8x, then Fit again                                                |
| Shift+A          | Grid: accept every undecided item of this project without opening it (asks first)             |
| /                | Grid: Find story                                                                              |
| Enter (end card) | Take the first offer: the next project, the undecided items left here, or Finish              |
| ?                | Show or hide the key list                                                                     |
| Escape           | Story: back to the grid; in the note box, first leaves the box (its text stays with the item) |

No key reverses a decision. A, R and E on an item that is already decided say "Already accepted.
Undo it to change it."; press U (or Undo) first. A held A, R, E or U decides once, and an A, R or
E that comes within a quarter second of an item's images appearing is ignored and says so, so the
second tap of a double tap never decides the next item unseen. While a decision is being saved
the page says "Saving the last decision..." and waits for it before moving on; a save that fails
leaves the item undecided, with its note.

Text typed in the note box belongs to the item on screen: it stays with that item while you move
away and back, and it is cleared when that item's decision is saved. Undo puts a decision's note
back in the box, so undoing to fix a typo does not lose it. After any decision, focus
leaves the note box, so the next A accepts instead of typing an "a".

## What each decision does

- **Accept**: the new screenshot becomes the baseline (or, for `removed`, the baseline is
  deleted). Allowed on `changed`, `moved`, `new`, `no baseline yet` and `removed`. For a renamed
  story the baseline is written under the new id and the old id's baseline is deleted, in the
  same commit. A note typed with it is optional; Finish publishes it.
- **Reject**: the difference is a regression. It always needs a reason, which is posted to the pull
  request as a comment with a machine-readable block an agent can read. The pull request stays
  blocked until its code changes so the capture matches the baseline again.
- **Exclude**: stops capturing the story. It needs a reason and writes
  `<baselines>/<project>/<story id>.json` with `disableSnapshot: true`. It drops **every mode
  of the story**, on every later pull request, until that file is deleted. It is the only
  decision for `unstable` and `failed` items; for a one-off `failed` item (a timeout on a busy
  runner), re-run the `visual` job instead, since the newest attempt replaces the old results.
- **Undo** (U, or a tile's Undo on the grid) clears a decision before Finish; it is the only way
  to change one. The grid also undoes a whole component (**Undo N**) or project (**More > Undo
  all decisions...**), after asking. Decisions are kept across server restarts. A decision
  applies only to the image it was taken on: when a new run or a re-run attempt captures that
  item differently, it is undecided again (the old decision stays saved, and comes back if the
  image does).
- After Finish, what it published stays shown, marked as published, and Finish does not publish
  it twice. Accepts and exclusions read "Finished" and count as decided until a new CI run
  replaces the capture (the accepted items are then `unchanged`, the excluded ones not captured);
  rejects still show as rejected on the next CI run while the capture is unchanged. They live in the work directory's `state/` (the config's `workDir`), not in the
  repository.

## Finish

Finish applies every decision on one target, across all its projects, at once:

- **A pull request:** one commit holding the accepted PNGs, the exclusion files and one review
  record in `<baselines>/reviews/`, pushed to the pull request's branch, plus one comment
  holding every reject and every accept note (the machine-readable block holds the rejects
  only). CI then recaptures, and the accepted items read `unchanged`.
- **Your passkey first, once one is known** (see [Approving with a passkey](#approving-with-a-passkey)):
  the Finish sheet says "Your passkey confirms this Finish (Face ID or a security key)." and its
  final button reads **Sign and finish #201**. Pressing it opens the Face ID (or Touch ID)
  prompt at once; your device signs the record, and Finish commits exactly that record, as
  version 2 with the approval in it. The comment names the committed record and its commit. A
  rejects-only Finish commits nothing, so the comment's machine-readable block carries the
  approved record itself. Cancelling the prompt changes nothing: the sheet comes back saying
  "Passkey cancelled: nothing was changed." with its final button focused, so Enter tries again.
- **Before a passkey is registered, accepts are not yet protected.** Finish commits them with an
  unapproved (version 1) record, and both the targets screen ("No passkey registered: accepts
  are not yet protected.") and the Finish sheet ("Not yet protected: ...") say so. Rejects never
  wait for a passkey to be registered.
- **Approvals from before the passkey.** Once a key is on the default branch, the gate counts
  those version 1 records for nothing, but the images they accepted are already on the branch, so
  the page finds nothing to decide. Finish still offers them: its button counts the files those
  records accepted that no signed record covers, and the sheet says `Sign again N files approved
before passkeys, and remove N unsigned review records from <branch>`. Your passkey signs a
  version 2 record taking each of those files from the default branch's contents to the branch's,
  and the same commit removes the pull request's own unsigned records, which the gate refuses
  while they are there. Only files an unsigned record of this pull request accepted are signed
  this way (images, settings files, removals and renames alike); a change nobody reviewed still
  needs a decision.
- **One commit status**, "Visual review", posted once when Finish completes (never per
  decision), on the commit Finish pushed, or on the captured commit when it pushed none. It
  fails when anything was rejected, is pending while items are left undecided or a project did
  not load, and succeeds otherwise; its description counts the accepts, rejects, exclusions and
  undecided items. It is information for the pull request page, not a required check: the merge
  gate is the "Visual gate" job. If posting it fails, the page says so; what was pushed and
  posted stays, and the next Finish on that pull request posts a new status.
- **The default branch (seeding):** a branch `visual/seed-<date>` with the same commit and a pull
  request from it, whose description lists the accept notes, and one issue holding every reject
  (labeled with the config's `issueLabels`) with the same machine-readable block, for a person
  or an agent to fix the stories. Rejects alone, with nothing accepted, open only the issue.

Pressing Finish opens a sheet that states exactly what will happen, from the server's own
counts: what will be committed and where ("Commit 214 accepts and 1 exclusion to feature."),
what will be posted ("Post 3 rejects and 2 accept notes as a comment on #201."), the status it
will set ("Then set the commit status 'Visual review' to failure (3 rejected)."), how many were
accepted without being opened, what is left undecided or was not loaded, every note it will
publish, and the key that will sign. If any decision changes after the sheet opened (in another
tab, say), Finish refuses, and the sheet comes back with the new summary. Once a passkey is
known, the final button reads **Sign and finish #201**, and pressing it asks for your passkey
(Face ID, Touch ID or a security key) before anything runs; the approval covers the rejects too,
so their reasons are yours. Cancelling it says "Passkey cancelled: nothing was changed." and the
sheet comes back with its final button focused, so Enter tries again. Before a passkey is
registered the sheet says accepts are not yet protected, and a Finish with only rejects never
waits for one.

Finish runs on the server, not in the page. A seed of several hundred images takes minutes,
most of it uploading the images to Git LFS, which is longer than a browser (Safari on an iPad in
particular) keeps one request open. So pressing Finish only starts it, and the targets screen
then lists its steps, each marked done, in progress or waiting, with the count of images
uploaded and the time spent: confirming with your passkey, checking, writing the files,
committing, uploading images to LFS,
pushing, opening the pull request, posting the comment (or opening the issue), and posting the
status. When it ends, the page shows what was pushed and posted, with links, or the error, and
offers **Next: #202 (340 undecided)** and **Back to #201**. Closing or reloading the page does
not stop it: reopen the page and it shows the running Finish instead of a Finish button. Only
one Finish runs at a time, and decisions on that target are refused until it ends.

The commit is signed by whatever git configuration the server process sees: yours when you
started it, someone else's when they (or an agent working for you) started it. The top of the
targets screen and Finish's sheet name the key that will sign, where git found it and the
committer, and print the exact command that starts the same server from your own shell. If
Finish fails, your decisions not yet published are kept and the page shows git's or GitHub's
message:

- **capture is stale, wait for CI**: someone pushed to the branch after the capture. Wait for the
  new CI run, then decide again what still differs.
- **merge master first**: the capture is older than the default branch's baselines. The message
  names the fix, and the result offers **Update from master**
  ([Updating from the default branch](#updating-from-the-default-branch)).
- **failed to write commit object** or a signing error: unlock or plug in the signing key, then
  Finish again.
- **the accepts were pushed ..., but the comment with the rejects failed**: the accepts are done
  and finished; press Finish again to post the rejects. Accept notes that were in that comment are
  not posted again: the message names each one, so you can post them by hand. On a seed it reads
  "the accepts were pushed as ... and opened the seed pull request, but the issue with the
  rejects failed"; the accept notes are already in that pull request's description.
- **The comment with the accept notes was not posted**: the accepts are done; the message names
  the notes, which are not kept.

## Approving with a passkey

A passkey (Face ID or Touch ID, kept in iCloud Keychain or another passkey manager) proves that
an accept came from your own device, for exactly the record Finish commits. Once your passkey is
in `visual-review/passkeys.json` on the default branch, the gate refuses every review record a
pull request adds unless it carries such an approval. Until then the gate enforces nothing.

### Registering the passkey

Do this once, yourself, never through an agent.

1. Start the page from your own shell on the host the passkey is for, over HTTPS, for example
   `https://dev.example.com:9443`. The passkey belongs to that host name (its "rpId"), so serve
   the page from the same host every time; the port may change.
2. On the targets screen press **Register passkey**, then **Create the passkey**, and confirm on
   your device. The key is named by the kind of device that made it and the day ("iPad passkey,
   2026-10-01", or "security key, 2026-10-01"), so every device shows which key is which.
3. The server opens a pull request adding the key to `visual-review/passkeys.json`, and the page
   names the new key's credential id and that pull request. Check that the pull request names the
   same id, then merge it. From that merge on, approvals are enforced.

The first key is trusted because you merged it: the server cannot check that a passkey was made
on a real device (Apple's passkeys give no attestation), so a key added by anything else that
can reach the page would look the same. Merge a key's pull request only right after you pressed
Register yourself and only when the ids match. Until the first key is merged, the server that
registered it already asks for it at Finish. Once the default branch holds a key, the server
trusts only the default branch's keys, never one registered since.

Until it merges, the targets screen reads "Passkey waiting for #650 to merge: Finish asks for it
already, but the CI gate checks approvals only once it is merged." Afterwards it reads "Finish is
approved with your passkey (`<name>`), and the CI gate refuses accepts without it." and offers
**Register another device**. Before any passkey is registered it reads "No passkey registered:
accepts are not yet protected.", and Finish commits accepts unapproved, as before passkeys.

### Finishing with Face ID

Finish asks for your passkey as soon as the server knows of a key. The record is built on the
server first, its SHA-256 is the challenge your device signs, and Finish refuses to commit a
record that differs from the one you approved ("the record changed after you approved it; press
Finish again"). Immediately before committing, Finish checks the approval with the gate's own
code. On a Mac, Touch ID or your login password takes Face ID's place.

### What the gate checks

For each review record a pull request adds, with `node:crypto` alone:

- it is version 2, names this pull request (or none, for a seed), and is not a copy of a record
  already on the base branch;
- its approval is by a key in `visual-review/passkeys.json` as the base branch has it, over the
  SHA-256 of exactly this record, made on an HTTPS page whose host is exactly the key's host,
  with user verification (Face ID, Touch ID or the device's passcode).

A record that fails counts for nothing. Then every changed baseline PNG, every added or changed
settings file and any change to `visual-review/passkeys.json` must be accounted for: the records'
items, oldest first, must take the file from its contents on the base branch to its contents in
the pull request. A record approved for other contents (an old seed, or a decision you replaced
later in the same pull request) therefore moves nothing. Records already on the base branch are
never checked again, so baselines accepted before the passkey are kept as they are.

### Replacing the passkey

An iCloud Keychain passkey is on every device signed in to your Apple account, so a lost device
loses nothing. Once the default branch holds a key, the gate fails any pull request that changes
`visual-review/passkeys.json`, so no pull request can swap in another key. To add or replace one
anyway (another passkey manager, another host, a lost Apple account), register it on the page;
the pull request it opens says the gate fails it. Check the credential id, and merge it as an
administrator past the failing check. Removing every key is refused the same way.

`visual-review/passkeys.json` sits at that path in every repository that uses this tool. It
holds public keys only: `{ "version": 1, "keys": [{ "id", "publicKey", "rpId", "label",
"registeredAt" }] }`, with the public key as base64url SubjectPublicKeyInfo (P-256).

## Updating from the default branch

A capture compares a pull request's stories with the baselines on its own branch. When the
default branch accepts newer baselines for the same project afterwards (another pull request's
Finish merged), the capture is out of date, and Finish refuses it: committing decisions made
against old baselines could overwrite the newer ones. A pull request whose branch and the default
branch changed the same baseline PNGs cannot merge at all. Both are fixed the same way, from the
page or a terminal:

- **On the page:** **Update from master** on the targets screen (beside "merge master first"), at
  the top of the project's grid, or in a Finish that refused. It asks first, then runs on the
  server like Finish, with its steps in the box.
- **In a terminal:** `npx visual-review update <pull request number>`.

Either way it fetches the default branch and the pull request's branch, merges the default
branch into the branch with a merge commit (never a rebase, so an accept commit stays as it was
made), and for every conflicting file under the baselines directory takes the default branch's
side. The commit names those files, and is signed as your git configuration signs. It pushes to
the branch, and CI captures again. A conflict anywhere else refuses: it lists the files, and
nothing is committed or pushed; merge that by hand.

It accepts nothing and writes no review record. The default branch's baselines are already
approved, and a file that ends up as it is on the default branch is no change for the gate, which
compares the pull request with its base. Whatever the pull request's capture still shows
differently from them comes back as `changed`, for you to review. Your decisions carry over: one
whose story's capture and baseline are both unchanged in the new capture applies again, and only
the stories that now differ come back undecided.

## Seeding: one story at a time

A story does not have to look right the first time, and nothing has to be seeded in one pass.
Seeding is per story:

1. The review workflow captures every story on every push to the default branch. Start the
   server with `--master-run <run id>` (that workflow's newest run on the default branch) and open
   `<branch> seed` (for example "main seed"). Every story without a baseline is `new` there.
2. **Accept** the stories that look right. **Reject** the ones that do not, with a reason saying
   what is wrong. **Leave the rest** undecided; they simply stay without a baseline. Exclude only
   stories that are unstable. Press Finish: the accepts become the seed pull request, and the
   rejects become one issue whose machine-readable block says what to fix.
3. Merge the seed pull request once its own capture shows its accepted items `unchanged`.

To seed from an older, known-good commit instead of the newest, capture it with the default
branch's tool: `gh workflow run visual-seed.yml --ref <default branch> -f ref=<sha>`, then start
the server with `--master-run <that run's id>`. It is listed as `<branch> seed` (for example "main seed"); its results.json
names the captured commit, so Finish's seed branch starts from that commit.

A story with no baseline on the default branch is in the "no baseline yet" state. On every pull
request, CI compares its capture with the default branch's newest capture of that story:

- **The pull request does not change it:** `no baseline yet` (`unseeded`).
- **The pull request adds the story, or changes how it looks** (for example an agent fixing a
  story you rejected): `new`.

Both block the pull request until you decide. Review them there; accepting one creates its first
baseline in that pull request's accept commit. Seeding never restarts from scratch: each round
accepts what now looks right, and every story still without a baseline keeps blocking pull
requests until it is accepted or seeded.

The same holds for a project with no baselines at all: the gate fails closed. Every project in the
config is gated from the start, so every pull request is blocked by the stories of an unseeded
project, and the gate's message says how to unblock it: seed the project (capture a known-good
commit with `visual-seed.yml`, or take the default branch's newest run, review it with
`serve --master-run <run id>`, merge the seed pull request, then merge the default branch into the
blocked one), or accept the items on that pull request. A project with
`"seedFromDefaultBranch": false` is told to accept them on the pull request. Seed only from a commit
whose images a person already reviewed.

If the default branch's capture could not be downloaded (its artifacts expired, or no run there has
finished one), every story without a baseline is `new` on that pull request. Re-run its `visual` job
once the default branch's run has finished.

## Iterating on a story before a pull request exists

To try a story's look quickly, capture it locally and look at it, as a PNG or in the page:

```bash
npx visual-review install-browser        # once per machine
npm run build-storybook                  # your project's build command
npx visual-review capture --project web --out .visual-review/preview/web --stories button--,badge--
```

`--stories` captures only the story ids that start with one of the given prefixes, in seconds
rather than minutes, and then reports no baseline as removed. Start the server with
`--results .visual-review/preview` to see the capture beside its baseline. Capture and look again
after each change. A local preview is look only: its fonts and graphics stack are not CI's, so
only a CI capture of a pushed commit becomes a baseline. Push, let CI capture, and accept it on
the pull request.

## How captures and baselines move

- **What a capture is.** Each story and mode is opened in a 1200 x 900 viewport at device scale
  factor 2, as Chromatic captures, so a PNG holds two image pixels per CSS pixel. It is always
  the whole canvas, in every project: the full page of the story iframe,
  which is the whole viewport, or everything a scroll would reach when the story is taller or
  wider. It is never cropped to the content, so a small component sits in the full canvas and
  every capture of a project has the same size unless its story overflows. results.json records the scale as `scale`, and each review record
  copies it into its `subject`.
- **Why captures rasterize on the CPU.** Chromium runs with `--disable-gpu-rasterization`, so the
  page's text and shapes are drawn by the CPU; WebGL still runs on SwiftShader. Drawn through
  SwiftShader, a glyph that sat on a sub-pixel boundary landed on either side of it from one
  render to the next (a quarter-pixel shift of one letter, in 1 to 7 of 48 renders of the same
  story), so stories with nothing moving read `unstable`, a different few on each run. With the
  switch, 48 of 48 renders matched. The repository owner chose this on 2026-09-30, knowing it
  changes how text is drawn in every story of every project: a baseline captured before it can
  read `changed` once, and is accepted again.
- **From GitHub Actions to the page.** Each `visual` job uploads `results.json` and the PNGs to
  review as an artifact `visual-<project>-<attempt>`, kept 30 days. The server lists open pull
  requests with `gh`, finds each one's newest run of the capturing workflow, and downloads those
  artifacts with `gh run download` into the work directory. It downloads nothing from Git LFS: the baselines a
  capture was compared with travel inside the artifact.
- **What an accept does.** Finish writes the accepted PNGs (as LFS pointers, uploading the images
  with `git lfs push`) and one review record in a throwaway worktree at the captured head,
  commits, and pushes to the pull request's branch. CI then runs again on that branch.
- **Nothing restarts from scratch.** Every push captures again and compares with the baselines
  the branch holds now, so after an accept the accepted items read `unchanged` and only what is
  still undecided shows. Decisions you made but did not Finish are kept for every item whose
  capture and baseline both have the same hash as when you decided it.

## Story parameters

Capture reads each story's `parameters.chromatic`, the same keys Chromatic reads, so stories
written for Chromatic work unchanged:

| Parameter                       | Effect                                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `disableSnapshot: true`         | The story is not captured (a baseline it still has is reported `removed`)                                                  |
| `diffThreshold`                 | pixelmatch's per-pixel color threshold, 0 to 1 (default 0.063); the gate fails a story above 0.8                           |
| `diffIncludeAntiAliasing: true` | Count anti-aliased pixels as changes                                                                                       |
| `delay`                         | Milliseconds to wait after the render before the screenshot                                                                |
| `modes`                         | `{ "<name>": { <Storybook globals> } }`: one capture per mode, named `<story id>.<name>.png`; `disable: true` drops a mode |

Inside a story, `isChromatic()` from `chromatic/isChromatic` is true during capture (the URL carries
`chromatic=true`). A settings file `<baselines>/<project>/<story id>.json` overrides the story's
parameters; the page's Exclude writes one with `disableSnapshot: true` and your reason. A
pull request that adds or changes a settings file needs a review record for it, like a baseline,
so set the other keys in the story's parameters, where code review sees them.

## Reorganizing stories: renames

Storybook derives a story's id from its title, so moving stories in the sidebar (a new `title`,
a new folder) gives every moved story a new id. Without help, each old id's baseline is reported
`removed` and each new id is `new`, with no before and after to compare. A renames file keeps them
paired. Add it in the pull request that moves the stories, at `<baselines>/<project>/renames.json`:

```json
[
    { "from": "building-a-panel-fieldrow--default", "to": "components-panels-and-rows-fieldrow--default" },
    { "from": "compact-theme-mantine-components-badge--dot", "to": "components-display-badge--dot" }
]
```

Each entry is one story: `from` is its old id, `to` its new one. Modes map on their own, so
`<from>.dark.png` is compared with the capture of `<to>` in the dark mode, and `<from>.light.png`
with the light one; a mode the new story no longer has is still reported `removed`.

- **Capture** compares the new id's capture with the old id's baseline. It reads `moved` when the
  two look the same (only the name changed) and `changed` when they differ; either way the item
  carries `from`, and the old baseline is not reported `removed`.
- **The review page** shows each one as a pair, labeled "moved from &lt;old id&gt;" on the tile
  and on the story screen, with the old id's baseline on the left. The grid has a **moved** filter,
  and a component's Accept N undecided takes its moved stories too.
- **Accepting** writes the baseline under the new id and deletes the old id's baseline in the same
  accept commit. For a `moved` item the image is the same, so git sees a rename and the Git LFS
  pointer does not change. The review record names both paths.
- **The gate** blocks a `moved` item until it is accepted, like any change: a pull request that
  moves stories cannot land without their baselines moving with them.
- **A rename whose new id is not a story** in the Storybook is an error: capture reports it as a
  `failed` item under the new id, with the reason, and the page lists it under Errors. Fix the
  entry in `renames.json`. A rename whose old id is still a story is not a move, and does
  nothing.
- **An entry whose move was accepted** does nothing any more: the old baseline is gone and the new
  id has its own. You can delete the file once the pull request has merged, or leave it.

`renames.json` is read from the pull request's own checkout, like the baselines. Only baseline
PNGs move: a settings file (`<old id>.json`) is not renamed; rename it in the same pull request.

## What the gate does and does not guarantee

- A pull request cannot pass the gate while its capture of a gated project holds anything but
  `unchanged` or `excluded` items, including after "Re-run failed jobs" (the
  highest attempt's artifact counts); a missing, unfinished or invalid capture blocks it too. A
  rejected item stays blocking until a code change makes it match the baseline.
- A story with no baseline always blocks. `new` and `no baseline yet` only tell the reviewer
  whether the pull request changed it, measured against the default branch's newest complete
  capture, which may be a few merges older than the pull request's base.
- Every baseline PNG the pull request adds, changes or deletes, and every settings file it adds
  or changes, must be taken from its contents on the base branch to its new contents by the
  review records the pull request adds under `<baselines>/reviews/` (each item names a path, its
  `from` hash and its `to` hash). A baseline PNG is a Git LFS pointer in git, and the gate reads
  the image's hash from the pointer, so it never downloads an image. Existing records may not be
  edited or deleted. This stops the shortcut of copying captured PNGs, or a settings file that
  excludes a story or loosens its comparison, straight into the baselines directory. Deleting a
  settings file and editing `renames.json` need no record: the captures they cause are reviewed.
- A story compared at a `diffThreshold` above 0.8 fails the gate (at 1 nothing ever reads as
  changed), and so does a pull request that moves the baselines directory in its config.
- **Before a passkey is registered, it does not prove a person reviewed anything.** A record is a
  plain JSON file: anyone who can push to the branch can write one that names copied PNGs, and
  the gate cannot tell it from one Finish wrote. Such records are marked `"unproven": true`.
- **Once `visual-review/passkeys.json` on the base branch holds a key**, every record the pull
  request adds must be version 2, name this pull request (or none, for a seed), and carry a
  passkey approval over exactly that record by one of the base branch's keys, made on an HTTPS
  page on the key's host, with user verification (Face ID, Touch ID or a PIN). A record that
  fails, an old-format record, or one copied from another pull request counts for nothing, so
  the baselines it names are reported as unreviewed. Keys are read only from the base branch,
  never from the pull request, and a pull request that would leave no key fails.
- **It does not prove you looked at every image.** It proves your device approved the record,
  which lists every accepted and rejected image by hash. A page altered on your machine could ask
  you to approve something other than what it shows; read the counts in Finish's question.
- **An approved seed that was never merged can be applied by another pull request.** A seed's
  record names no pull request. Copying one already on the base branch fails, and so does one
  whose `from` hashes are no longer the base branch's; but a seed you approved and then abandoned
  without merging still matches, and would apply exactly the images you approved for it. Delete a
  seed branch you do not want, and close its pull request.
- **Only the repository owner should approve.** The page runs on a development machine, where
  anything running as you (an AI coding agent included) has your GitHub login and signing key and
  could press Accept or call the page's API. Before a passkey is registered nothing technical
  prevents that; afterwards an agent can still decide, but cannot produce the approval Face ID
  gives. Tell your agents not to register passkeys or use the page.
- The projects the gate checks are every project in the base branch's config and in the pull
  request's config, seeded or not, plus every project with baselines on the base branch. So
  removing a project from the config does not remove it from the gate.
- In this repository's CI, the gate and the capture run as the base branch has them, never the
  pull request's copy, so a pull request cannot loosen the code that judges it; a change to
  either is first exercised by the pull request after it. The `npx` gate of the workflow `init`
  writes runs a pinned published version, to the same end.
- **The workflow file itself can be edited by the pull request**, which could drop the gate
  step. Closing that needs a check the pull request cannot edit (a ruleset-required workflow).
  The gate prints a warning when a pull request changes `visual-review/passkeys.json`, the tool's
  trusted code or capture, or the workflow that runs it; read those changes in code review.
- A pull request can still loosen a story's own `diffThreshold` (up to 0.8) or `delay` in the
  story's source, and a story's code runs in the capture browser, so it could draw anything.
  Read story changes in code review.
- **Every page on the passkey's host can ask for it.** The rpId is a host name, and every server
  on that host (another dev server, a Storybook on another port) can call the passkey prompt with
  a challenge of its choosing; the prompt names only the host. Approve only from the review page,
  right after pressing Finish. A host that serves nothing but the review page closes this.

## Troubleshooting

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
- **Finish says "capture is stale, wait for CI".** Someone pushed to the branch after the capture.
  Wait for the new run, then decide again what still differs.
- **"merge master first".** The default branch has newer baselines for that project than the
  pull request. Press **Update from master**, or run `visual-review update <pr>`, and wait for CI
  ([Updating from the default branch](#updating-from-the-default-branch)).
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
  passkey](#replacing-the-passkey).
- **The gate says "approval is from a key not in passkeys.json on the base branch".** The record
  was approved with a key that the base branch does not hold yet: merge the pull request that
  registers it first, then review again.
- **The gate says a record has no passkey approval** on a pull request Finished before your
  passkey was registered. Revert its accept commit (which takes the record and the baselines out
  of the diff), let CI capture again, and review it again with Face ID. Never edit a record by
  hand: the gate only accepts what your device approved.
- **Opening the seed issue fails.** Every label in `issueLabels` must exist in the repository.
- **The pnpm setup step fails in CI.** `pnpm/action-setup` reads the pnpm version from the
  `packageManager` field of your root `package.json`; add one.
- **A merge conflict under the baselines directory.** Run `visual-review update <pr>` (or press
  **Update from master**): it takes the default branch's side for every conflicting file there,
  pushes, and CI captures again; review what still differs. It refuses, changing nothing, when
  anything outside the baselines directory conflicts too.
- **Captures differ from what you see locally.** Only CI's captures are compared: fonts and the
  graphics stack differ from machine to machine. Look locally with `capture --stories` and
  `serve --results`, but let CI's capture become the baseline.
