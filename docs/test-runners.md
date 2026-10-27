# Each snapshot as a test in your runner

A snapshot (one story, or one story in one mode) can be a test case in the test runner you already
use. The runner reports it, retries it, and its flaky-test tooling sees each failure the moment the
test ends. proofroom imports no test runner: a test calls `assertSnapshot()` from
`proofroom/compare`, which throws Node's own `AssertionError` when the snapshot did not pass, and
every runner reports that as a failed test. The same few lines work in every runner; only the way
the runner names a test differs. `image` is the PNG, as bytes or a path, made however you like.

```js
// Vitest
import { test } from "vitest";
import { assertSnapshot } from "proofroom/compare";

test("checkout page", async () => {
    await assertSnapshot({ project: "app", id: "checkout", image: "shots/checkout.png" });
});
```

```js
// Jest (test is a global; run it with NODE_OPTIONS=--experimental-vm-modules, since proofroom is an ES module)
import { assertSnapshot } from "proofroom/compare";

test("checkout page", async () => {
    await assertSnapshot({ project: "app", id: "checkout", image: "shots/checkout.png" });
});
```

```js
// Mocha (it is a global)
import { assertSnapshot } from "proofroom/compare";

it("checkout page", async () => {
    await assertSnapshot({ project: "app", id: "checkout", image: "shots/checkout.png" });
});
```

```js
// node:test
import test from "node:test";
import { assertSnapshot } from "proofroom/compare";

test("checkout page", async () => {
    await assertSnapshot({ project: "app", id: "checkout", image: "shots/checkout.png" });
});
```

```js
// Playwright Test
import { test } from "@playwright/test";
import { assertSnapshot } from "proofroom/compare";

test("checkout page", async ({ page }) => {
    await page.goto("/checkout");
    const image = await page.screenshot({ fullPage: true });
    await assertSnapshot({ project: "app", id: "checkout", image });
});
```

`proofroom/compare` runs in Node and never starts a browser. It exports:

- **`compareSnapshot(options)`** judges one snapshot against its baseline, exactly as `compare`
  judges it, and returns its result line: the snapshot's `results.json` item with `project`,
  `attempt` and `passed`. It never throws for a difference, only when the tool fails: a baseline
  that is still a Git LFS pointer, an id that is not lowercase letters, digits and `-`.
- **`assertSnapshot(options)`** does the same, then throws an `AssertionError` when the snapshot
  did not pass. Its message names the snapshot and its status (`proofroom: app/checkout: changed:
1204 pixels differ`), and its `actual` is the result line.

| Option      | What it is                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project`   | a project of `visual-review.config.json`; its baselines and story settings files are read                                                                     |
| `baselines` | a directory of baselines instead, for images outside any config (the project is then `images`)                                                                |
| `root`      | the git checkout whose config names the project (default: the current one)                                                                                    |
| `id`        | the snapshot's id; its baseline is `<id>.png`                                                                                                                 |
| `mode`      | a mode name: the baseline is `<id>.<mode>.png` (default: none)                                                                                                |
| `image`     | the PNG, as bytes or a path; without one the snapshot is reported as not shot, with `reason`                                                                  |
| `settings`  | `{ threshold, includeAA }`: how far a pixel may differ (0 to 1, default 0.063) and whether anti-aliased pixels count, where the story settings file sets none |
| `reference` | the default branch's capture (from `proofroom reference`): a snapshot with no baseline that looks as it does there is "no baseline yet", not "new"            |
| `out`       | where the result lines and images go; default `$PROOFROOM_OUT`; without either, nothing is written                                                            |

A second call for the same snapshot in the same run is its next attempt, also when the runner
retries in a new worker process (Playwright Test does): the attempts are counted from the result
lines already in `out`. A setting in a story's settings file (`<id>.json` beside its baseline) is
part of the approved baselines, so it always wins over `settings`, and its `disableSnapshot` always
applies.

## Writing a capture the review page reads

Set `PROOFROOM_OUT` (or pass `out`) to an empty directory for the run. Each process writes its own
`results-<pid>-<thread>.ndjson` there, one line per call, so parallel workers never write to one
file, and the images the review page needs: the capture of every snapshot that did not match, and
the baseline it was compared with. After the run, combine the directories (one per shard or
machine) into one capture:

```sh
PROOFROOM_OUT=tmp/visual npx vitest run
npx proofroom collect --project app --out captures/app --whole tmp/visual
```

`collect` takes the last attempt of each snapshot as its result and the earlier ones as its
`attempts` (`<flakyFailure>` or `<rerunFailure>` in the JUnit file it writes beside
`results.json`); proofroom never calls a snapshot flaky. It refuses a snapshot found in two
directories, then reports every baseline no snapshot drew as removed. `serve` and `gate` read the
result as they read `run`'s.

From result lines alone `collect` cannot tell a whole run from one that stopped early or ran only
some tests (`-t`, a filtered file), and in such a run every snapshot that did not run would read
as removed. So it writes the capture incomplete, which `gate` refuses, unless you pass `--whole`:
your word that the runner finished and ran every snapshot. Runs through `openCapture()` (below)
and the Vitest adapter need no `--whole`: they leave a record `collect` checks.

## Retries

Use your runner's own retry (`--retry` in Vitest, `jest.retryTimes()`, `--retries` in Mocha and
Playwright Test). Each call is one attempt: a snapshot that differs once and then matches passes,
with its first attempt kept beside it. Keep the retries for visual tests low: a real change fails
every attempt, and each attempt costs one more screenshot, in every worker.

## A Storybook, one test per snapshot

`openCapture()` from `proofroom/capture` shoots a built Storybook the way `capture` does (a fresh
browser context per shot, the fixed clock, the pinned fonts), but lets your runner drive the order:

```js
import { openCapture } from "proofroom/capture";
import { assertSnapshot } from "proofroom/compare";
import { afterAll, test } from "vitest";

const cam = openCapture({ project: "web" });
afterAll(() => cam.close());

for (const story of await cam.stories()) {
    test(story.file, async () => assertSnapshot({ ...story, image: await cam.shoot(story) }));
}
```

In another runner, use its own after-all hook (`after` in Mocha and `node:test`, `test.afterAll`
in Playwright Test).

- `stories()` lists every snapshot of the project's Storybook: `{ type, project, id, mode, file,
settings, baselines }`, where `type` is `image` (to shoot) or `excluded` (with `reason`).
- `shoot(story)` shoots it once and returns the same object with `image` (the PNG) and `console`;
  a story that could not be shot has `image: null` and `type: "failed"` with its `reason`, and
  `assertSnapshot()` fails its test; an excluded story comes back as it is and passes as skipped.
- `close()` closes the browser.
- `assertSnapshot()` takes the shot as `image` (as above) or as its options
  (`assertSnapshot(await cam.shoot(story))`).

With `PROOFROOM_OUT` set (or `out` passed to `openCapture()`), `stories()` writes there the list of
snapshots it gave you, and `close()` marks it finished. `collect` then refuses the directory while a
listed snapshot has no result (a run stopped early, or `-t` ran only some tests) or `close()` never
ran. With a `stories` filter, it reports no baseline removed: those of the stories the filter left
out are not judged.

`openCapture({ project, root, storybook, baselines, stories, out })` takes the config's Storybook and
baselines unless `storybook` or `baselines` override them; `stories` keeps only the story ids that
start with one of its prefixes.

## Taking the screenshots inside the story tests

A Storybook project whose stories already run as Vitest tests (`@storybook/addon-vitest`) can take
each story's screenshot at the end of its own test instead of rendering every story again from a
built Storybook. The pictures, the comparison and the results are the same as `capture`'s, so
`serve` and `gate` read them unchanged.

```ts
// vitest.config.ts: the storybook project
import { PRODUCTION, visualStoryTest } from "proofroom/vitest";

const visual = visualStoryTest({ project: "web", out: "tmp/stories/web" });

export default defineConfig({
    test: {
        reporters: ["default", visual.reporter],
        projects: [
            {
                ...PRODUCTION, // as capture: production mode and NODE_ENV, a 404 for a missing file
                plugins: [storybookTest({ configDir: ".storybook" })],
                test: {
                    name: "storybook",
                    browser: {
                        enabled: true,
                        provider: playwright(visual.providerOptions),
                        instances: [{ browser: "chromium" }],
                        viewport: visual.viewport,
                        commands: visual.commands,
                    },
                    setupFiles: [".storybook/vitest.setup.visual.ts", ".storybook/vitest.setup.ts"],
                },
            },
        ],
    },
});
```

```ts
// .storybook/vitest.setup.visual.ts
import { afterEach, beforeEach } from "vitest";
import { commands } from "vitest/browser";
import { installVisualStoryTest } from "proofroom/vitest/setup";

installVisualStoryTest({ afterEach, beforeEach, commands });
```

The visual step runs after the story's play function and judges the shot with `compareSnapshot()`
(see above). Each run
writes its result lines into `out`, with the images the review page needs and a `run-*.json` (its
shard, the project's story files and those it ran). Pass `out` an empty directory per shard (`vitest
run --shard=1/3`, each into its own directory), then collect the shards into the capture the review
page and the gate read:

```bash
npx proofroom collect --project web --out captures/web tmp/stories/web-1 tmp/stories/web-2 tmp/stories/web-3
```

It is complete only when every shard is there once, the shards between them ran every story file of
the project (a run of some files, or a file that failed to load, leaves it incomplete) and each
reported every story test it ran; a baseline no story drew is reported removed.

`visualStoryTest()` takes two options that decide what fails a story test:

```ts
const visual = visualStoryTest({ project: "web", out: "tmp/stories/web-1", fail: "differences", retries: 0 });
```

- **`fail`**: `"differences"` (the default) fails a story test whose snapshot did not pass, as any
  visual test fails: a changed or new picture fails its test and waits for review. `"errors"` fails
  it only when the story could not be shot (its play failed, it threw while rendering, the
  project's `waitFor` console rule matched) or the tool failed; a difference is recorded for the
  review page and the test passes. Use `"errors"` where a story test that fails on every intended
  change would turn the test job red before anyone has reviewed the images.
- **`retries`** (default 0, at most 20): a snapshot that did not pass is rendered and shot again
  inside the same story test, up to that many times, each shot one attempt. With `fail: "errors"`
  your runner never retries a difference, so this is how a one-shot flake is absorbed there. Keep
  it low: a real change fails every attempt.

A rerun of the failed story files into the same directory (your runner's or a quarantine tool's
retry) adds its own result lines and run file: a snapshot it shoots again is simply its next
attempt, and `collect` takes the last one as its result. A new run of a commit needs an empty
directory.

A story test renders each story several times in one page -- once for the test, again for each
mode, and again for each retry the adapter's `retries` option allows -- where `capture` gives every render a fresh page. So a story
must draw the same picture however often it is rendered: state its play changes (a store, a module
variable, a registry keyed by it) is made anew for each render, in a loader, never once when the
story file loads. Between renders the page's local and session storage are cleared, every IndexedDB
store is emptied (its database kept, so a connection the page still holds never blocks it) and the
clock starts again at 2026-01-01T12:00:00Z.

The story tests' server answers a path that is no file with a 404, as `capture`'s static server does
(spread `PRODUCTION` into the project's config), so a story that fetches a missing file is refused in
both.

A story taller or wider than the 1200 x 900 viewport is shot in viewport-sized tiles: the test's
frame keeps the viewport's size (so `vh` units and a layout centered in the window draw as in
`capture`'s full-page shot), its document is scrolled to each tile, elements with `position: fixed`
are pinned where they are first, and the stitched picture is encoded by Chromium's own screenshot,
as `capture`'s is.
