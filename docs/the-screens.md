# The screens

The review page has three screens, chosen by the tabs in its top bar: **Review**, where you decide
changes; **Baselines**, every approved baseline and its history; and **Captures**, the captures made
on this machine. They share the same panes, list rows and viewer, so you learn them once.

Every key is printed on the control it presses, and a key does only what a visible key box says.
See [Keys](keys.md).

## The top bar

Left to right: the product name and your repository's name; the **Review**, **Baselines** and
**Captures** tabs; **New capture...** (see [Starting a capture from the
page](capturing-from-the-page.md)); the server's state ("Updated 40 s ago", or "Offline since
14:02" when the server cannot be reached; click it to refresh now); **Keys [?]**; **Settings** (see
[Settings](settings.md)); and, with a change open, **Finish #3486 (12)**, which counts the decisions
it will publish (see [Finish](finish.md)). Finish is always in that place.

Under everything is the **message line**: the latest thing the page has to tell you (what a key
did, why a key did nothing, a failure and its Retry). **Messages** opens the last 20.

## Review

Three panes side by side: **Changes**, **Snapshots** and the **viewer**.

### Panes and levels

**Hide [Shift+1]** and **Hide [Shift+2]** fold the Changes and Snapshots panes into narrow rails;
the rail, or the same key again, brings the pane back. Opening a change folds the panes the review
does not need: a small change (10 snapshots or fewer) opens with both side panes as rails, so the
image gets the width at once. The viewer is never narrower than 800 px. **Image only [Shift+3]**
folds both side panes. The page remembers your pane choices in this browser, separately for small
and large changes.

**Back [Esc]** names where it goes: back to the list, or back to the changes. Esc first closes an
open menu, box or selection.

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

Each row says what state the change is in and what it waits for. **Find [/]** finds a change by
number, title, branch or author; **Sort** orders them (Needs me first, Newest, Most undecided,
Author); **Next change [Shift+N]** opens the next change that needs you. A row's **...** menu has
**About this change** (its title, description and comments, as plain text, each marked when not
written by the repository's owner), Open on the code host and **Copy link**.

The number of changes that need you is in the tab's title, and the page asks the server again every
few seconds while it is shown.

### Snapshots

The open change's snapshots. Its header holds, top to bottom:

- The change's title, a link to it on the code host.
- How many are decided and how many are left, with a progress line.
- The **status summary**: one entry per status present, each a mark, a count and a word ("249
  changed, 24 new, 9 no baseline yet, 8 removed, 3 failed"); pressing one shows only that status.
- **Find [/]**: filters the rows by story; a number ("47" or "#47") jumps to that snapshot instead.
  Esc clears the box first, then leaves it.
- **Show** (Undecided, the default, All, each status, Accepted, Rejected, Excluded, each with its
  count), **Group** (Component, Same change, Project, Status, None), **Pictures** (Spotlight rows,
  Zoom rows to the change Auto, Always or Never, or No pictures) and **...** (Accept all shown...,
  Undo all decisions..., Download the comparison report (JUnit), Copy link). On a small change these
  are one **View options** menu.

Each row shows the snapshot's number, story, mode and status, its decision, and a picture of the
new image: spotlit (everything but the change dimmed) and, under Zoom Auto, zoomed to the change
when that shows it at least twice as large. A badge **attempts disagree** marks a snapshot whose
attempts in the run did not agree (with `run --retries`, or a runner's retries); its status is its
last attempt's.

**Groups.** By component (the default above 10 snapshots), each group header shows its count, the
split by status in marks and words, and **Accept 14** (with **[Shift+A]** on the group of the
current snapshot), **Undo 14** after a decision, and a menu with Reject 14..., Exclude 14..., Select
all and Show all. Same change groups snapshots with exactly the same change first (a fact), then
look-alike changes (a guess, labeled so). A group of more than 50 opens folded, except the first.
After a group accept, the next group's first undecided snapshot becomes current, so repeated
Shift+A walks the change group by group. Accepting more than 20 at once asks first.

**Selection.** A click makes a row current (the viewer shows it). **Select [X]**, a row's checkbox,
a shift-click (a range) or **Shift+Up / Shift+Down** add rows to the selection; the selection bar
then takes the place of the header's controls line, with **Accept 12**, **Reject 12...**, **Exclude
12...** and **Clear [Esc]**. A, R and E act on the selection when the current row is in it, and the
decision bar says so ("Accept 12 selected [A]"); otherwise they act on the current row. Every bulk
decision is one request per project and one step for Undo.

### The viewer

The current snapshot, in four views: **Side by side [V]**, **Flash [F]** (or hold Space),
**Highlight [H]** (with **Blink [L]**) and **Spotlight [S]**. Pressing a view's key again goes back
to Side by side. **Zoom [Z]** and Fit [0], 1x [1], 2x [2], 4x [4] and 8x [8] zoom both images
together, and from 2x a small map of the whole image at the lower right moves the view where you
click it. **Baseline [P]** hides the baseline to see the new image alone; **Layout [Y]** puts the
two images side by side or over and under (Auto picks whichever draws them larger); **Options**
has Outline [B], Open centered on the area [O], Details (the snapshot's story, settings, console
and attempts) and Copy link. **Next area [N]** steps through the changed areas.

A new snapshot, one with no baseline yet and a removed one show their one image; a failed one shows
why the story did not render, with its console.

### The decision bar

Under the image, the same place for every snapshot:

**Previous [Left / J]**, the snapshot's number and how many are left, **Next [Right / K]**, then
**Undo [U]**, **Exclude... [E]**, **Reject... [R]** and **Accept [A]**. Accept moves on to the next
undecided snapshot; Left and Right step through every row. Reject and Exclude ask for a reason in a
small box above the bar (the author reads a reject's reason); recent reasons are one press away.
See [What each decision does](decisions.md).

A decision is never taken on an image you have not seen: a key pressed within a quarter second of
the images being drawn is ignored and the message line says so, a held key decides once, and a
decision is saved before the next one can be made.

After the last undecided snapshot the stage shows the end card: **Finish #3486 (214) [Enter]**,
Back, and **Next change [Shift+N]**.

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

When CI captures the change again while you review it, the list says "A newer capture of this change
is ready" with **Load it**; your rows never change under you. Decisions are kept by image: loading
the newer capture keeps every decision whose image is the same, and says which ones it could not
keep. When the default branch has accepted newer baselines since the capture, the list says so and
offers **Update from master...** (see [Updating from the default
branch](../README.md#updating-from-the-default-branch)).

## Baselines

Every approved baseline in the repository: what the gate compares new captures with.

- **Projects**, on the left: **Baselines of** chooses whose baselines you see, the default branch's
  or a change's (its head commit). Under it, every project and its components, each with how many
  baselines it holds; choose one to show only those.
- **The baselines**, in the middle: one row per baseline with its picture, its story, its mode and
  when it last changed in which change. **Find [/]** finds a story by name or by its number
  ("#12"); **Group** groups the rows by component, by project, or not at all.
- **The viewer**, on the right: the baseline the row chose, with the same zoom controls as a review
  and **Image only [Shift+3]**. **Previous [Left / J]** and **Next [Right / K]** move through the
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
