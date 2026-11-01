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
**Finish #3486...**, which opens the Finish sheet (see [Finish](finish.md)). Finish is always in
that place: outlined in the primary color while snapshots are left, filled once none is. On a
narrow window (1024 px) the repository's name goes first, then the age words, which stay in
Refresh's tooltip; Finish never leaves the screen. **New capture...** is on the Captures screen
(see [Starting a capture from the page](capturing-from-the-page.md)).

Under everything is the **message line**: the latest thing the page has to tell you (what a key
did, why a key did nothing, a failure and its Retry). A plain message clears on your next action. A
message with a button (Undo, Retry, Load it) stays until you use the button, press **Dismiss**, or
a newer message replaces it; so does the one a bulk decision leaves ("Accepted 34 snapshots.",
with Undo), until your next decision. **Messages** opens the last 20. Opening a change says how
many are left: "Opened #4455: 34 left."

## Review

With no change open the screen has two parts: **Changes** on the left and, in the viewer's place,
the summary of the current change: its number and title, its branch, author, source and age,
"720 snapshots: 653 changed, 65 new, 2 removed", "648 left", and **Open [Enter]**. Up and Down move
through the changes and the summary follows; Enter opens the change (on a row that is decided and
not finished, Enter is that row's **Finish...** instead, and Open prints no key). A link that names
a change always opens it.

With a change open, three panes side by side: **Changes**, **Snapshots** and the **viewer**.

### Panes and levels

**Hide Shift+1** and **< Shift+2** fold the Changes and Snapshots panes into narrow rails; the
rail, or the same key again, brings the pane back. A rail prints its key stacked ("Shift" over
"1") and a badge of what is left, the number over the word: "7 / left" on Changes (its tooltip "7
changes need you"), "34 / left" on Snapshots ("34 snapshots left to decide"); with nothing left
it has no badge. Opening a change folds the panes the review
does not need: a small change (10 snapshots or fewer) opens with both side panes as rails, so the
image gets the width at once. The viewer is never narrower than 800 px. **Image only [Shift+3]**
folds both side panes. The page remembers your pane choices in this browser, separately for small
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
how many); "140 MB to download" one whose images opening it fetches again. **Find [/]** finds a change by
number, title, branch or author; **Sort** orders them (Needs me first, Newest, Most undecided,
Author); **Next change Shift+N** in the top bar opens the next change that needs you. A row's **...** menu has
**About this change** (its title, description and comments, as plain text, each marked when not
written by the repository's owner, and which other change shares baselines with it: "Shares 2,188
baselines with #1677"), Open on the code host and **Copy link**.

The number of changes that need you is in the tab's title, and the page asks the server again every
few seconds while it is shown.

### Snapshots

The open change's snapshots. Its header is three lines that never wrap:

1. The change's number and title, a link to it on the code host, then any notice chips and the
   fold button **< Shift+2**. When the line is tight the title is cut first ("..."); the number and
   the fold button never go.
2. The progress line: **34 left** in bold, then, muted, what you decided and what was accepted
   before this capture, "12 decided, 1,208 accepted earlier", each only when it is not 0. Under it,
   the bar fills with both. A change of 10 or fewer says only "3 left" until you decide something.
   When the line is tight, "accepted earlier" goes first, then "decided"; "N left" always stays.
3. **Find** (its placeholder "Find, or #number /"): filters the rows by story; a number ("47" or
   "#47") jumps to that snapshot instead. Esc clears the box first, then leaves it. When the line is
   tight the placeholder shortens to "Find /", then "/". Then **Show: Undecided**, the one filter:
   its menu lists Undecided (the default), All, each status the change has, Accepted earlier,
   Accepted (yours), Rejected and Excluded, each with its count on the right, a choice of 0 greyed.
   The button shows the count only while the list is filtered, "Show: Rejected (3)". Then **List**:
   **Group by** (Component, Same change, Project, Status, None), **Pictures** (**Spotlight rows**,
   which dims what did not change, Zoom
   rows to the change Auto, Always or Never, or No pictures), Accept all shown..., Undo all
   decisions..., Download the comparison report (JUnit) and **Copy link to this list**. Last, the
   list's **Up** and **Down**, their keys printed quietly.

Keys off the look-decide-next loop are printed as quiet muted text after their label ("Next change
Shift+N"); boxed keys are kept for the view switch, the decision bar and boxes.

Each row shows the snapshot's number and status, its story's name (the one bold thing on the row,
its mode after it in muted words: "graph-file, dark"), its decision, and a picture of the new
image: spotlit (everything but the change dimmed) and, under Zoom Auto, zoomed to the change
when that shows it at least twice as large. Nothing is ever drawn over a picture. A zoomed picture
has a gray bar outside its left edge, and the line under the story says the size and the zoom in
words: "26 areas, 490k px, zoomed 4x". When the changed areas are spread too far apart to zoom to
all of them, the picture shows the largest group of areas that lie close together, and the line
says how many: "zoomed 4x to 3 of them". When the row is too narrow, a badge's word is kept and the
zoom words give way first; they stay in the line's tooltip. Hover a picture for "Zoomed 4x to the changed areas" or
"Whole image". Badges: **resized** (the new image is a different size), **unstable** (its attempts
in the run did not agree, with `run --retries` or a runner's retries; its status is its last
attempt's), **re-review**, and **+4 identical** (the same change as 4 other snapshots). "resized"
and "unstable" always keep their word; the others fold, when they do not fit, into "+2 more" (their
words in its tooltip), and a single one left over shows its own word, never a bare "+1".

A row's checkbox stays in its column so nothing moves under the pointer; it is drawn faintly, in
the border color, until the row is hovered or a selection exists.

**Groups.** By component (the default above 10 snapshots). Each group header is one line with
three controls: the chevron folds and unfolds the group; the name button, "legend (14)" with its
count muted (a component is named alone, its project in the tooltip, unless two projects share the
name; a long name is cut in the middle, the count never), opens the group's menu: **Collapse** or **Expand**, **Reject 14...**, **Exclude 14...**, **Select all 14**,
and **Undo 3...** while the group holds decisions to take back. Its tooltip gives the split by
status ("14: 12 changed, 2 new"). Last, **Accept 14**: outlined on every group, and green with its
key **Shift+A** only on the group of the current snapshot; once nothing in the group is left it
becomes **Undo 14**. Same change groups snapshots with exactly the same change first (a fact), then
look-alike changes (a guess, labeled so). A group of more than 50 opens folded, except the first.

**Accepted earlier.** Images accepted before this capture (byte for byte an image already accepted
for the same story and mode) sit in one folded line at the bottom of the list, "Accepted earlier
(1,208)", under every grouping; each of their rows says "Accepted earlier (#1356)". Its chevron
opens it, and its name's menu has **Reject 1,208...** and **Exclude 1,208...**; it has no Accept
and no Undo.
After a group accept, the next group's first undecided snapshot becomes current, so repeated
Shift+A walks the change group by group. Accepting more than 20 at once asks first.

**Selection.** A click makes a row current (the viewer shows it). **Select [X]**, a row's checkbox,
a shift-click (a range) or **Shift+Up / Shift+Down** add rows to the selection; the selection bar
then appears under the header's third line: **12 selected**, **Clear [Esc]** and `...` (Extend up,
Extend down, Select all shown). The decision bar decides the selection when the current row is in
it, and says so: **Accept 12**, **Reject 12...**, **Exclude 12...**; otherwise A, R and E act on
the current row. Every bulk decision is one request per project and one step for Undo.

### The viewer

The viewer's toolbar has seven controls. On the left, the four views: **Side by side [V]**,
**Flash [F]** (or hold Space), **Highlight [H]** and **Spotlight [S]**, the one shown filled;
pressing a view's key again goes back to Side by side. Beside them **Blink L**, which blinks the
highlight on and off in Highlight and shows a check mark while on. **Zoom: Fit Z** names the zoom:
Z steps Fit, 1x, 2x, 4x and 8x, and a click opens its menu (**Fit 0**, **Actual size 1**,
**2x 2**, **4x 4**, **8x 8**), whose digits also work with the menu closed. Every zoom step
centers on the current changed area, and from 2x a small map of the whole image at the right end
of the New panel's label moves the view where you click it. At the right end, **Display** holds
what you set once a session, each printing its key, which works with the menu closed: **Show
baseline P** (hide it to see the new image alone), **Image only Shift+3**, **Layout: Auto Y** (Y
steps Auto, Side by side and Over and under; Auto picks whichever draws the images larger),
**Outline changed areas B** and **Start zoomed on the change O**.

Under the toolbar, the item line: **Back Esc**, the snapshot's number and status ("#1028 changed"),
its story's name (with dark or light after it), the size of the change ("490k px"), its badges,
**Next area N** when it has more than one changed area (with "Area 1 of 26" while zoomed above
Fit), **Select X Shift+Up/Down** and **Details**. When the line is tight, the other badges go
first, then the size, then the name is cut in the middle (never below 24 characters); "unstable"
and "resized" always stay. **Details** opens the snapshot's threshold, renderer, hashes, settings
file, component, attempts and console under the line, with **Copy link to this image**.

Nothing is drawn over the images. The label above each panel says what it shows and what state it
is in: "Baseline", "New", "New (loading)", "Baseline (missing)", "New (blank image)" (a capture
that is all one color), "no pixels changed" for a renamed story whose image is the same, and, while
flashing, which image is showing: "Baseline (flashing)" or "New (flashing)".

A new snapshot, one with no baseline yet and a removed one show their one image; a failed one shows
why the story did not render, with its console.

### The decision bar

Under the image, the same place for every snapshot:

**Previous [J] Left**, **Next [K] Right**, then **Undo [U]**, **Exclude... [E]**, **Reject... [R]**
(a red outline) and **Accept [A]**, the only filled button. With a selection that holds the current
row they read **Accept 3**, **Reject 3...** and **Exclude 3...**. In a viewer under 760 px wide
Previous and Next show only their keys, then Undo; the decision words never drop. Accept moves on to the next
undecided snapshot; Left and Right step through every row. Reject and Exclude ask for a reason in a
small box above the bar (the author reads a reject's reason); recent reasons are one press away.
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

Both are notices, never blocks: a small chip on the first line of the Snapshots header, in the
warning color. Each is a menu button that says what it means and what to do. When both apply and
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
  and **Image only Shift+3**. **Previous [J] Left** and **Next [K] Right** move through the
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
