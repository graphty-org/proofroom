# Capture and compare

proofroom has two tools that also work apart:

- **`capture`** makes images. It screenshots every story of a built Storybook, once per snapshot (a
  story, or a story in one mode), and judges nothing.
- **`compare`** judges images against the baselines in git. The images can come from `capture` or
  from any other tool: a Playwright test, another screenshot tool.

**`run`** does both in one process, which is what CI and local previews use: each snapshot is
judged the moment its image is taken.

Each snapshot's result is reported as soon as it is known, as one JSON line on standard output (a
result line, see [Test results](test-results.md)). When the whole capture is judged, compare
writes `results.json`, which the review page and the gate read, and a JUnit file.

## `run`

```sh
proofroom run --project web --out .visual-review/web
```

builds nothing: build the Storybook first (the project's `build` command in
`visual-review.config.json`). Into `--out` it writes:

| File              | What it is                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `<story>.png`     | the capture of every snapshot that needs review: changed, moved, new and no baseline yet |
| `baselines/*.png` | the baseline each changed and removed snapshot was compared with                         |
| `<story>.*.webp`  | the review list's pictures of every snapshot that needs review (see below)               |
| `capture.ndjson`  | one capture line per snapshot, as capture wrote them                                     |
| `results.ndjson`  | one result line per snapshot and attempt, as each was judged                             |
| `results.json`    | every snapshot's result, written once at the end                                         |
| `junit.xml`       | the same results as a JUnit file (`--junit <file>` puts it elsewhere)                    |

Options: `--storybook`, `--baselines` and `--workers` override the config; `--reference <dir>`
names the default branch's newest capture (from `proofroom reference`), so a story with no baseline
that looks as it does there is "no baseline yet" rather than "new"; `--stories <prefix,...>` shoots
only the story ids starting with a prefix, for a quick look (then no baseline is reported removed).

`run` also makes the pictures the review page's list shows for each snapshot that needs review:
for a changed snapshot the new image whole and spotlit (everything but the change dimmed), each
also zoomed to the change, and for any other the new image (or, when removed, the baseline). They
are WebP files, encoded by the same Chromium that took the captures, named in each item's
`pictures`. The review server shows them as they are, so a capture made by `run` opens with every
picture ready; for images judged by `compare` alone, the server makes the pictures itself.

`run` keeps only the images that need review, so `compare` on its directory reports every other
snapshot `failed`, with the missing image as the reason. To judge a capture again later, run
`capture` and `compare` instead.

### Retries

```sh
proofroom run --project web --out .visual-review/web --retries 1
```

Every snapshot is shot once. Without retries, a story that draws differently from one render to
the next (an animation that was not stopped, a font that arrived late) shows as changed. With
`--retries N` (at most 20), a snapshot that did not pass is shot again, up to N times. Each shot is one attempt:
the last attempt is the snapshot's result, and the earlier ones are kept with it (`attempts` in
`results.json`, `<flakyFailure>` or `<rerunFailure>` in the JUnit file). proofroom never calls a
snapshot flaky; a flaky-test tool reading the JUnit file can. Keep N low: a real change fails every
attempt, and each attempt costs one more shot.

To have your own test runner report and retry each snapshot instead, see
[Each snapshot as a test in your runner](../README.md#each-snapshot-as-a-test-in-your-runner).

## `capture`

```sh
proofroom capture --project web --out captures/web
```

writes each image into `--out` as it is taken, and one line per snapshot into
`captures/web/capture.ndjson` the moment its image is on disk. `--ndjson` also prints each line on
standard output. It reads the story settings files beside the baselines, never a baseline image.

A capture line is one JSON object:

- The first line has `type: "start"`: the commit, the browser and the machine the capture ran on,
  and every story id of the Storybook. `renderer` names the browser that drew the images, such as
  `{ "name": "Chromium", "version": "131.0.6778.33" }`.
- Then one line per snapshot, with `id`, `mode`, `file`, `sha256` and `size` of the image,
  `settings` (the threshold, the anti-aliasing switch and the delay it used) and the story's
  `console`. Its `type` is `image`, `failed` (with `reason`: the story could not be shot) or
  `excluded` (with `reason`, and `byStory: true` when the story's own parameters exclude it).
- The last line has `type: "end"` and `complete: true` once every planned snapshot was shot.

A story that fails to render is reported `failed`, not shot again behind your back. `capture` exits
0 once every story was shot, whatever the images show.

## `compare`

On a capture:

```sh
proofroom compare --project web --captures captures/web
```

reads `captures/web/capture.ndjson` and the images beside it, and writes the results into
`--out` (default: the captures directory).

As a pipeline, judging each snapshot while the capture is still running:

```sh
proofroom capture --project web --out captures/web --ndjson \
  | proofroom compare --project web --captures captures/web --stdin
```

On images any tool made, with no config at all:

```sh
proofroom compare --baselines baselines/ --captures screenshots/
```

matches every PNG in `screenshots/` to the baseline of the same file name (`<story id>.png` or
`<story id>.<mode>.png`; other names are skipped), using `--threshold <0..1>` (default 0.063) and
`--include-aa`. A baseline with no screenshot is reported removed. The results are named after the
project `images`. Run it inside a git checkout: `results.json` records the commit.

Each changed snapshot's result carries its changed areas (`areas`). `results.json` keeps the
capture's `renderer`, and, given `--reference`, that capture's renderer as `baselineRenderer`: the
browser the default branch's captures, and so its baselines, were drawn with. When the two differ,
the review page says so before it shows any change (see
[The renderer banner](new-page.md#the-renderer-banner)).

Options: `--reference <dir>` as for `run`; `--id <id>[.<mode>],...` judges only those snapshots,
and then writes no `results.json` or JUnit file and reports no removed baseline; `--junit <file>`.

## Exit codes

| Command          | 0                     | 1                  | 2               |
| ---------------- | --------------------- | ------------------ | --------------- |
| `run`, `compare` | every snapshot passed | a snapshot did not | the tool failed |
| `capture`        | every story was shot  |                    | the tool failed |

A snapshot passes when its capture is the approved baseline; an excluded one counts as passed. A
baseline that is still a Git LFS pointer (run `git lfs pull`) is a failure of the tool. `--no-fail`
makes `run` and `compare` exit 0 when a snapshot did not pass, and 2 still when the tool failed.

## In the GitHub Actions workflows

The workflow `proofroom init` writes runs `proofroom run` in each project's capture job, with the
default branch's newest capture as `--reference`. Its step fails when a snapshot did not pass; the
job carries on, uploads everything `run` wrote as the artifact `visual-<project>-<attempt>`, and
the "Visual gate" job decides whether the pull request may merge. To absorb a story that differs on
one shot, add `--retries 1` to the step. The seed workflow runs `proofroom run --no-fail`, since an
older commit's stories differ from today's baselines by design.

Since `run` makes the list's pictures in the capture job, the artifact carries them (a few KB per
picture), and the review server makes none for a pull request's captures: its list shows every
picture as soon as the artifact is downloaded.
