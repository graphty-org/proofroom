# What each decision does

## Statuses

Every snapshot of a capture has one status:

| Status                     | What it means                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `unchanged`                | The capture is the baseline. Nothing to decide                                                                       |
| `changed`                  | The capture differs from its baseline                                                                                |
| `moved`                    | A renamed story that looks exactly as its old id's baseline (see [renames](../README.md#reorganizing-stories-renames)) |
| `new`                      | No baseline, and on a pull request the story is new or looks different from the default branch's newest capture     |
| `no baseline yet`          | Status `unseeded`: no baseline, and the pull request does not change the story                                       |
| `removed`                  | A baseline whose story no longer exists, lost a mode, or whose own parameters now exclude it                         |
| `failed`                   | The story could not be shot (it did not render, or timed out)                                                        |
| `excluded`                 | The story is not captured (its settings exclude it)                                                                  |
| `unstable (old capture)`   | Only in a capture made by `@graphty/visual-review`: two shots of one commit differed. It can only be excluded        |

`new` and `no baseline yet` block the pull request alike: they need a decision, and accepting one
makes its capture the story's first baseline.

## Against the default branch

A capture compares each story with the baseline on the change's own branch. A branch can already
hold baselines that differ from the default branch's: an earlier Finish on it, or a branch merged
into it whose images you approved elsewhere. Your approval covers every baseline the branch holds,
so the page compares those too: an image the capture shows exactly as the branch's baseline, but
which differs from the default branch's, is listed as `changed` against the default branch's image
(`new` where the default branch has none), and a baseline the branch deleted is listed as
`removed`. You decide them like any other change. A decision you already took on the same image of
the same story carries over, and an image you approved on another pull request reads "approved
before".

## The decisions

- **Accept [A]**: the new image becomes the baseline (for `removed`, the baseline is deleted).
  Allowed on `changed`, `moved`, `new`, `no baseline yet` and `removed`. For a renamed story the
  baseline is written under the new id and the old id's baseline is deleted, in the same commit.
- **Reject... [R]**: the difference is a regression. It needs a reason, which Finish posts to the
  pull request as a comment with a machine-readable block an agent can read. The pull request stays
  blocked until its code changes so the capture matches the baseline again.
- **Exclude... [E]**: stops capturing the story. It needs a reason, and asks once more because it
  is wide: it writes `<baselines>/<project>/<story id>.json` with `disableSnapshot: true`, which
  drops **every mode of the story**, on every later change, until that file is deleted. It is the
  only decision for a `failed` snapshot; for a one-off failure (a timeout on a busy runner), capture
  again instead.
- **Undo [U]** reverses the last decision, single or bulk, in one step. Each decided row has its own
  Undo, a group header **Undo N**, and the list's menu **Undo all decisions...** (both ask first).
  It is the only way to change a decision: A, R and E on a decided snapshot say so and do nothing.

Decisions are kept on the server, in the work directory's `state/` (the config's `workDir`), not in
the repository, so they survive a restart and a reload. A decision applies only to the image it was
taken on: when a new capture shows that snapshot differently, it is undecided again (the old
decision stays saved, and comes back if the image does).

After Finish, what it published stays shown as finished, and Finish does not publish it twice.
Accepts and exclusions read "Finished" until a new capture replaces them (the accepted snapshots
are then `unchanged`, the excluded ones not captured); a finished accept has no Undo. Rejects still
show as rejected on the next capture while the image is unchanged.
