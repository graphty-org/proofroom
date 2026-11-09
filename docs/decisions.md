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

## Row pictures show the change, and the spotlight only where it helps

At a row's size most pictures were dim Spotlight grey: the spotlight dimmed everything outside the
changed areas even when those areas were most of the picture, and an image narrower than the row
sat on grey bands. A row picture is now spotlit only when the changed areas cover less than a third
of the part of the image it shows; otherwise it is the plain new image. The row crop stays inside
the new image (never the padding a larger baseline adds), and an image narrower than the crop at
the row's shape is shown at its own width, centered on the row's own background, not zoomed
further. The row says "66 changed areas" right under the story's name; how far a picture is zoomed
is in its tooltip, its pixel size in Details.

Checked by eye on a nightly candidate of about 1,800 changed screenshots, the first 40 rows of its
first change at 1440 x 900 and 1024 x 768, row by row: the change could be seen on 26 of 40 rows
before and on 30 of 40 after, at both widths. The 4 gained are whole-image rows of a graph whose
change covers most of the picture, which the spotlight had dimmed; the 8 rows of a large graph
change read far more clearly, plain. The 10 still hard to read are whole-image pictures of a full
page where the change is a few thin lines: their changed areas cover little, so they stay spotlit,
and at the row's size the lines are a few pixels.

## Every changed row is a crop of the change, at most 400 x 156 CSS pixels of the page

Most rows still showed the whole page shrunk into the frame. The captures are 2,400 px wide and up to
15,618 px tall, and on a resized page everything under the first change moved, so the largest
changed area runs from there to the bottom. The old rule zoomed only when the crop showed the change
twice as large as the whole image, and clamped a page-long area to the whole page: 3,517 of the
5,636 rows the server had made were the whole image or under 2x.

Now a changed row is always a crop that fills the row's shape and holds at most 400 x 156 CSS pixels
of the page (image pixels = CSS pixels x the capture's scale), small enough that 14 px text stays
readable at the row's size on a 2x screen. It frames every changed area when they fit; else the
largest group of areas close together; else (since the fifth pass) the crop of that size holding
the most changed pixels, never the blank strip a size change adds or removes. Before, it put the
largest area's first changed pixel a quarter in from the crop's top-left, which on a resized page
framed an unchanged-looking header while the change sat lower. When the only change is the strip a size change adds or removes, the crop
is centered and the row reads "Only the size changed: 2 px shorter". The List menu's Pictures are
Crop to the change (the default), Whole image and Text only, plus Mark the change (named Spotlight
small changes until the fifth pass: it now tints the changed pixels red where most of the picture
changed, as Highlight does, instead of showing it plain); a stored
When small or Always reads as the crop, Never as Whole image. The gray crop bar is gone: every
changed row is a crop, so it marked nothing.

Checked on change #4455 of the studio server, the first 40 rows of graph-io-fidelity (resized
pages) and the first 40 of graphty (same-size pages), each at 1440 x 900 and 1024 x 768, light and
dark, on a 2x screen, judged row by row:

- graph-io-fidelity: all 40 rows are crops where the largest change starts, and the change can be
  read in 40 of 40 (tables of pass counts, shifted labels, node grids); before, these rows showed
  the whole page shrunk to about 40 x 60 px in the middle of the frame.
- graphty: 38 changed rows (16 cropped where the largest change starts, 22 to the largest group of
  areas) and 2 new or removed rows shown whole. The change can be seen in 31 of the 38. The 7 where
  it cannot are six style-panel crops ("Shaders", "Edges: not styled") whose change is a 1 px border
  line, and one menu crop beside a flat gray block; their pictures are readable, the change in them is too thin to see.
- The row pictures are the same at both widths and in both themes (one picture per row), so the
  counts are the same in all four. No changed row has a band beside its picture wider than 3 CSS px
  (the slot is 2.61:1, the crop 2.56:1); only the two whole-image new and removed rows do.

## Row pictures are always Spotlight (owner, 2026-11-09)

"i never asked for tint. always spotlight." Every row picture is spotlit, at every size of change;
none is tinted red. This supersedes the two sections below and the tint rules of the design
document's fifth and sixth passes (10.2, 11.1): tinting every row (4ec4c00) was reverted
(4306921), and the one-third rule (55ee338, kept by 74b0bb6) still tinted mostly-changed rows, for
example `selected-at-rest`, whose changed areas cover 36% of its crop. Picture version 8.

## Every changed row tinted: checked row by row (superseded)

Since the sixth pass a changed row's picture tints its changed pixels red at every size of change
(Spotlight stays a viewer view). Checked on the studio server at commit 83a8b0b (picture version
6), at 1440 x 900 on a 2x screen, light and dark, each row beside the same snapshot's Highlight at
Fit and, for the small changes, at 4x on the first changed area (at Fit a change of a few pixels is
under one screen pixel). A row is "yes" when it shows what changed (the glyphs, the edge, the
border that differs), not only where. Light and dark rows show the same picture (the same file),
so each verdict holds for both.

Small changes on same-size pages (changed areas under a third of the crop): 19 of 20 yes, light
and dark. Change #5420, named for this check, had left the candidate, so the rows come from #1998
(15) and #1677 (5), the two changes with such rows:

| Row | Snapshot | Cover | Shows | |
|---|---|---|---|---|
| 1 | #3 navrail default, dark | 0.02 | the history icon, the arc ends beside its badge dot red | yes |
| 2 | #5 navrail keyboard, dark | 0.02 | the same icon and arc ends | yes |
| 3 | #39 toolbar flyout-open, dark | 0.02 | the flyout's rounded corner red under "Ctrl+Shift+K" | yes |
| 4 | #102 datarow long-value, dark | 0.01 | the "t" of "1 to 36" red | yes |
| 5 | #220 variablepill from keyboard, dark | 0.04 | the PageRank tooltip's corners red | yes |
| 6 | #254 menu long interactions, dark | 0.05 | the row numbers "23", "24" red | yes |
| 7 | #330 color panel-ink, dark | 0.29 | every token name in the right column red | yes |
| 8 | #392 badge states, dark | 0.06 | the right edges of the New, Pro and Live pills red | yes |
| 9 | #454 segmented control, dark | 0.10 | the three icons and the selected segment's borders red | yes |
| 10 | #455 segmented control, light | 0.10 | the same, light | yes |
| 11 | #1044 contiguous-usa | 0.21 | the caption's text and the rule under it red | yes |
| 12 | #1121 path | 0.11 | "30 nodes, 29 edges" and the rule red | yes |
| 13 | #1192 depth-first-search | 0.30 | the caption red and a dashed red edge into node 32 | yes |
| 14 | #479 cytoscape-session | 0.03 | red blocks on a label line in a blurred graph | no |
| 15 | #602 layout2d arf | 0.30 | the status line and both buttons' words red | yes |
| 16 | #1224 inspector node-data, dark | 0.30 | every edge of the hexagons red | yes |
| 17 | #1227 inspector why-this-look, light | 0.23 | the edges red | yes |
| 18 | #1226 inspector why-this-look, dark | 0.23 | the edges red | yes |
| 19 | #1248 several-elements neighborhood, dark | 0.31 | the edges red | yes |
| 20 | #1251 several-elements summary, light | 0.31 | the edges red | yes |

The no: #479's change is a few glyphs of a node label in a capture drawn blurred on purpose; at
400 CSS pixels of page per row the glyphs are about 2 px tall, and the tint (each changed pixel
grown by 2 for the shrink) turns them into solid red blocks. The row shows where; which glyphs
changed needs the viewer. Rows 1 and 2 pass narrowly: the red is four specks at the badge.

Resized pages (#4455, the same first 20 rows as the fifth pass): 20 of 20 yes, light and dark, as
before (table rows or drawings tinted where Highlight puts the most red), so nothing went back.
New and removed rows (#240 new, #374 removed, #4455): the whole image, untinted (there is nothing
to compare), the removed one hatched, as the viewer shows them.

The acceptance test on 83a8b0b: 36 passed, 0 failed, 1 skipped (Captures lists no capture to
walk). Its decide step run 20 times in a row, each right after Right and a view key: 20 of 20
passed. A first run right after the server restart failed only its last step: the Seed row read
"720 left" at the start, before the server had counted its 72 accepted earlier, and "648 left of
720" at the end; no decision was saved.

## A calmer list pane

The Snapshots header had a 590 px List menu holding Undo all decisions beside Accept all shown,
three bulk Accepts on screen at once, and controls that looked alike but did unlike things. Now:

- The change's number and title are its own menu: the whole title, Open on the code host, Copy
  link to this list, the JUnit report and, apart under a line, Undo all decisions. What is
  change-wide and rare lives with the change's name, and the one destructive bulk action sits apart
  from every Accept.
- The List menu is about the list only (Group by, Pictures, Select) and stays under 460 px, over
  the list pane. Zoom rows' Auto reads "When small"; its tooltip keeps the rule.
- Accept all N shown is the last item of the Show menu: it acts on what Show shows.
- While rows are selected, the group headers draw no Accept N, so the decision bar's Accept N is
  the one bulk Accept on screen; each group's name menu still lists Accept N Shift+A.
- Notice chips are outlined menu buttons with a caret, their words in the ordinary ink and only
  their mark in the warning color.
- Find reads "Find /" at every width; Up and Down are the same size as Show and List.
- Group names are cut in the middle, keeping both ends.

On the opened change at 1440 x 900 with Changes folded, the page now shows 53 controls (50 at 1024
x 768), no menu taller than 460 px (the List menu is 423 px), at most two numbers per row (its
number and its changed areas) and one bulk Accept.
