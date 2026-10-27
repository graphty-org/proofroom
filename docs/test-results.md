# Test results (JUnit and result lines)

proofroom reports the result of every snapshot (one story, or one story in one mode) in two forms
that other tools read: a JUnit XML file, the test report CI systems, test-report actions and
flaky-test tools understand, and result lines, one JSON line per snapshot.

## The rule

A snapshot passes exactly when its capture is the approved baseline (status `unchanged`).

A result line's `passed` is `true` when the snapshot did not fail, so an excluded snapshot, which
JUnit reports as skipped, is `true` there too.

| Status                                             | In JUnit                                                                                      | `passed`               |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------- |
| `unchanged`                                        | passed                                                                                        | `true`                 |
| `changed`                                          | `<failure type="changed">`, with the number of pixels that differ                             | `false`                |
| `moved` (a renamed story whose image is unchanged) | `<failure type="moved">`, "moved from" and the old story id: the rename still needs an Accept | `false`                |
| `new`                                              | `<failure type="new">`                                                                        | `false`                |
| `unseeded` (no baseline yet)                       | `<failure type="unseeded">`                                                                   | `false`                |
| `removed` (a baseline no story drew)               | `<failure type="removed">`                                                                    | `false`                |
| `failed` (the story could not be shot)             | `<error type="failed">`, with its reason as the message and its console as the text           | `false`                |
| `excluded`                                         | `<skipped>`, with the reason                                                                  | `true` (not a failure) |

Captures made by older versions can hold `unstable` items; they are failures of type `unstable`.

## The JUnit file

```sh
proofroom junit --results <capture dir> --out junit.xml
```

reads the capture's `results.json` (`--results` can also name the file itself) and writes one
`<testsuite>` named after the project, with one `<testcase>` per snapshot: its `name` is the
snapshot's image file without `.png` (`button--primary.dark`), its `classname` the project. The
command exits 0 once the file is written, whatever the snapshots' results, and 2 when
`results.json` is missing or invalid.

When a snapshot was shot more than once in the run, its earlier attempts are written inside its
test case, as Maven Surefire does: `<flakyFailure>` or `<flakyError>` when the last attempt passed,
`<rerunFailure>` or `<rerunError>` when it did not. proofroom itself never calls a snapshot flaky;
the tool that reads the file decides what to make of the attempts.

`proofroom run` and `proofroom compare` write the same file themselves when they finish, as
`junit.xml` beside `results.json` (`--junit <file>` puts it elsewhere), so the workflow
`proofroom init` writes has it inside the capture's artifact, `visual-<project>-<attempt>`. Hand
it to your test-report step from there. `proofroom junit` makes it again from any capture's
`results.json`.

Before wiring the file into a flaky-test tool, check that tool's settings: one that quarantines a
failing test on its own would quarantine a story whose change is real and waiting for review.

## Result lines

A result line is one item of `results.json` (the same fields, checked the same way) plus three
more:

- `project`: the project the snapshot belongs to.
- `attempt`: 1 for the snapshot's first shot in the run, 2 for the next, and so on.
- `passed`: `true` when the snapshot did not fail: it passed, or it was excluded (skipped). Read
  `status` to tell the two apart.

```json
{
    "id": "button--primary",
    "mode": "dark",
    "file": "button--primary.dark.png",
    "status": "changed",
    "flaky": false,
    "baseline": "<sha256>",
    "capture": "<sha256>",
    "size": [1200, 900],
    "baselineSize": [1200, 900],
    "changedPixels": 412,
    "bbox": [10, 20, 90, 44],
    "threshold": 0.063,
    "includeAA": false,
    "reason": null,
    "console": [],
    "project": "app",
    "attempt": 1,
    "passed": false
}
```

`proofroom run` and `proofroom compare` print one result line on standard output the moment each
snapshot is judged, and append it to `results.ndjson` beside `results.json`. The last attempt of
each snapshot is its result; earlier lines for the same snapshot are its earlier attempts.

## Fields of results.json other tools may meet

Besides the fields every capture has, an item can carry:

- `areas`: the changed areas, each `[x, y, width, height]` in image pixels, largest first.
- `pictures`: the list pictures `run` made for the item, as `{ "<kind>": "<file>.webp" }`, beside
  the images. The kinds are `plain` (the new image, or a removed snapshot's baseline), and for a
  changed pair also `spot` (spotlit), `zoom` and `both` (zoomed toward the change, plain and
  spotlit), and `row-plain` and `row-spot` (cropped to the largest change, at the list row's shape).
- `attempts`: the earlier attempts of the run, oldest first, each `{ status, capture, changedPixels,
reason, console }` (and `from` for a renamed story).

and the file can name the browser that drew the images, `renderer: { name, version }`, and the one
that drew the reference capture compare was given, `baselineRenderer`, in the same form. All of them
are optional: a reader must work without them. `flaky` is always written, and always `false`:
proofroom shoots each snapshot once per attempt and never calls one flaky. Captures made by older
versions, which shot a story twice when it differed, can hold `true` there.
