# The screens

The review page has three screens, chosen by the tabs in its top bar: **Review**, where you decide
changes; **Baselines**, every approved baseline and its history; and **Captures**, the captures made
on this machine. They share the same panes, list rows and viewer, so you learn them once.

Every key is printed on the control it presses, and a key does only what a visible key box says.
See [Keys](keys.md).

## The top bar

Left to right: the product name and your repository's name; the **Review**, **Baselines** and
**Captures** tabs; then, only when the data is more than 5 minutes old or something is wrong, its
age in muted words ("Updated 12 min ago", "Offline since 14:02", "Server not answering") and a small
**Refresh**; while the data is fresh neither shows. On the Review screen, **Next change Shift+N**
(it opens the next change that needs you; this is its one home besides the end card); **Keys ?**;
**Settings** (see [Settings](settings.md)); and, on the Review screen with a change open,
**Finish review...** (the title already names the change), which opens the Finish sheet (see [Finish](finish.md)). Finish is always in
that place: outlined in the primary color while snapshots are left, filled once none is. On a
narrow window (1024 px) the repository's name goes first, then the age words, which stay in
Refresh's tooltip; Finish never leaves the screen. **New capture...** is on the Captures screen
(see [Starting a capture from the page](capturing-from-the-page.md)).

Under everything is the **message line**: the latest thing the page has to tell you (what a key
did, why a key did nothing, a failure and its Retry). A plain message clears on your next action. A
message with a button (Undo, Retry, Load it) stays until you use the button, press **Dismiss**, or
a newer message replaces it; so does the one a bulk decision leaves ("Accepted 34 snapshots.",
with Undo), until your next decision. **Messages** opens the last 20. Opening a change says how
many are left: "Opened: 34 left."

## Review

With no change open the screen has two parts: **Changes** on the left and, in the viewer's place,
the summary of the current change: its number and title, its branch, author, source and age,
"720 snapshots: 653 changed, 65 new, 2 removed", "648 left", and **Open [Enter]**. Up and Down move
through the changes and the summary follows; Enter opens the change (on a row that is decided and
not finished, Enter is that row's **Finish...** instead, and Open prints no key). A link that names
a change always opens it.

With a change open, three panes side by side: **Changes**, **Snapshots** and the **viewer**.

### Panes and levels

**Hide Shift+1** and **< Hide Shift+2** fold the Changes and Snapshots panes into narrow rails; the
rail, or the same key again, brings the pane back. A rail is 64 px wide and reads top down,
nothing turned on its side: a badge of what is left, the number over the word ("7 / left" on
Changes, its tooltip "7 changes need you"; "34 / left" on Snapshots, "34 snapshots left to
decide"; no badge with nothing left), the pane's name ("Changes", "Snaps") and its key quietly on
one line ("Shift+1"), each on its own line. Opening a change folds the panes the review
does not need: a small change (10 snapshots or fewer) opens with both side panes as rails, so the
image gets the width at once. The viewer is never narrower than 800 px. **Image only Shift+3**
leaves only the picture and what you decide it with: the top bar (Finish too), both rails, the
item line and the message line (unless it holds a message) go. One strip stays above the picture,
with **Back Esc** and the snapshot's name, the views, **Zoom** (and **Blink** in Highlight), and
**Image only Shift+3** with its check mark, the way out; the decision bar stays under it. A key
whose control is hidden (Shift+N, ?, Shift+1, Shift+2, P, X...) does nothing and says once "Hidden
in Image only: Shift+3 brings it back." Pressed again, Image only gives back the top bar and exactly
the panes it folded ("Image only off: panes back as they were."). Folding both panes yourself is
not Image only: the top bar stays. The page remembers your pane choices in this browser, separately for small
and large changes.

**Back Esc** on the item line goes back one level: to the list, or to the changes (its tooltip
says which). Esc first closes an open menu or box, or clears the selection; right after such an
Esc, a second one says "Press Esc again to go back to the changes." rather than leaving the change
by accident.

### Changes

Every change with captures, in sections, each with its count:

1. **Needs you**: captures ready, with snapshots to decide. Small changes and the longest waiting
   come first.
2. **Decided, not finished**: every snapshot decided, no Finish yet (a failed Finish is here too,
   with why and Retry). Each row has **Finish...**, and the header **Finish all 29...**.
3. **Capturing or downloading**.
4. **Not ready**: the capture failed, a story could not be shot, the images expired, or the
   capture is incomplete. The row says which, with the job's log.
5. **Look only**: local previews and partial captures, which can be looked at but never finished.
6. **Nothing to decide**: no differences, or finished.
7. **Drafts**: draft pull requests, never offered for review. A draft you already finished part of
   is listed in Needs you.

Each row is two lines: the change's number and title, then what state it is in ("34 left of 1,242")
and at most one badge; more badges fold into "+1 more", their words in its tooltip, and no word is
ever cut. The branch, author, where it was captured and how long ago are in the row's tooltip,
joined by " - " ("feature - by octocat - from CI - 4 min ago"), with "2 of 3 projects ready" only
while a project is not. A **behind master** badge marks a change whose branch is behind the default
branch, or whose capture is older than baselines the default branch accepted since (its tooltip says
how many); "140 MB to download" (or "1.9 GB to download") one whose images opening it fetches again. **Find [/]** finds a change by
number, title, branch or author; **Sort** orders them (Needs me first, Newest, Most undecided,
Author); **Next change Shift+N** in the top bar opens the next change that needs you. A row's **...** menu has
**About this change** (its title, description and comments, as plain text, each marked when not
written by the repository's owner, and which other change shares baselines with it: "Shares 2,188
baselines with #1677"), Open on the code host and **Copy link**.

The number of changes that need you is in the tab's title, and the page asks the server again every
few seconds while it is shown.

### Snapshots

The open change's snapshots. Its header is three lines; only the title wraps:

1. The change's number and title, and the fold button **< Hide Shift+2**, nothing else. The
   number leads the first line and the title's words flow on after it and under it, so even a
   narrow pane shows the title's first words on both lines; it wraps to at most two lines and is
   cut ("...") only after that. The number and the fold button never go. The number and title are
   the change's own menu (a small caret after them, the whole title in their tooltip), for what is change-wide and rare: the whole title, wrapped; **Open on GitHub** (the
   code host's name; a link, so the browser can copy its address); **Copy link to this list**;
   **Download the comparison report (JUnit)**; and, apart from them under a line, **Undo all
   decisions...**.
2. The progress line: **34 left** in bold, then, muted, what you decided and what was accepted
   before this capture, "12 decided, 1,208 accepted earlier", each only when it is not 0. Under it,
   the bar fills with both. A change of 10 or fewer says only "3 left" until you decide something.
   Any notice chips sit at the line's right end (below). When the line is tight, "accepted earlier"
   goes first, then **Behind master: 1,243** shortens to **Behind: 1,243**, then "decided" goes;
   "34 left" never goes.
   When the line is tight, "accepted earlier" goes first, then "decided"; "N left" always stays.
3. **Find** (its placeholder "Find /", its tooltip "Find a story, or #number"): filters the rows by
   story; a number ("47" or "#47") jumps to that snapshot instead. Esc clears the box first, then
   leaves it. Then **Show: Undecided**, the one filter: its menu lists Undecided (the default) and
   All, then under the muted heading **By kind** each status the change has (Changed, New,
   Removed...), and under **By decision** Accepted earlier, Accepted (yours), Rejected and
   Excluded, each with its count on the right, a choice of 0 greyed; the headings are never focused
   and the arrow keys skip them. Last, under a line, **Accept all 34 shown...**,
   which accepts what Show and Find show and always asks first. The button shows the count only
   while the list is filtered, "Show: Rejected (3)". Then **List**, about the list only: **Group by**
   (Component, Same change, Project, Status, None), **Pictures** (**Crop to the change**, the
   default, **Whole image** or **Text only, no pictures**, and **Mark the change**, on by default,
   which tints the changed pixels red) and **Select** (**Extend selection up Shift+Up**, **Extend selection down
   Shift+Down**, both acting with the menu closed, and **Select all shown**). A menu opened from the
   list stays over the list, never over the pictures. Last, the list's **Up** and **Down**, in the
   same size as Show and List.

Keys off the look-decide-next loop are printed as quiet muted text after their label ("Next change
Shift+N"); boxed keys are kept for the view switch, the decision bar and boxes.

Each row shows the snapshot's number and status, its story's name (the one bold thing on the row,
its mode and "resized" after it in muted words: "graph-file, dark, resized"), its decision, and a picture of the new
image. Under **Crop to the change** a changed row's picture is always a crop of the change, filling
the row, never more than 400 x 156 CSS pixels of the page, so text in it stays readable: the box
around every changed area when it fits; else the largest group of areas that lie close together;
else, when the change is larger than that (a resized page, where everything under the first change
moved), the crop of that size where the most pixels changed, never the blank strip a size change
adds or removes at the edge.
When only the size changed (the new image is a few pixels taller or shorter and nothing else is
different), the crop is centered on the image and the row says so in words. With **Mark the
change** on, the change is marked in the picture itself, however small or large it is: the
changed pixels are tinted red, as Highlight shows them, and the rest is the page as it is, so the
row shows what changed (the glyphs of a changed cell, a moved edge), not only where. A crop that
frames changed areas holds each of them whole: at the image's edge it slides inward, never cuts
one.
Nothing is ever drawn over a picture, and a picture narrower than the row is centered on the row's
own background. Right under the story's name the row says how many areas changed, "66 changed
areas", or "Only the size changed: 2 px shorter". Hover the picture for what it shows: "Cropped to
the changed areas", "Cropped to 3 of the 66 changed areas", "Cropped to where the most pixels
changed", "Centered: only the size changed", or "Whole image", with ", changed pixels tinted" on
every tinted picture (a size-only crop has nothing in it to tint); the picture's alt text says the
same. The changed pixels' count is in
**Details**. "resized" (the new image is a different size) is a muted word after the name, not a
badge; its tooltip gives both sizes, "Resized: 2,400 x 3,770 to 2,400 x 3,804". Badges: **unstable** (its attempts in the run did not agree, with `run --retries` or a
runner's retries; its status is its last attempt's), **re-review**, and **+4 identical** (the same
change as 4 other snapshots). A badge never shrinks; "unstable" always keeps its word; the others fold, when they do not fit, into "+2 more" (their
words in its tooltip), and a single one left over shows its own word, never a bare "+1".

A row's checkbox stays in its column so nothing moves under the pointer; it is drawn faintly, in
the border color, until the row is hovered or a selection exists.

**Groups.** By component (the default above 10 snapshots). Each group header is one line: the
chevron folds and unfolds the group; the name button, "legend" with a small caret after it (a
component is named alone, its project in the tooltip, unless two projects share the name; a long
name is cut at its start, "...cytoscape-js-specimens", keeping its end, because groups that share a start differ at the end,
the whole name in the header's tooltip), underlines on hover and opens the group's actions:
**Accept 14** (printing **Shift+A** on the current snapshot's group), **Collapse** or **Expand**,
**Reject 14...**, **Exclude 14...**, **Select all 14**, and **Undo 3...** while the group holds
decisions to take back. The header carries no count: it is said once, in **Accept 14**, at the
end of the line. That button shows always on the group of the current snapshot (green, with its key
**Shift+A**) and on the other groups only while their header is hovered or focused. While rows are
selected no header shows it: the decision bar's **Accept 12** is the one bulk Accept on screen,
and each group's name menu still lists **Accept 14 Shift+A**. Once nothing in
the group is left it becomes **Undo 14**. Same change groups snapshots with exactly the same change first (a fact), then
look-alike changes (a guess, labeled so). A group of more than 50 opens folded, except the first.

**Accepted earlier.** Images accepted before this capture (byte for byte an image already accepted
for the same story and mode) sit in one folded line at the bottom of the list, "Accepted earlier",
under every grouping; each of their rows says "Accepted earlier (#1356)". Its chevron
opens it, and its name's menu has **Reject 1,208...** and **Exclude 1,208...**; it has no Accept
and no Undo.
After a group accept, the next group's first undecided snapshot becomes current, so repeated
Shift+A walks the change group by group. Accepting more than 20 at once asks first.

**Selection.** A click makes a row current (the viewer shows it). **Select [X]**, a row's checkbox,
a shift-click (a range) or **Shift+Up / Shift+Down** add rows to the selection; the selection bar
then appears under the header's third line: **12 selected**, **Clear [Esc]** and **More** (Extend
selection up, Extend selection down, Select all shown; the same three are in the List menu). The decision bar decides the selection when the current row is in
it, and says so: **Accept 12**, **Reject 12...**, **Exclude 12...**; otherwise A, R and E act on
the current row. Every bulk decision is one request per project and one step for Undo.

### The viewer

The viewer's toolbar is one row. On the left, the four views: **Side by side [V]**,
**Flash [F]** (or hold Space), **Highlight [H]** and **Spotlight [S]**. One view at a time: exactly
one is filled, and pressing a view's key again goes back to Side by side. **F** from Spotlight
flashes the spotlit pair (the label says "Baseline (flashing, spotlit)"); V, H or S leaves Flash,
so S after H is plain Spotlight. **Zoom: Fit Z**, a menu button with its small arrow, names the zoom:
Z steps Fit, 1x, 2x, 4x and 8x, and a click opens its menu (**Fit 0**, **Actual size 1**,
**2x 2**, **4x 4**, **8x 8**), whose digits also work with the menu closed. Every zoom step
centers on the current changed area, the same place in both panes (the two images are lined up at
their top left, also when the snapshot was resized); a pane whose image does not reach that place
says "Baseline (outside this image)" in its label. In Highlight only, **Blink L** sits after Zoom; it
blinks the highlight on and off and shows a check mark while on. From 2x a small map of the whole image at the right end
of the New panel's label moves the view where you click it. At the right end, **Display** holds
what you set once a session, each printing its key, which works with the menu closed: **Show
baseline P** (hide it to see the new image alone), **Image only Shift+3**, **Layout: Auto Y** (Y
steps Auto, Side by side and Over and under; Auto picks whichever draws the images larger),
**Outline changed areas B** and **Start zoomed on the change O**. With the baseline hidden, the
button reads **Display: baseline hidden**, and the remaining panel's label starts with a quiet
**Show baseline P**, so the missing panel is never silently gone; both go when P shows it again.
The zoom the toolbar names is the zoom drawn: the pictures on screen take it at once, also right
after V or a digit key, while the new view's pictures are made.

Under the toolbar, the item line: **Back Esc**, the snapshot's number and status ("#1028 changed"),
its story's name (with dark or light after it), its badges, **Next area N** when it has more than
one changed area (with "Area 1 of 26" while zoomed above Fit), **Select X**, **Wider Enter** and
**Details**. **Wider Enter** shows on a large change (more than 10 snapshots) while its list is
shown beside the viewer, at every window width: it folds the list to its rail so the picture gets
the room, and Esc brings the list back (under 1400 px that is the viewing level, which Back
leaves). The size of the change is on the snapshot's row and in
Details, not here. When the line is tight, the badges other than "unstable" and "resized" go
first, then the name is cut in the middle, never below 24 characters; if it still does not fit,
the line wraps to a second line. "unstable", "resized", Select, Wider and Details always stay
whole. **Details** opens the snapshot's threshold, renderer, hashes, settings
file, component, attempts and console under the line, with **Copy link to this image**.

Nothing is drawn over the images. The label above each panel says what it shows and what state it
is in: "Baseline", "New", "New (loading)", "Baseline (missing)", "New (blank image)" (a capture
that is all one color), "Baseline (outside this image)", "no pixels changed" for a renamed story
whose image is the same, and, while flashing, which image is showing: "Baseline (flashing)" or
"New (flashing)", with ", spotlit" when Flash came from Spotlight.

The pictures never disappear under you: opening a menu or changing a setting keeps them, and
moving on to another snapshot, view or zoom keeps the old pictures until the new ones are ready.
"Loading..." shows only the first time a snapshot's images are fetched, and only after a third of a
second. When a view takes longer than that to draw (a tall page's Highlight, say), both labels say so,
"Baseline (drawing Highlight...)" and "New (drawing Highlight...)", over the old pictures.

When the changed areas cover a third or more of the image, Highlight is mostly red and Spotlight
dims nothing. The first H or S on such a snapshot says why on the message line: on a resized
snapshot, "Resized: everything below the first change moved, so it all counts as changed. Flash (F)
shows the move."; otherwise "Most of this image changed. Flash (F) shows it."

A new snapshot, one with no baseline yet and a removed one show their one image; a failed one shows
why the story did not render, with its console.

### The decision bar

Under the image, the same place for every snapshot:

**Previous [J] Left**, **Next [K] Right**, then **Undo [U]**, **Exclude... [E]**, **Reject... [R]**
(a red outline) and **Accept [A]**, the only filled button. With a selection that holds the current
row they read **Accept 3**, **Reject 3...** and **Exclude 3...**. Every word stays at every width
(a 1024 x 768 laptop included); if the bar is ever too narrow, the quiet Left and Right shorten to
`<-` and `->`, then the bar takes a compact size. Accept moves on to the next
undecided snapshot; Left and Right step through every row. Reject and Exclude ask for a reason in a
small box above the bar (the author reads a reject's reason); recent reasons are one press away.
The box's heading is one line, "Reject #1028 legend / graph-f...-dark": a long story name is cut in
the middle, the whole in its tooltip.
See [What each decision does](decisions.md).

A decision is never taken on an image you have not seen: a key pressed within a quarter second of
the images being drawn is ignored and the message line says so, a held key decides once, and a
decision is saved before the next one can be made.

After the last undecided snapshot the stage shows the end card: **Finish #3486 (214) [Enter]**,
which counts the decisions it will publish, Back, and **Next change [Shift+N]**.

### A capture made with another browser

When the captures were drawn by another browser version than the baselines (the capture's
`renderer` and its `baselineRenderer` differ, see [Capture and compare](capture-and-compare.md)),
every image may differ for that reason alone. The snapshot list then shows, in place of the rows:
"These captures used Chromium 131; the baselines used Chromium 128. Every image may differ." with
two buttons:

- **Show the changes anyway** shows the rows, to decide them as usual.
- **Capture the baselines again...** opens New capture, to capture with the same browser.

The banner never shows when either capture does not say which browser drew it.

### A newer capture, and a stale one

Both are notices, never blocks: a small outlined button at the right end of the Snapshots
header's progress line, its mark in the warning color and a caret after its words. Each is a menu button that says
what it means and what to do. When both apply and
the line is tight, they fold into one **2 notices** chip whose menu holds both.

- **Behind master: 1,242**: the default branch accepted that many newer baselines after this
  capture. Your decisions stay valid unless the default branch changed the same images; if it did,
  updating first saves reviewing them twice. The menu has **See what changed on master** and
  **Update from master...**, which merges the default branch in so CI captures again (see
  [Updating from the default branch](../README.md#updating-from-the-default-branch)).
- **Newer capture**: CI captured the change again while you review it. Your rows never change
  under you; the message line says so once, with **Load it**, and the chip's menu has **Load it**
  too. Decisions are kept by image: loading the newer capture keeps every decision whose image is
  the same, and says which ones it could not keep.

## Baselines

Every approved baseline in the repository: what the gate compares new captures with.

- **Projects**, on the left: **Baselines of** chooses whose baselines you see, the default branch's
  or a change's (its head commit). Under it, every project and its components, each with how many
  baselines it holds; choose one to show only those.
- **The baselines**, in the middle: one row per baseline with its picture, its story, its mode and
  when it last changed in which change. **Find [/]** finds a story by name or by its number
  ("#12"); **Group** groups the rows by component, by project, or not at all.
- **The viewer**, on the right: the baseline the row chose, with the same zoom controls as a review
  and **Image only Shift+3**. It draws no view buttons until two versions are ticked in the
  History; a view key before then says so. **Previous [J] Left** and **Next [K] Right** move through the
  baselines. Under it, the **History**: every version of that baseline, newest first, with its
  date, who accepted it, in which change, and its approval (signed by which passkey, or not signed).
  Tick two versions to compare them with **Side by side [V]**, **Flash [F]**, **Highlight [H]** and
  **Spotlight [S]**, the older one on the left.

Baselines stored in Git LFS that are not on this computer yet show **Not downloaded** in place of
their picture. **Download 312 images (68 MB)** above the list fetches exactly the images the list
shows that are missing, and an older version in the history has its own **Download**. Nothing is
downloaded until you press one of them.

## Captures

The captures made on this machine, and those asked of CI from the page: Running, Queued, Finished
today and Earlier, each with its projects and stories as they are shot. See [Starting a capture from
the page](capturing-from-the-page.md).

## Addresses

Every change and snapshot you open is in the address, after `#`, so a copied link opens it again
and the browser's Back and Forward move between them. **Copy link** copies one; it carries your
session token, so it works on your iPad the way the printed URL does: keep it to yourself as you
would that URL. Everything after `#` stays in the browser and is never sent to a server.

Links written by `@graphty/visual-review` (in pull request comments, for example) open the same
change and snapshot, and so does an address under `/next/`, where the page was before 1.0.0.

## On an iPad

The page works with a keyboard and with touch. To keep it on the home screen, use **Add to Home
Screen** in Safari: the page opens full screen as its own app. A home-screen app keeps its own
storage, apart from Safari's, so the first time it opens it asks for the token: paste the URL
`serve` printed once and the app remembers it.
