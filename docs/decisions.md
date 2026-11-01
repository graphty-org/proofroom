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

## No empty viewer before a change is open

The page used to open in three columns: the changes, a middle Change pane summarizing the current
one, and an empty viewer saying "Choose a change on the left". The middle pane is gone. With no
change open the page is the changes and, in the viewer's place, the summary of the current change
with **Open [Enter]**, so the first screen says what Enter would open and nothing is empty.

## A quieter top bar

The top bar keeps what you need at any moment: the tabs, **Next change Shift+N** (its one home,
left of Finish, instead of the Changes header and the Snapshots title line), Keys, Settings and
Finish. **New capture...** moved to the Captures screen, where captures are. The data's age and
**Refresh** show only when the data is more than 5 minutes old or the server is not answering:
"Updated 40 s ago" said nothing worth reading. **Finish review...** carries no number (the
Snapshots title already names the change) and no count;
it is outlined in the primary color while snapshots are left and filled once none is, never the
grey of an unavailable button, so it reads as the way out from the first minute.

## Messages clear themselves on the next action

A message used to stay until another replaced it, so an old "Sorted: Author." could sit under a
new state. Now a plain message clears on your next action. A message with a button (Undo, Retry,
Load it) stays until you use it, press Dismiss, or another message replaces it, so a button is
never taken away while you might still want it. Nothing clears on a timer.

## The Finish sheet in three lines

The sheet is titled with the change's number, its title muted below, then three lines: what it
saves ("Saves 12 you accepted and 1,208 accepted earlier to <branch>, as <name>."), what is still
left ("34 left: they will block the merge", with Go to the first), and the check it sets ("GitHub
check: Reviewed"), then, right above the confirm button, who signs ("Signs with: Passkey '...'",
or why nothing is signed): the reader confirms knowing which passkey will be asked for. What it
posts, the full commit status, the signing progress and the shell command are under one closed
**Details**. The steps Finish takes did not change.

## Settings: your choices first

Settings lists what you choose, in the order you are likely to want it: Theme, Highlight color,
Single-letter keys, Passkeys and Picture storage. The adapters table, which only says how the
repository is set up, is under **Repository setup**: closed while nothing there is wrong, and
open with its summary naming the first problem in plain words ("Repository setup: CI takes no
capture requests", "+1 more" when there are more) when something is, so the reason is read
without hunting for it.

## Each count said once in the list

A group header used to say its size twice, "legend (14)" and **Accept 14**, on every group at
once, so a list of twenty groups showed forty numbers. Now the header names the group and the count
is said once, in **Accept 14**, which shows always on the current snapshot's group (green, with
Shift+A) and on the other groups only while their header is hovered or focused. Hiding it there
costs no capability: it is also the first item of the group's actions menu, opened by the name,
which draws a small caret and underlines on hover so it reads as a button. Group names are cut
keeping their end, because sibling groups usually share their start and differ at the end.

## Rails read across

The rails used to print the pane's name turned on its side and the key stacked "Shift" over "1".
At 56 px wide a rail now reads top down without turning the head: the badge ("7 / left"), the name
at 11 px ("Changes", "Snaps") and the key on one quiet line ("Shift+1").

## One view at a time

Flash used to switch on over Spotlight as a second toggle, so two buttons in the view switch could
look pressed and the reader had to work out which images were flashing. Now Flash is a view like
the other three: exactly one view button is filled and none carries a check mark. F from Spotlight
switches to Flash and flashes the spotlit pair, and the panel labels say so ("Baseline (flashing,
spotlit)"); V, H or S leaves Flash, so S after H is plain Spotlight. Blink, which only works in
Highlight, is drawn only in Highlight instead of sitting greyed out beside the other views.

## Zoom shows the same place in both panes

A zoom step used to center each pane on the area in its own image, so on a resized snapshot the
baseline pane showed a different place, often grey. Every zoom step now centers on the current
changed area in the new image and maps that point into the baseline the way the comparison lines
the two images up: by their top left corners. Both panes show the same place. When that place lies
outside the smaller image, its panel label says "Baseline (outside this image)" instead of showing
an empty grey box.

## Previous, Next and Undo never lose their words

On a narrow window the decision bar used to drop the words of Previous, Next and Undo below a fixed
760 px and keep only their key boxes, so a laptop reader saw a row of letters. Every word now stays
at every width, a 1024 x 768 laptop included. If the bar is ever too narrow, the quiet Left and
Right after J and K shorten to `<-` and `->`, and then the bar takes a compact size; no button
loses its name.

## The zoom named is the zoom drawn

After V and a digit key the toolbar said "Zoom: 4x" for about a quarter second while the panes
still showed the old pictures at Fit, until the new view's pictures were made. The pictures on
screen now take the new zoom at once, centered on the current area, so the toolbar and the pixels
always agree; the new view's pictures replace them when ready.

## Hiding the baseline is said where it shows

P used to take the Baseline panel away with nothing on screen saying so. With the baseline hidden,
the remaining panel's label starts with a quiet **Show baseline P** and the Display button reads
**Display: baseline hidden**; both go when P shows it again. Panels are always named "Baseline"
and "New", in every view ("Spotlit new" is gone: the view switch already says Spotlight).

## Open on the item line at every width

**Open Enter** used to show on the item line only under 1400 px, where a large change has a
separate viewing level, so the same snapshot had the button at 1280 and not at 1440. It now shows
on a large change whenever its list is shown beside the viewer, at every width, and does the same
thing everywhere: it folds the list to its rail (under 1400 px, that is the viewing level).

## The story name is never cut short on the item line

At 1024 px the item line cut a story name to "i...". Now the badges other than "unstable" and
"resized" go first, then the name is cut in the middle, never below 24 characters, and if it still
does not fit the item line wraps to a second line.
