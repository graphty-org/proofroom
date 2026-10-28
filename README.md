# proofroom

Visual regression review for Storybook, hosted by nobody. Your CI screenshots every story on every
pull request and compares each screenshot with an approved baseline PNG kept in your repository (in
Git LFS). You open a review page on your own machine, see every difference, and accept, reject or
exclude each one. Accepting commits the new baselines to the pull request's branch, signed with your
passkey. A required check, the "Visual gate", keeps a pull request from merging while it holds a
difference nobody accepted.

There is no service, account or per-snapshot bill: the captures live in your CI's artifacts, the
baselines live in git, and the review page reads both through the `gh` CLI with your login.

proofroom was `@graphty/visual-review`; see [Coming from
@graphty/visual-review](docs/coming-from-visual-review.md) to move over.

- [How it works](docs/how-it-works.md)
- [Requirements](#requirements), [install and set up](#install-and-set-up),
  [configuration](#configuration), [the GitHub Actions workflows](#the-github-actions-workflows),
  [using it without GitHub](docs/plain-git.md)
- [Your first review: seeding baselines](#your-first-review-seeding-baselines)
- [Opening the review page](#opening-the-review-page): [the screens](docs/the-screens.md),
  [keys](docs/keys.md), [settings](docs/settings.md), [what each decision does](docs/decisions.md),
  [spending less time on pixel changes](docs/spending-less-time.md), [Finish](docs/finish.md),
  [starting a capture from the page](docs/capturing-from-the-page.md)
- [Approving with a passkey](#approving-with-a-passkey), [the approval format](docs/approval-format.md)
- [Updating from the default branch](#updating-from-the-default-branch),
  [seeding one story at a time](#seeding-one-story-at-a-time), [candidates](#candidates)
- [Capture and compare](docs/capture-and-compare.md), [test results (JUnit and result
  lines)](docs/test-results.md), [each snapshot as a test in your runner](docs/test-runners.md)
- [Iterating on a story before a pull request exists](#iterating-on-a-story-before-a-pull-request-exists),
  [checking that two machines draw the same pixels](#checking-that-two-machines-draw-the-same-pixels)
- [Story parameters](#story-parameters), [reorganizing stories: renames](#reorganizing-stories-renames)
- [What the gate does and does not guarantee](#what-the-gate-does-and-does-not-guarantee)
- [Usage events](docs/usage-events.md), [Troubleshooting](docs/troubleshooting.md)

## Requirements

- **A git repository on GitHub, with GitHub Actions.** The review page talks to GitHub through
  the [`gh` CLI](https://cli.github.com), logged in (`gh auth login`) as someone who can push to
  the repository's branches.
- **Node.js 22 or newer**, locally and in CI.
- **Storybook 7 or newer**, built as a static site (`storybook build`), which writes the
  `index.json` the capture reads.
- **Playwright**, a peer dependency: install it next to this package. `proofroom
install-browser` installs the Chromium that version of Playwright drives.
- **git-lfs**, on every machine that accepts baselines or pushes a branch holding them. GitHub's
  runners have it. Install it with your package manager (`brew install git-lfs`,
  `sudo apt-get install git-lfs`), or without root put the `git-lfs` binary from
  https://github.com/git-lfs/git-lfs/releases on your `PATH`; then run `git lfs install` once,
  and `git lfs pull` in every checkout that already existed.
- **jq** on the runners, which GitHub's Ubuntu runners have.

## Install and set up

```bash
npm install --save-dev proofroom playwright
npx proofroom init
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

`proofroom init --force` rewrites the two workflows when they still start with the line
`init` writes ("Generated by proofroom init"), to pick up a newer template after an upgrade.
It never replaces the config or a workflow you wrote yourself.

Every command has `--help`; `proofroom --help` lists them.

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

| Key              | Default                   | Meaning                                                                                                                 |
| ---------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `defaultBranch`  | `main`                    | The branch baselines are seeded from and pull requests merge into                                                       |
| `workflow`       | `visual-review.yml`       | The workflow file whose runs hold the captures; the review page looks runs up by it                                     |
| `baselines`      | `visual-baselines`        | Where baselines live: `<baselines>/<project>/<story id>[.<mode>].png`, and review records in `<baselines>/reviews/`     |
| `approvals`      | `visual-review-approvals` | Where Finish commits your approvals of the baselines tree, `<approvals>/<tree>.json`; outside `baselines`               |
| `workDir`        | `.visual-review`          | Where `serve` downloads captures and keeps its decisions and session token; keep it out of git                          |
| `commitPrefix`   | `test`                    | The conventional-commit type and scope of the commits Finish makes, e.g. `test(ui)`                                     |
| `issueLabels`    | `["bug"]`                 | Labels of the issue Finish opens for rejects on the default branch; each must exist                                     |
| `fontconfig`     | none (host fonts)         | A `fonts.conf` in the repository that every capture draws with, locally and in CI (see "Pinned fonts")                  |
| `updateCheck`    | none                      | A shell command `update` runs on its merge before it pushes (see "Update from the default branch")                      |
| `candidates`     | none                      | A shell command `serve --candidate next` runs to list the default branch's full runs (see "Candidates")                 |
| `usage`          | `false`                   | `true`: the review page records how you review, on this computer only (see [Usage events](docs/usage-events.md))                              |
| `ignoreBranches` | `[]`                      | Branch-name prefixes whose pull requests the review page never lists, e.g. `["dependabot/"]`                            |
| `diskBudget`     | `10`                      | How many GB `serve` may keep in `workDir`; beyond it, it removes images (see "Troubleshooting")                         |
| `codeHost`       | `github`                  | Where your changes are: `github` (pull requests) or `plain-git` (your branches; see "Using it without GitHub")          |
| `captureStore`   | `github-actions`          | Where the captures are: `github-actions` (CI's), or `local-folder` (this machine's only, the default under `plain-git`) |
| `stories`        | `storybook`               | Where the stories come from; `storybook` is the only value                                                              |
| `renderer`       | `playwright-chromium`     | What draws each story; `playwright-chromium` is the only value                                                          |
| `projects`       | (required)                | One entry per Storybook; the id names its baselines directory, CI job and artifact                                      |

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

### Pinned fonts

Chromium finds fonts through the host's fontconfig, so a capture made on a laptop and one made in
CI draw text with whatever fonts each machine has installed, and a runner image update can change
CI's own captures. `fontconfig` names a `fonts.conf` committed to your repository; capture starts
every browser with `FONTCONFIG_FILE` pointing at it and a font cache of its own, so no host font
or host font setting is consulted. Write the file with relative paths, so it works from any
checkout:

```xml
<fontconfig>
    <dir prefix="relative">fonts</dir>
    <include ignore_missing="no" prefix="relative">conf.d</include>
    <cachedir prefix="xdg">fontconfig</cachedir>
</fontconfig>
```

Commit the font files with Git LFS. The workflows fetch everything in the `fonts.conf`'s
directory along with the baselines, and capture refuses to start while any file there is still an
LFS pointer (run `git lfs pull --include "<that directory>/**"`); it never falls back to the host's
fonts. Each results.json records the SHA-256 of the directory as `environment.fonts`, and
`environment.emojiFont` says whether the pinned set draws emoji. To keep your existing baselines,
snapshot the fonts and `/etc/fonts/conf.d` your CI runner has today; switching to a different set
changes every capture with text, which is one re-baseline.

## Using it without GitHub

proofroom also works in a git repository with no GitHub. Set it up with
`npx proofroom init --code-host plain-git`: your branches are then the changes you review, every
capture is made on your machine from the review page, and Finish writes the rejects to a file on the
branch instead of commenting. How to set it up, capture, review and finish:
[docs/plain-git.md](docs/plain-git.md).

## The GitHub Actions workflows

**`visual-review.yml`** runs on every pull request and every push to the default branch:

- **Plan** reads the projects from the config.
- **visual (&lt;project&gt;)**, one job per project: fetches that project's baselines from Git LFS
  (cached), installs your dependencies, installs Chromium, runs the project's `build`, downloads
  the default branch's newest capture as a reference (on pull requests), captures, and uploads
  the artifact `visual-<project>-<attempt>` (kept 30 days). It never fails because of a
  difference; `continue-on-error` keeps even a crash of the tool from failing the run.
- **Visual gate** (pull requests only) downloads every capture of the run and runs
  `proofroom gate` at the version `init` pinned, with `npx`, so a pull request's own
  dependencies cannot change it. It passes `--pr` with the pull request's number, which the
  passkey check needs (see [Approving with a passkey](#approving-with-a-passkey)). Make it a
  required check. In a Mergify merge-queue run, pass `--queue-event "$GITHUB_EVENT_PATH"` instead
  of `--pr`: the gate reads the batch's pull requests from the queue's draft pull request and
  accepts a review record for any of them. It compares baseline changes with the commit the batch
  sits on (its `checking_base_sha`), so a batch stacked on another is not charged with that
  batch's changes. Every capture must still equal a baseline, so a batch passes only on images
  already approved on its pull requests. When two pull requests in a batch decided the same
  baseline file differently, the batch fails.

The capture job also makes the pictures the review page's list shows (WebP, a few KB each, drawn
by the same Chromium that took the captures) and records which browser drew them, so the artifact
carries them and the review page shows every picture as soon as it is downloaded. See
[Capture and compare](docs/capture-and-compare.md).

It can also be started by hand or by the review page (**New capture...**, Where: CI), with the
inputs `ref` (the commit to capture), `pr` (a pull request to capture at that head), `projects`,
`stories` (story id prefixes, separated by commas) and `request`; see [Asking CI for a
capture](docs/capturing-from-the-page.md#asking-ci-for-a-capture). A workflow written by an older
`init` lacks them: `npx proofroom init --force` writes the new one.

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
PORT=4800 npx proofroom serve
```

It prints the address to open, with a session token after `#token=`; open that exact URL. The
token is kept in the work directory, so the URL stays valid across restarts; delete
`<workDir>/state/token` to issue a new one. The page remembers the token in that browser. When it
has none, or the server refuses the one it has (a new token was issued), it asks for it: paste the
token, or the whole URL `serve` printed, and it loads. The field hides what you paste.

- Without a certificate it serves plain HTTP, and only on `localhost` (`HOST` defaults to it).
  To open the page from another device (an iPad, say), serve HTTPS: set `HOST` to the machine's
  name and `HTTPS_CERT_PATH` and `HTTPS_KEY_PATH` to a certificate and key for it.
- `serve` refuses to start without git-lfs: an accept would commit raw PNGs.
- `--candidate <run id>` (or `--master-run <run id>`) also lists the default branch at that run,
  for seeding.
- `--candidate next` lists the default branch's next candidate instead (see [Candidates](#candidates)).
- `--results <dir>` serves local captures offline (a directory of `<project>/results.json`), for
  looking at a story before a pull request exists. It is listed as "Local preview" and is look
  only: no Accept, Reject or Exclude, and no Finish.
- `--previews <dir>` is where local previews of pull requests are, as `<dir>/<pr>/<project>/`
  (default: the config's `workDir` plus `/local`, in the repository's main checkout, so a server
  run from any worktree finds them). A local preview is a capture of the pull request's merge tree
  (`refs/pull/<n>/merge`) made with `VISUAL_REVIEW_PREVIEW_PR=<n>` and
  `VISUAL_REVIEW_PREVIEW_HEAD=<head sha>` set, ideally with the config's `fontconfig` so its bytes
  match CI's. While CI has not captured a project of that head, a complete preview of it is listed
  in its place as "local preview, CI pending", and Accept, Reject, Exclude and Finish work on it as
  on CI's capture. Finish's record then names no CI run (`subject.runId` is null) and lists the
  previewed projects in `subject.local`. The gate does not change: CI captures the Finish commit
  and compares it with the images you accepted, so the pull request passes with nothing left to
  decide when CI draws the same bytes, and any image CI draws differently comes back to you
  undecided. Decisions are kept by image hash, so when CI's capture of the same head lands every
  identical image keeps its decision. A Finish moves the head (its accept commit, and its approval
  commit), and a preview stays current while the branch has gained only such commits since (one
  parent each, changing nothing outside the baselines and approvals directories): what you decided
  shows as decided, the rest undecided, and you keep deciding and finishing there. While a
  preview of the head is still capturing, a project it has not written yet shows as not loaded,
  and the page reads the preview again as soon as its `status.json` changes. After any other
  commit, a draft says "a new preview is needed for this head". See [local previews](https://github.com/graphty-org/graphty-monorepo/blob/master/design/visual-testing/local-previews.md).

The page opens on the changes that need you, ready captures first, then the smallest and the longest
waiting. See [The screens](docs/the-screens.md) for what each screen shows, and [Keys](docs/keys.md)
for the keyboard. `GET /api/inbox` (with the token) answers the same list as JSON.

### One quiet notification

`proofroom notify` runs beside `serve`, from the same checkout, and sends one message when
pull requests become ready: the first at once, any more within ten minutes (`--gap <minutes>`)
held and sent together, nothing when nothing is new. A pull request is announced once per pushed
head while it waits; never for CI running, a failed capture, a download or a merge. It reads only
the inbox `serve` keeps in `<workDir>/state/inbox.json` and remembers what it sent in
`<workDir>/state/notify.json`, so a restart neither repeats nor loses a message. It sends by
running the program you name, as a JSON array, with `{title}`, `{message}` and `{url}` replaced
and no shell:

```bash
VISUAL_REVIEW_NOTIFY='["/path/to/send-push.sh", "{title}", "{message}"]' npx proofroom notify
```

The message lists one line per pull request ("#812 Fix label padding: 2 images") and the page's
address without the token, so the token never passes through a push service.

Finish's commit is signed by the git configuration of the process that runs the server. If
someone else started it for you (an agent, a service manager), the commit carries their
identity: the page names the key that will sign before every Finish and prints the command that
starts the same server from your own shell.

## Finish

**Finish**, at the right of the review page's top bar, publishes every decision on one change, across
all its projects, at once. Its sheet says exactly what will happen before anything does. On a pull
request it commits the accepted images and exclusions to the branch, posts the rejects as one comment
(with a machine-readable block an agent can read), signs your decisions with your passkey and sets
one commit status, "Visual review". On the default branch (a seed) it pushes a branch
`visual/seed-<date>` and opens its pull request, and the rejects open one issue. Finish runs on the
server, so a reload or a closed tab does not stop it. See [Finish](docs/finish.md).

## Approving with a passkey

A passkey (Face ID or Touch ID, kept in iCloud Keychain or another passkey manager) proves that
an approval came from your own device, for exactly the baselines Finish leaves on the branch.
Once your passkey is in `visual-review/passkeys.json` on the default branch, the gate refuses
baselines that differ from the base branch's unless such an approval of exactly their tree is in
the pull request. Until then the gate checks that an approval names the tree, but not who made
it.

### Registering the passkey

Do this once, yourself, never through an agent.

1. Start the page from your own shell on the host the passkey is for, over HTTPS, for example
   `https://dev.example.com:9443`. The passkey belongs to that host name (its "rpId"), so serve
   the page from the same host every time; the port may change.
2. In **Settings** press **Register passkey...**, then **Create the passkey**, and confirm on your
   device. The key is named by the kind of device that made it and the day ("iPad passkey,
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

Until it merges, Settings lists the key as waiting for its pull request to merge: Finish asks for it
already, but the CI gate checks approvals only once it is merged. Before any passkey is registered,
Finish's sheet says "Not yet protected: no passkey registered.", and Finish commits accepts
unapproved.

### Finishing with Face ID

What follows is the tree approval, which Finish writes while the repository's config has no
`"approvalFormat": "change"`. With it, Finish writes one signed change statement per Finish instead,
which survives other changes landing on the default branch; see [The approval
format](docs/approval-format.md).

Finish asks for your passkey when the server knows of a key for the page's host and the Finish
commits anything. It runs in this order, so what you sign is what lands:

1. When the sheet opens, the server commits your accepts and the review record (the accept
   commit), without pushing it, and builds the statement: that commit, the git tree of the
   baselines directory in it (which holds the review record), the baselines directory's name, the
   pull request and the time. The SHA-256 of the statement's canonical JSON is the challenge your
   device signs, once.
2. When you approve, Finish checks the signature with the gate's own code, commits the statement
   with your approval as `<approvals>/<tree>.json` on top of the accept commit (outside the
   baselines directory, so the tree you signed stays exactly as it was), and pushes both. The tree
   hash covers the review record's bytes, so the review server counts its accepts as approved
   before on later pull requests.

A Finish that rejects anything or leaves anything undecided signs no tree: the challenge is the
SHA-256 of the review record instead, and the server writes your approval into the record in the
accept commit and pushes it.

A branch that moved after the sheet opened refuses the push ("capture is stale"), and nothing is
pushed. On a Mac, Touch ID or your login password takes Face ID's place.

### What the gate checks

With `node:crypto` and git alone:

- When the pull request's baselines directory has the same git tree as the base branch's, there
  is nothing to approve.
- Otherwise the pull request must hold `<approvals>/<tree>.json`, `<tree>` being its baselines
  directory's tree, whose statement names that tree and the baselines directory, and a commit
  that is an ancestor of the pull request's merge commit and holds that tree.
- Once the base branch's `visual-review/passkeys.json` holds a key, the statement carries an
  approval by one of those keys over the SHA-256 of exactly that statement, made on an HTTPS page
  whose host is exactly the key's host, with user verification (Face ID, Touch ID or the device's
  passcode).
- The pull request's captures match its baselines, as always.

Baseline PNGs are Git LFS pointer files whose text names each image's SHA-256, so the tree hash
covers every pixel of every baseline, and every settings file and review record beside them. The
pull request number is in the statement for the record only: an approval is for a tree, not for a
pull request, so a branch that carries several changes is approved once, and an approval made
on a branch still holds after that branch is merged into another one, as long as the tree is the
same. The review records under `<baselines>/reviews/` are part of the tree like any file; the gate
gives them no meaning of its own.

### Replacing the passkey

An iCloud Keychain passkey is on every device signed in to your Apple account, so a lost device
loses nothing. Once the default branch holds a key, the gate fails any pull request that changes
`visual-review/passkeys.json`, so no pull request can swap in another key. To add or replace one
anyway (another passkey manager, another host, a lost Apple account), register it on the page;
the pull request it opens says the gate fails it. Check the credential id, and merge it as an
administrator past the failing check. Removing every key is refused the same way.

`visual-review/passkeys.json` sits at that path in every repository that uses this tool. It
holds public keys only: `{ "version": 1, "keys": [{ "id", "publicKey", "rpId", "label",
"registeredAt", "identity" }] }`, with the public key as base64url SubjectPublicKeyInfo (P-256).
The optional `identity` says whose key it is (a code host user name, e-mail addresses), which
`"selfApproval": "forbid"` uses to refuse approvals of your own change; see
[the approval format](docs/approval-format.md#forbidding-self-approval).

## Updating from the default branch

A capture compares a pull request's stories with the baselines on its own branch. When the
default branch accepts newer baselines for the same project afterwards (another pull request's
Finish merged), the merged tree is a tree you have not approved: CI captures and gates the pull
request merged into the default branch, and once the default branch's newer baselines are in it,
the gate needs your approval again. The page shows what differs from the default branch, so the
next review covers it.

A pull request whose branch and the default branch changed the same baseline files cannot merge
at all, and the merge queue cannot update it. Fix that from the page or a terminal:

- **On the page:** **Update from master...** on the change's snapshot list, where it says the
  default branch has newer baselines. It asks first, then runs on the server like Finish.
- **In a terminal:** `npx proofroom update <pull request number>`.

Either way it fetches the default branch and the pull request's branch, merges the default
branch into the branch with a merge commit (never a rebase, so an accept commit stays as it was
made), and for every conflicting file under the baselines directory takes the default branch's
side. The commit names those files, and is signed as your git configuration signs. It pushes to
the branch, and CI captures again. A conflict anywhere else refuses: it lists the files, and
nothing is committed or pushed; merge that by hand.

A merge with no conflict can still be broken: git merges two edits to the same code file without
asking, and the result may not compile. `update` pushes with your hooks switched off, so set
`updateCheck` to a shell command that checks the merge, such as your build or type check. When
the merge changed any file outside the baselines directory, `update` runs it from the root of the
merged checkout (a fresh git worktree, with no installed dependencies) before it pushes, with the
branch's commit before the merge in `VISUAL_REVIEW_UPDATE_BASE`. If it exits with anything but 0,
nothing is pushed, the branch stays where it was, and the message ends with the end of the
command's output. A merge that changed only baselines is pushed without it. For example:

```json
"updateCheck": "npm ci && npm run build"
```

It accepts nothing and writes no review record. A pull request whose baselines end up exactly as
the default branch's needs no approval; one that still holds baselines of its own needs your
approval of the merged tree, on the next Finish. Whatever the pull request's capture still shows
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
   stories that cannot be shot the same way twice. Press Finish: the accepts become the seed pull request, and the
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

## Candidates

A repository that promotes the default branch only once its screenshots are approved lists its full
runs with the `candidates` command (configuration): JSON on stdout,
`[{ "commit": "<sha>", "runId": 123, "waiting": true, "at": <ms> }]`, where `waiting` means the run
waits for its screenshots' approval and `at` orders the runs. `serve --candidate next` runs it at
every refresh and lists the oldest waiting run as the default branch's target, named
`<branch> candidate <sha> (N queued)`. It stays offered while newer candidates arrive; they queue
behind it. Decisions are kept by image hash, so an image decided on one candidate arrives decided on
the next.

Finish on a candidate commits the accepts on the candidate's commit, pushes them to
`visual/approve-<sha>` and opens a pull request to the default branch. The commit may change only
the baselines and approvals directories: Finish refuses to push anything else. The candidate stays
offered until the command stops reporting it `waiting` or its accept commit reaches the default branch.
A Finish that rejects anything posts only the rejects (one issue, as for a seed), drops the candidate
and offers the next one, with the rejected images still rejected and the accepts still saved.

## Iterating on a story before a pull request exists

To try a story's look quickly, capture it locally and look at it, as a PNG or in the page:

```bash
npx proofroom install-browser        # once per machine
npm run build-storybook                  # your project's build command
npx proofroom run --project web --out .visual-review/preview/web --stories button--,badge--
```

`--stories` captures only the story ids that start with one of the given prefixes, in seconds
rather than minutes, and then reports no baseline as removed. Start the server with
`--results .visual-review/preview` to see the capture beside its baseline. Capture and look again
after each change. Such an ad hoc capture is look only. To approve before CI has captured, push,
capture the pull request's merge tree as a local preview (`serve --previews` above), and accept it
on the pull request; CI's capture stays the judge.

## Checking that two machines draw the same pixels

Two captures of the same commit should hold the same bytes, wherever they ran. To check, capture
the same stories in both places and compare the two results:

```bash
npx proofroom parity --project web ci-capture/web local-capture/web
```

Each argument is a capture's `--out` directory (or its `results.json`). The command prints one
line per story and mode whose image bytes differ, that only one side captured, or that one side
failed to capture, and exits 1 if there is any. No threshold applies: from the same commit, any
difference means one of the two environments draws differently (a missing font, a GPU path), and
that is the thing to fix.

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
  story), so stories with nothing moving read as changed, a different few on each run. With the
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
  commits, adds your approval of the resulting baselines tree in a second commit when the Finish
  signs, and pushes to the pull request's branch. CI then runs again on that branch.
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
- **The review page** shows each one as a pair, labeled "moved from &lt;old id&gt;" on its row
  and in the viewer, with the old id's baseline on the left. **Show** has a **moved** entry, and a
  group's Accept N takes its moved stories too.
- **Accepting** writes the baseline under the new id and deletes the old id's baseline in the same
  accept commit. For a `moved` item the image is the same, so git sees a rename and the Git LFS
  pointer does not change. The review record names both paths.
- **The gate** blocks a `moved` item until it is accepted, like any change: a pull request that
  moves stories cannot land without their baselines moving with them.
- **A rename whose new id is not a story** in the Storybook is an error: capture reports it as a
  `failed` item under the new id, with the reason. Fix the
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
- One exception: a project whose artifact holds, instead of `results.json`, the file
  `skipped.json` with exactly `{"skipped": "not affected", "project": "<project>"}` passes without
  a capture. A workflow that captures only the Storybooks a pull request can affect writes it for
  the others. The gate accepts it only on a pull request's own run (never with `--queue-event`),
  only for a project with baselines on the base branch, and only when the pull request changes
  none of that project's baselines; anywhere else it counts as a missing capture. Which projects
  are left out is decided by the pull request's own workflow, so the guarantee comes from the
  merge queue, which captures every project before anything merges. The review page shows such a
  project as "no capture".
- A story with no baseline always blocks. `new` and `no baseline yet` only tell the reviewer
  whether the pull request changed it, measured against the default branch's newest complete
  capture, which may be a few merges older than the pull request's base.
- When the pull request's baselines directory differs from the base branch's in any way (a PNG,
  a settings file, `renames.json`, a review record), the pull request must hold your approval of
  exactly its git tree, made at a commit in its own history. A baseline PNG is a Git LFS pointer
  in git, naming the image's SHA-256, so the tree covers every pixel and the gate never downloads
  an image. This stops the shortcut of copying captured PNGs, or a settings file that excludes a
  story or loosens its comparison, straight into the baselines directory.
- A story compared at a `diffThreshold` above 0.8 fails the gate (at 1 nothing ever reads as
  changed), and so does a pull request that moves the baselines or the approvals directory in its
  config.
- **Before a passkey is registered, it does not prove a person reviewed anything.** An approval
  is then a plain JSON file: anyone who can push to the branch can write one that names the tree,
  and the gate cannot tell it from one Finish wrote.
- **Once `visual-review/passkeys.json` on the base branch holds a key**, the approval must carry
  a passkey signature over exactly that statement by one of the base branch's keys, made on an
  HTTPS page on the key's host, with user verification (Face ID, Touch ID or a PIN). Keys are
  read only from the base branch, never from the pull request, a pull request that would leave no
  key fails, and a pull request that changes `visual-review/passkeys.json` fails (see "Replacing
  the passkey"). With change statements, the gate's rule is in [The approval format](docs/approval-format.md).
- **An approval is of a tree, not of a pull request.** An approval made on one branch holds on any
  branch that has its commit in its history and the same baselines tree, such as a branch that
  merged it in. After the default branch's newer baselines are merged into an approved pull
  request, the tree differs and the gate needs a new approval; the new capture must still equal
  the approved baselines either way.
- **It does not prove you looked at every image.** It proves your device approved the tree, and
  Finish signs only when every image that differs from the default branch has your decision. A
  page altered on your machine could ask you to approve something other than what it shows; read
  the counts in Finish's question.
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

See [Troubleshooting](docs/troubleshooting.md) for what a message means and what to do about it.
