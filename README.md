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
  [decisions](#what-each-decision-does), [Finish](#finish)
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
   and open "master (seed)" (the page calls the default branch's target "master", whatever its
   name). Every story is `new` there.
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
request (or master) and project with the grid's filter and text; or one story with its view,
zoom, changed box, blink and Spotlight flash, for example
`#token=...&target=123&project=web&filter=undecided&item=button--primary.dark.png&view=flash&zoom=2&box=on&blink=off&flash=off`.
A link's `box`, `blink` and `flash` apply to the page it opens; the choice this browser remembers
for B, L and F in Spotlight is left as it was.
Opening that address, in another tab or on another device, opens the same screen. **Copy link**
at the top right copies it. The link carries your session token, so it works on your iPad the way
the printed URL does; keep it to yourself as you would that URL. All of it sits after `#`, which a
browser never sends to any server or in a Referer, so the page never hands the token to another
site. Back and Forward move between the targets list, a grid and a story; moving between stories
or views of one grid updates the address in place.

A link to something that is gone opens the nearest screen that still exists, and the status line
says why: a story not in the newest CI run opens its grid, and a pull request no longer listed
(closed, or no CI run) opens the targets list.

Finish's commit is signed by the git configuration of the process that runs the server. If
someone else started it for you (an agent, a service manager), the commit carries their
identity: the page names the key that will sign before every Finish and prints the command that
starts the same server from your own shell.

## The screens

1. **Targets.** Each open pull request with a run of the capturing workflow, and the default
   branch (shown as "master (seed)") when started with `--master-run`. Per project: how many items need a decision, how many you decided, and badges:
    - **merge master first**: the default branch has newer baselines for this project than the
      pull request. Merge the default branch into the pull request's branch (by merge, never
      rebase) and wait for CI.
    - **capture failed**: the `visual` job produced no results. Re-run that job in GitHub Actions.
    - **CI still running**, **waiting for CI**, **downloading the captures**: there is nothing
      to review yet; reload the page in a moment.
    - **artifact expired**: GitHub deleted the capture after 30 days and it was never
      downloaded here. Re-run the `visual` job.
    - **incomplete: N of M stories**: the capture stopped part way. Re-run the job.
    - **not seeded from master**: this project is not reviewed on the default branch
      (`"seedFromDefaultBranch": false` in the config); its first baselines are accepted on a pull
      request.
2. **Grid.** It opens on **Needs a decision** (the undecided items, counted on the button); **All**
   and one button per status show the rest, and **Accepted**, **Rejected** and **Excluded** show
   what you decided, each counted, as Chromatic's review does. A line above the grid splits what is shown into
   errors and images to compare, so the counts always add up. At the top, **Errors** lists every failed capture with its reason and,
   under "console and stack", the story's console output and the thrown error's stack (a play
   function's failed `expect` included). An error is never accepted: fix the story, re-run the
   `visual` job for a one-off timeout, or exclude it with a reason. Below it the items are grouped
   by component (the story id before `--`), components with a changed item first, then new,
   unstable and removed ones; each story's modes (light, dark) sit side by side under its name.
   Every tile is numbered, and the number is the story screen's "N of M". A component's
   **Accept N undecided** accepts that component's undecided items without opening them, after
   asking. Under every decided tile (and every decided error) its decision is spelled out:
   "Accepted", "Accepted (not opened)" for one Accept all took, or "Rejected" or "Excluded" with
   the reason. Its **Undo** clears it without opening the story. A component's **Undo N
   decisions**, and **Undo all decisions** beside Accept all for the whole project, clear many at
   once: the first press turns the button into "Confirm: undo N decisions", a second press undoes,
   and Escape or any other change to the grid cancels. Every Undo here is the same request as the
   story screen's U. A reject an earlier Finish already posted says "Posted by Finish: stays" and
   has no Undo on the grid; the bulk Undo buttons leave it too. **Filter by story id** narrows the grid; **Go to** opens item N, or the first item
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
   "box i of k" counts them. **Box** (B) turns that outline on and off; the page remembers the
   choice in this browser. The views, each shown in the right pane at the same scale and place:
   **Side by side**; **Flash**, which shows baseline and new one after the other in the same
   place, about 1.5 times a second (the images themselves, not an overlay), keeping the zoom and
   scroll it was opened at; **Highlight**, the changed pixels in solid red laid over both images
   themselves, in both panes, where **Blink** (L) flashes the red pixels on and off at Flash's
   pace (remembered in this browser); and **Spotlight**, the new image dimmed everywhere except around the changed pixels
   (each grown by 10 image pixels), which finds a one-pixel change, where **Spotlight flash** (F
   in Spotlight) shows the spotlighted baseline and the spotlighted new image one after the other
   at Flash's pace, the pane's label saying which (remembered in this browser). Flash, Highlight and
   Spotlight need two images; on a new or removed story they are off and the page says why
   ("New story, no baseline", "Only one image: this story was removed"). Badges here:
   **size changed** (in image pixels), **flaky** (the two captures differed, then matched), and
   **re-review** (an accept you made was replaced by the default branch's newer baseline).

    **Next** and **Previous** (J and K) walk one pass: the items the grid showed when you opened
    the story, in the grid's order, frozen until you go back to the grid. Accepting, rejecting or
    excluding an item never drops it from the pass: the decision moves on to the next item, and
    **Previous** comes back to the one just decided, showing its decision and an **Undo** (or U).
    Going back to the grid shows what its filter now selects: under **Needs a decision** the items
    you decided have left it, and the count has gone down; **Accepted**, **Rejected** and
    **Excluded** show them with their decisions.

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

| Key          | Action                                                                         |
| ------------ | ------------------------------------------------------------------------------ |
| J / K        | Next / previous item of this pass (decided items stay in it)                   |
| A            | Accept an undecided item, once both its images are shown                       |
| R            | Reject an undecided item (asks for a reason, then Enter)                       |
| E            | Exclude an undecided item (asks for a reason, then Enter, then a confirmation) |
| U            | Undo the item's decision (on the grid: each tile's Undo button)                |
| F            | Flash between baseline and new; F again returns to side by side                |
| F            | In Spotlight: flash the spotlighted baseline and new, or stop flashing         |
| H            | Highlight changed pixels; H again returns to side by side                      |
| S            | Spotlight the changes; S again returns to side by side                         |
| Z            | Next zoom: fit to screen, real size, 2x, 4x, 8x, then fit again                |
| N            | Next changed box                                                               |
| B            | Outline the changed box, or stop outlining it                                  |
| L            | In Highlight: blink the red changed pixels, or hold them on                    |
| Space (hold) | Flash while held                                                               |
| Shift+A      | Accept every undecided item of this project without opening it (asks first)    |
| Escape       | Back to the grid from a story, wherever the focus is (the reason box included) |
| Escape       | On the grid: cancel an Undo N decisions or Undo all decisions pressed once     |

No key reverses a decision. A, R and E do nothing on an item that is already decided, and say
so; to change a decision, press U (or the Undo button) first. The same key twice never undoes.
A held A, R, E or U decides once, and a double click on a decision button decides only the item
it was clicked on, never the next one.

## What each decision does

- **Accept**: the new screenshot becomes the baseline (or, for `removed`, the baseline is
  deleted). Allowed on `changed`, `moved`, `new` and `removed`. For a renamed story the baseline
  is written under the new id and the old id's baseline is deleted, in the same commit.
- **Reject**: the difference is a regression. It always needs a reason, which is posted to the pull
  request as a comment with a machine-readable block an agent can read. The pull request stays
  blocked until its code changes so the capture matches the baseline again.
- **Exclude**: stops capturing the story. It needs a reason and writes
  `<baselines>/<project>/<story id>.json` with `disableSnapshot: true`. It drops **every mode
  of the story**, on every later pull request, until that file is deleted. It is the only
  decision for `unstable` and `failed` items; for a one-off `failed` item (a timeout on a busy
  runner), re-run the `visual` job instead, since the newest attempt replaces the old results.
- **Undo** (U, or a tile's Undo on the grid) clears a decision before Finish; it is the only way
  to change one. The grid also undoes a whole component or project, after a second press.
  Decisions are kept across server restarts. A decision applies only to the image it was taken
  on: when a new run or a re-run attempt captures that item differently, it is undecided again
  (the old decision stays saved, and comes back if the image does).
- After Finish, accepts and exclusions are cleared; rejects stay, marked as already posted, and
  still show as rejected on the next CI run while the capture is unchanged. Finish does not post
  them twice. They live in the work directory's `state/` (the config's `workDir`), not in the
  repository.

## Finish

Finish applies every decision on one target at once:

- **A pull request:** one commit holding the accepted PNGs, the exclusion files and one review
  record in `<baselines>/reviews/`, pushed to the pull request's branch, plus one comment
  holding every reject. CI then recaptures, and the accepted items read `unchanged`.
- **Face ID first, once a passkey is registered** (see the next section): Finish's question
  counts what the record holds ("Face ID approves this record: N accepts, M rejects") and its
  answer reads "Approve with Face ID and finish". Your device then signs the record, and Finish
  commits exactly that record, as version 2 with the approval in it. A rejects-only Finish
  commits nothing; the reject comment's machine-readable block carries the approved record.
  Cancelling Face ID changes nothing, and Finish can be pressed again.
- **One commit status**, "Visual review", posted once when Finish completes (never per
  decision), on the commit Finish pushed, or on the captured commit when it pushed none. It
  fails when anything was rejected, is pending while items are left undecided, and succeeds
  otherwise; its description counts the accepts, rejects, exclusions and undecided items. It is
  information for the pull request page, not a required check: the merge gate is the "Visual
  gate" job. If posting it fails, the page says so; what was pushed and posted stays.
- **The default branch (seeding):** a branch `visual/seed-<date>` with the same commit and a pull
  request from it, and one issue holding every reject (labelled with the config's `issueLabels`)
  with the same machine-readable block, for a person or an agent to fix the stories. Rejects alone, with nothing accepted, open only the issue.

Finish runs on the server, not in the page. A seed of several hundred images takes minutes,
most of it uploading the images to Git LFS, which is longer than a browser (Safari on an iPad in
particular) keeps one request open. So pressing Finish only starts it, and the page then shows
each step as it happens: checking, writing the files, committing, uploading images to LFS (with a
count of the images uploaded so far), pushing, opening the pull request or posting the rejects,
and posting the status. When it ends, the page shows what was pushed and posted, or the error.
Closing or reloading the page does not stop it: reopen the page and it shows the running Finish
instead of a Finish button, and after it ends the result stays above the targets until the
server restarts. Only one Finish runs at a time, and decisions on that target are refused until
it ends.

The commit is signed by whatever git configuration the server process sees: yours when you
started it, someone else's when they (or an agent working for you) started it. The top of the
targets screen and Finish's confirmation name the key that will sign, where git found it and the
committer, and print the exact command that starts the same server from your own shell. If
Finish fails, your decisions are kept and the page shows git's or GitHub's message:

- **capture is stale, wait for CI**: someone pushed to the branch after the capture. Wait for the
  new CI run, then decide again what still differs.
- **merge master first**: see the badge above.
- **failed to write commit object** or a signing error: unlock or plug in the signing key, then
  Finish again.
- **the accepts were pushed ..., but the reject comment failed**: the accepts are done and cleared;
  press Finish again to post the rejects.

## Approving with a passkey

A passkey (Face ID or Touch ID, kept in iCloud Keychain or another passkey manager) proves that
an accept came from your own device, for exactly the record Finish commits. Once your passkey is
in `visual-review/passkeys.json` on the default branch, the gate refuses every review record a
pull request adds unless it carries such an approval.

**Registering.** Start the page from your own shell (not through an agent) on the host the
passkey is for, over HTTPS, for example `https://dev.example.com:9443`. The passkey belongs to
that host name (its "rpId"), so serve the page from the same host every time. On the targets
screen press **Register passkey**, then **Create the passkey with Face ID**, and confirm with
Face ID. The server opens a pull request adding the key to `visual-review/passkeys.json`; merge
it. From that merge on, approvals are enforced. Until it is merged, the server that registered
the key already asks for Face ID at Finish, so nothing you finish meanwhile is left unapproved.

**Finishing.** Finish asks for Face ID as soon as the server knows of any key. The record is
built on the server first, its SHA-256 is the challenge your device signs, and Finish refuses to
commit a record that differs from the one you approved ("the record changed after you approved
it; press Finish again"). Immediately before committing, Finish checks the approval with the
gate's own code.

**Devices and more keys.** An iCloud Keychain passkey is on every device signed in to your Apple
account, so a lost device loses nothing. To add a key (another passkey manager, another host),
register again: each registration is another pull request that appends a key. To remove one,
edit `visual-review/passkeys.json` in a pull request; it must keep at least one key, or the gate
fails it, so approvals cannot be switched off by a pull request.

`visual-review/passkeys.json` sits at that path in every repository that uses this tool. It
holds public keys only: `{ "version": 1, "keys": [{ "id", "publicKey", "rpId", "label",
"registeredAt" }] }`, with the public key as base64url SubjectPublicKeyInfo (P-256). Records
already on the default branch when enforcement starts are never checked again.

## Seeding: one story at a time

A story does not have to look right the first time, and nothing has to be seeded in one pass.
Seeding is per story:

1. The review workflow captures every story on every push to the default branch. Start the
   server with `--master-run <run id>` (that workflow's newest run on the default branch) and open
   "master (seed)". Every story without a baseline is `new` there.
2. **Accept** the stories that look right. **Reject** the ones that do not, with a reason saying
   what is wrong. **Leave the rest** undecided; they simply stay without a baseline. Exclude only
   stories that are unstable. Press Finish: the accepts become the seed pull request, and the
   rejects become one issue whose machine-readable block says what to fix.
3. Merge the seed pull request once its own capture shows its accepted items `unchanged`.

To seed from an older, known-good commit instead of the newest, capture it with the default
branch's tool: `gh workflow run visual-seed.yml --ref <default branch> -f ref=<sha>`, then start
the server with `--master-run <that run's id>`. It is listed as "master (seed)"; its results.json
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
  still undecided shows. Decisions you made but did not Finish are kept for every image whose
  hash did not change.

## Story parameters

Capture reads each story's `parameters.chromatic`, the same keys Chromatic reads, so stories
written for Chromatic work unchanged:

| Parameter                       | Effect                                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `disableSnapshot: true`         | The story is not captured (a baseline it still has is reported `removed`)                                                  |
| `diffThreshold`                 | pixelmatch's per-pixel colour threshold, 0 to 1 (default 0.063)                                                            |
| `diffIncludeAntiAliasing: true` | Count anti-aliased pixels as changes                                                                                       |
| `delay`                         | Milliseconds to wait after the render before the screenshot                                                                |
| `modes`                         | `{ "<name>": { <Storybook globals> } }`: one capture per mode, named `<story id>.<name>.png`; `disable: true` drops a mode |

Inside a story, `isChromatic()` from `chromatic/isChromatic` is true during capture (the URL carries
`chromatic=true`). A settings file `<baselines>/<project>/<story id>.json` overrides the story's
parameters; the page's Exclude writes one with `disableSnapshot: true` and your reason.

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
- Every baseline PNG, and every settings file that excludes a story, that the pull request adds,
  changes or deletes must be named with its new hash in a review record the pull request adds
  under `<baselines>/reviews/`. A baseline PNG is a Git LFS pointer in git, and the gate reads the
  image's hash from the pointer, so it never downloads an image. Existing records may not be
  edited or deleted. This stops the shortcut of copying captured PNGs, or an exclusion, straight
  into the baselines directory.
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
- **A seed record can be replayed.** A seed's record names no pull request, so it could be copied
  into another pull request together with the exact images you approved for that seed. It can
  only reinstate images you approved.
- **Only the repository owner should approve.** The page runs on a development machine, where
  anything running as you (an AI coding agent included) has your GitHub login and signing key and
  could press Accept or call the page's API. Before a passkey is registered nothing technical
  prevents that; afterwards an agent can still decide, but cannot produce the approval Face ID
  gives. Tell your agents not to register passkeys or use the page.
- The projects the gate checks are every project in the base branch's config and in the pull
  request's config, seeded or not, plus every project with baselines on the base branch. So
  removing a project from the config does not remove it from the gate.
- The gate is part of a workflow file, which a pull request can edit, and a pull request can
  loosen a story's own `diffThreshold` or `delay`, or a settings file's non-excluding keys,
  without a review item. Read changes to those in code review. The gate prints a warning when a
  pull request changes `visual-review/passkeys.json`, the gate (`trusted/gate.mjs`), its verifier
  (`trusted/lib/approval.mjs`) or the workflow that runs it.

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
  pull request. Merge the default branch into the branch (by merge, never by rebase, so an accept
  commit stays as it was made) and wait for CI.
- **Finish fails with "failed to write commit object"** or another signing error: unlock or plug
  in your signing key, then press Finish again. Your decisions are kept.
- **"the accepts were pushed ..., but the reject comment failed".** The accepts are done; press
  Finish again to post the rejects.
- **"the record changed after you approved it; press Finish again".** The decisions, the capture
  or the default branch changed between your Face ID and the commit. Press Finish again and
  approve the new record. **"the approval is stale"** means the same, from another tab or after
  ten minutes.
- **"no passkey is registered for <host>".** Passkeys belong to the host name the page is served
  from. Serve the page from the host your passkey is for, or register one for this host.
- **"Not approved: nothing was changed".** Face ID was cancelled or refused, or Safari did not
  count the press as yours. Press Finish again.
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
- **A merge conflict under the baselines directory.** Take the default branch's side for every
  file there and let CI capture again; review what still differs.
- **Captures differ from what you see locally.** Only CI's captures are compared: fonts and the
  graphics stack differ from machine to machine. Look locally with `capture --stories` and
  `serve --results`, but let CI's capture become the baseline.
