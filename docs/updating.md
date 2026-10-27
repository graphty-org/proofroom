# Updating a change from the default branch

`proofroom update <pull request number>`, or Update from on the review page, merges the default
branch into the change's branch with a merge commit (never a rebase, so the commits a Finish made
stay as they were) and pushes it. CI then captures the change again against the default branch's
baselines.

A change whose baselines do not conflict with the default branch needs no update for its
approvals: they stay valid when the default branch moves. Update is for a branch that conflicts
with the default branch under the baselines folder, or for a fresh capture.

## How conflicts are resolved

The default branch is the truth: what it holds was already approved there. For each file under
the baselines folder that conflicts:

| The conflict                                            | What the merge keeps                                                                                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Both sides changed a baseline image                     | The default branch's image                                                                                                                                                                             |
| One side deleted a baseline image, the other changed it | The default branch's side: kept if it has it, deleted if it deleted it                                                                                                                                 |
| Both sides changed a story settings file                | The default branch's file                                                                                                                                                                              |
| Both sides changed a project's `renames.json`           | Both lists of pairs merged: every pair of the default branch's, then the change's pairs for old ids the default branch does not rename. When both name the same old id, the default branch's pair wins |

A conflict anywhere outside the baselines folder stops the update: nothing is committed or
pushed, and the message lists the files to merge by hand. Approval files never conflict: each has
a unique name.

The update accepts nothing. A snapshot whose baseline took the default branch's side is decided
again only if the change still draws it differently.

## What it reports

Before CI runs, the update compares the default branch's image of each conflicting snapshot with
the change's last capture:

```
proofroom update: pushed 3f9a1c0b... to feature/toolbar
  took main's side: visual-baselines/app/button--primary.dark.png
  ...
2 snapshots match main now and need nothing; 3 need a decision again:
  visual-baselines/app/toolbar--compact.png
  visual-baselines/app/toolbar--wide.png
  visual-baselines/app/menu--open.png
```

- **Match**: the change's last capture already is the default branch's image. Once CI captures
  again, the snapshot is unchanged and needs nothing.
- **Need a decision again**: the change draws it differently (or did not capture it). CI's new
  capture shows it as changed against the default branch's image; decide it and Finish.
- **No capture to compare with**: the change has no capture yet (CI never ran on its head, or its
  capture could not be read). CI's new capture shows which of these need a decision.

The command line downloads the last capture from the CI run on the change's head, into the same
folder the review server keeps captures in. On the review page the report goes to the server's
log.
