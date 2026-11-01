# What each decision does

## Statuses

Every snapshot of a capture has one status:

| Status                   | What it means                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `unchanged`              | The capture is the baseline. Nothing to decide                                                                         |
| `changed`                | The capture differs from its baseline                                                                                  |
| `moved`                  | A renamed story that looks exactly as its old id's baseline (see [renames](../README.md#reorganizing-stories-renames)) |
| `new`                    | No baseline, and on a pull request the story is new or looks different from the default branch's newest capture        |
| `no baseline yet`        | Status `unseeded`: no baseline, and the pull request does not change the story                                         |
| `removed`                | A baseline whose story no longer exists, lost a mode, or whose own parameters now exclude it                           |
| `failed`                 | The story could not be shot (it did not render, or timed out)                                                          |
| `excluded`               | The story is not captured (its settings exclude it)                                                                    |
| `unstable (old capture)` | Only in a capture made by `@graphty/visual-review`: two shots of one commit differed. It can only be excluded          |

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

## How the row pictures show a change

A row picture never has anything drawn over it: the picture is there to show the change, so a label
on it would cover exactly what you need to see. Whether it is zoomed, how far, and to how many of the
changed areas is said in words on the row ("26 areas, 490k px, zoomed 4x to 3 of them"), and a
zoomed picture is marked by a gray bar outside its left edge.

A zoomed picture frames every changed area when that still shows them at least twice as large as
the whole image would. When the areas are spread too far apart for that, it frames the largest group
of areas that lie within one area's height of each other, so a change spread over a page still shows
a change rather than an empty stretch of it. Rows are spotlit by default, with what did not change
dimmed lightly enough that the rest of the story stays readable. These were chosen by looking at the
first 40 rows of a nightly capture of about 1,800 snapshots at the list's widths on a 1440 and a 1024
px screen: plain pictures did not show where the change was, the earlier, darker spotlight turned
many rows into dark slabs, and framing every area left some rows showing a whole page with the
change too small to see.

## What the progress line counts

The Snapshots header says first what is left for you ("34 left"), then, muted, what you decided
and what was accepted before this capture ("12 decided, 1,208 accepted earlier"). The two are kept
apart because images accepted earlier were never looked at in this review: counting them with your
own decisions ("1,220 of 1,254 decided") hid how much of the work was yours. The Finish sheet says
the same split ("Saves 12 you accepted and 1,208 accepted earlier"), and the Show menu offers
**Accepted earlier** apart from **Accepted**.

## Two kinds of printed keys

Every key still has a visible control that prints it, but only the keys of the look-decide-next
loop (the view switch, the decision bar, boxes) are boxed. Every other control prints its key as
quiet muted text after its label, so the dozen keys you press every few seconds stand out from the
ones you press once a session.

## Seven controls on the viewer's toolbar

The toolbar keeps only what you use while looking: the four views, Blink, Zoom, and one **Display**
menu for what you set once a session (show the baseline, image only, layout, outline changed
areas, start zoomed on the change). Each Display item prints its key and the key works with the
menu closed, so no key that took one press before takes two. The view switch shows exactly one
filled button; a setting that is on shows a check mark, never a second filled or ringed style.
Technical details moved off the toolbar to a quiet **Details** at the end of the item line, next to
the facts it explains.

## Y steps the layout

**Y** used to open the Layout menu. A menu opened by a key holds every other key until it closes,
so Y now steps the layout in one press: Auto, Side by side, Over and under. The Display menu's
Layout item still lists the three when clicked or given Enter. Z stays as it was: one press steps
the zoom, and a click on Zoom opens its menu.

## A second Esc does not leave the change

Esc goes back one level, but a reader often presses it twice: once to clear a selection or close a
box, and again by habit. The second press after an Esc that closed or cleared something now says
"Press Esc again to go back to the changes." and stays; the next press goes back. Backspace was
considered as the back key instead and rejected: it does nothing while single-letter keys are off,
it is a common correction key, and on a Mac it is labelled delete.

## One place to decide a selection

The selection bar says how many are selected and offers Clear and its menu; it no longer has its
own Accept, Reject and Exclude. The decision bar decides the selection while the current row is in
it, and says so ("Accept 3"), so there is one place to look for what a decision will do.
