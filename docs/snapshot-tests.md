# Each snapshot as a test in your runner

A snapshot (one story, or one story in one mode) can be a test case in the test runner you already
use. The runner reports it, retries it, and its flaky-test tooling sees each failure the moment the
test ends. proofroom imports no test runner: a test calls `assertSnapshot()`, which throws Node's
own `AssertionError` when the snapshot did not pass, and every runner reports that as a failed test.

## The function

```js
import { assertSnapshot } from "proofroom/compare";

test("checkout page", async ({ page }) => {
    await page.goto("/checkout");
    const image = await page.screenshot({ fullPage: true });
    await assertSnapshot({ project: "app", id: "checkout", image });
});
```

The same lines work in Vitest, Jest, Mocha, `node:test` and Playwright Test (with Jest, run it
with `NODE_OPTIONS=--experimental-vm-modules`, since proofroom is an ES module).

`proofroom/compare` runs in Node and never starts a browser. It exports:

- **`compareSnapshot(options)`** judges one snapshot against its baseline, exactly as `compare`
  judges it, and returns its result line (see [Test results](test-results.md)). It never throws for
  a difference, only when the tool fails: a baseline that is still a Git LFS pointer, an id that
  is not lowercase letters, digits and `-`.
- **`assertSnapshot(options)`** does the same, then throws an `AssertionError` when the snapshot
  did not pass. Its message names the snapshot and its status (`proofroom: app/checkout: changed:
1204 pixels differ`), and its `actual` is the result line.

| Option      | What it is                                                                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project`   | a project of `visual-review.config.json`; its baselines and story settings files are read                                                          |
| `baselines` | a directory of baselines instead, for images outside any config (the project is then `images`)                                                     |
| `root`      | the git checkout whose config names the project (default: the current one)                                                                         |
| `id`        | the snapshot's id; its baseline is `<id>.png`                                                                                                      |
| `mode`      | a mode name: the baseline is `<id>.<mode>.png` (default: none)                                                                                     |
| `image`     | the PNG, as bytes or a path; without one the snapshot is reported as not shot, with `reason`                                                       |
| `settings`  | `{ threshold, includeAA }`: how far a pixel may differ (0 to 1, default 0.063) and whether anti-aliased pixels count, over the story settings file |
| `reference` | the default branch's capture (from `proofroom reference`): a snapshot with no baseline that looks as it does there is "no baseline yet", not "new" |
| `out`       | where the result lines and images go; default `$PROOFROOM_OUT`; without either, nothing is written                                                 |

A second call for the same snapshot in the same run is its next attempt, also when the runner
retries in a new worker process (Playwright Test does): the attempts are counted from the result
lines already in `out`.

## Writing a capture the review page reads

Set `PROOFROOM_OUT` (or pass `out`) to an empty directory for the run. Each process writes its own
`results-<pid>-<thread>.ndjson` there, one line per call, so parallel workers never write to one
file, and the images the review page needs: the capture of every snapshot that did not match, and
the baseline it was compared with. After the run, combine the directories (one per shard or
machine) into one capture:

```sh
PROOFROOM_OUT=tmp/visual npx vitest run
npx proofroom collect --project app --out captures/app tmp/visual
```

`collect` takes the last attempt of each snapshot as its result and the earlier ones as its
`attempts` (`<flakyFailure>` or `<rerunFailure>` in the JUnit file it writes beside
`results.json`); proofroom never calls a snapshot flaky. It refuses a snapshot found in two
directories, then reports every baseline no snapshot drew as removed. `serve` and `gate` read the
result as they read `run`'s.

Run `collect` only once the runner has finished: from result lines alone it cannot tell a run that
stopped early, and every snapshot that did not run would read as removed. `merge-results` is
another name for `collect`, until 1.0.0.

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
    test(story.file, async () => assertSnapshot(await cam.shoot(story)));
}
```

- `stories()` lists every snapshot of the project's Storybook: `{ type, project, id, mode, file,
settings, baselines }`, where `type` is `image` (to shoot) or `excluded` (with `reason`).
- `shoot(story)` shoots it once and returns the same object with `image` (the PNG) and `console`;
  a story that could not be shot has `image: null` and `type: "failed"` with its `reason`, and
  `assertSnapshot()` fails its test; an excluded story comes back as it is and passes as skipped.
- `close()` closes the browser.

`openCapture({ project, root, storybook, baselines, stories })` takes the config's Storybook and
baselines unless `storybook` or `baselines` override them; `stories` keeps only the story ids that
start with one of its prefixes.

## The Vitest adapter for Storybook's story tests

When a Storybook's stories already run as Vitest tests (`@storybook/addon-vitest`), `proofroom/vitest`
and `proofroom/vitest/setup` take each story's screenshot at the end of its own test, after its play
function, and judge it with `compareSnapshot()`. Pass `out` a directory per shard, and `collect`
the shards' directories afterwards; besides the result lines, each run writes a `run-*.json` there
(its shard, the project's story files and those it ran), so `collect` also checks that every shard
is there once and that between them they ran every story file.

```ts
const visual = visualStoryTest({ project: "web", out: "tmp/stories/web-1", fail: "differences", retries: 0 });
```

- **`fail`**: `"differences"` (the default) fails a story test whose snapshot did not pass, as any
  visual test fails. `"errors"` fails it only when the story could not be shot (its play failed,
  it threw while rendering, the project's console rule matched) or the tool failed; a difference
  is recorded for the review page and the test passes. Use `"errors"` where a story test that fails
  on every intended change would turn the test job red before anyone has reviewed the images.
- **`retries`** (default 0, at most 20): a snapshot that did not pass is rendered and shot again
  inside the same story test, up to that many times, each shot one attempt. With `fail: "errors"`
  your runner never retries a difference, so this is how a one-shot flake is absorbed there.

A rerun of the failed story files into the same directory (a quarantine tool's retry) adds its own
result lines and run file: a snapshot it shoots again is simply its next attempt. A new run of a
commit needs an empty directory.
