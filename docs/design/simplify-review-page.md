# proofroom review page: simplification spec (2026-10-31, revised after red team)

Worktree: `/home/apowers/Projects/proofroom/.worktrees/simplify-review-page`. Page code is
`trusted/page/` (plain ES modules), styles in `trusted/page/page.css`. No new dependencies, no new
files unless a test needs one. Prefer deleting and merging over adding.

## 1. Design intent

The screenshots are the product: on every screen the pictures get the most space and nothing is
ever drawn on top of them. Around them sits one calm status line that says what is left, in one
vocabulary ("left", "decided", "accepted earlier", "behind master"), each fact said once, every
count with its noun. Controls appear where and when they are needed: the look-decide-next loop
(view switch, Previous, Next, Undo, Exclude, Reject, Accept) is always in view with boxed keys;
things a reviewer sets once a session (layout, baseline, outline, pictures, grouping) live in
clearly named menus whose items print their keys, and those keys act with the menu closed.
Nothing that works today is lost: every key still has a visible control that prints it, and no
key that is one press today becomes two.

## 2. The owner's four complaints

### 2.1 "zoomed 12x" and "+9 areas" cover the thumbnail

Before: two dark pills (`span.ztags > span.ztag`, page.css `.pic .ztags` / `.pic .ztag`, built in
`pictureKind()` list.js:257-263 and `pictureOf()`) sit on the bottom right of every zoomed row
picture, where the zoomed crop centers the change. The crop shows area 1 only, and the picture is
spotlit at full strength, so many thumbnails are a dark box with a speck.

After:
1. Nothing is drawn on any picture, anywhere on the page (rows, viewer and Baselines). Delete
   `.ztags` / `.ztag` and the `tags` array.
2. (Dropped in 9.2 item 5: no crop bar. A crop is said in the List menu and the picture's
   tooltip, which keeps locked principle 9: a crop is never silent.)
3. The zoom fact and the size are words on row line 4: `26 areas, 490k px, zoomed 4x`; unzoomed
   `26 areas, 490k px`; one area `1 area, 1,412 px`. Sizes under 10,000 print in full with
   separators; above, rounded to `k` / `M`. When the crop shows the largest cluster only:
   `26 areas, 490k px, zoomed 4x to 3 of them`. The full count stays in the row tooltip.
4. `+N areas` is deleted. Picture tooltip: `Zoomed 4x to the changed areas` (or `Whole image`).
5. The row crop (`rowCrop()` spot.js:121) frames the box around all changed areas when that box
   reaches Auto's 2x-of-Fit threshold; otherwise it frames the largest cluster of nearby areas
   (areas whose boxes lie within one area-height of each other merge), so a spread-out change still
   shows a change, never a blank page.
6. Row Spotlight stays on by default, at the lower `SPOT_ALPHA` 110 (spot.js:6, and the row tile
   in `trusted/lib/thumbs.mjs` if it keeps its own value) shared with the viewer. Rows can switch it
   off in the List menu (`Spotlight rows`).
7. Items 5 and 6 are checked on the real candidate before they are kept: capture the first 40
   rows of the 1,800-image candidate on the studio server at 1440 and 1024, plain vs Spotlight 110,
   all-areas box vs largest cluster, and judge by eye with the Read tool that the change is
   visible in each thumbnail. Record the outcome in `docs/decisions.md`.
8. Same rule in the viewer: the Flash note `alternating, about 1.5 times a second` leaves the image;
   the panel label strip says which image is showing, updating with each flash: `Baseline
   (flashing)` / `New (flashing)`. The zoom locator map leaves the frame and sits at the right end
   of the New panel's label strip (a 60 x 16 strip map), never over pixels.

### 2.2 "master has 1,242 newer baselines since this capture." wraps and takes space

Before: `#snap-stale` banner (`drawStale()` list.js:838): a warn-tinted block between the header
and the list, five lines at 1440 px, nine at 1024 px with a button over the words. Its 1,242 sits
under `of 1,242 decided` and means something else. It does not say whether to act. The change row
repeats it twice.

After:
1. No banner. One chip on line 1 of the Snapshots header, never wrapping, carrying its count:
   `Behind master: 1,242` (warn-colored mark and text, no tinted block; it does not block Finish).
2. The chip is a menu button (no key; not a frequent action). Its menu reads, true to
   `docs/updating.md`:
   - `Master accepted 1,242 newer baselines after this capture.`
   - `Your decisions stay valid unless master changed the same images. If it did, updating first
     saves reviewing them twice: Update from master merges master in and CI captures again.`
   - `See what changed on master` (the existing `chgonmaster` box)
   - `Update from master...` (existing `updatefrom`)
3. A newer capture arriving: the chip `Newer capture` in the same slot, menu `A newer capture
   (abc1234) is ready. Your decisions on unchanged images are kept.` + `Load it`. When it arrives
   during a visit it is also said once in the message line with its `Load it` button (a message
   with a button stays until used or dismissed), so a reviewer looking at images sees it.
4. When both chips apply and line 1 is tight, they fold into one `2 notices` chip whose menu holds
   both, before the change number is cut (see 2.4 item 3).
5. Change row (Changes pane): the two badges become one: `behind master`. `shares 2188 baselines
   with #1677` leaves the row for About this change (with its comma: `2,188`).
6. Drop `role="status"` from the three banner hosts in index.html:48-50; the message line is the
   one live region and carries the newer-capture notice.

### 2.3 "1,167changed73new2removed" under the progress bar

Before: header line h3 is a row of three filter buttons (`statusEntries()` list.js:622,
`foldStatus()`, actions `statshow`, `statmore`). They count all 1,242 snapshots while the list
shows the 34 undecided, and they set the same filter as the `Undecided (34)` menu below. Separately,
`1,208 of 1,242 decided` counts 1,208 images accepted before this capture that the reviewer never
looked at, so his own work cannot be told from the carry-over.

After:
1. Delete line h3, `statusEntries`, `foldStatus`, `statshow`, `statmore` (and their covers.mjs
   entries). Header gains 24 px.
2. The progress line (h2) leads with the number the reviewer acts on and separates his work from
   the carry-over: `**34 left**   1,208 accepted earlier` before he decides anything; after,
   `**22 left**   12 decided, 1,208 accepted earlier`. Zero parts are omitted. Bar under it
   unchanged (it still fills with both). `scripts/uat.mjs` and the tests change their regex, not
   the screen.
3. The Show menu is the one status filter. Its button names the setting and shows the shown count
   only while filtered away from Undecided: `Show: Undecided`, `Show: Rejected (3)`. Menu items,
   sentence case, count right-aligned: `Undecided  34`, `All  1,242`, `Changed  1,167`, `New  73`,
   `Removed  2`, `Accepted earlier  1,208`, `Accepted  12`, `Rejected  0` ... (zero items greyed,
   not hidden).
4. Small change (10 or fewer): `**3 left**` alone until something is decided.
5. Change summary (before opening): `653 changed 65 new 2 removed` in bold becomes a plain
   sentence `720 snapshots: 653 changed, 65 new, 2 removed`.
6. The Finish sheet uses the same split: `Saves 12 you accepted and 1,208 accepted earlier to
   <branch>, as <name>.`

### 2.4 "busy, confusing, a cockpit"

Root causes: 29 boxed keys at once giving every control equal weight; 13 toolbar controls; six
header layers (270 px) above the first row; the same count shown four or five times; three filled
colored buttons; a three-column load screen with an empty viewer; a list where every group header
carries three controls.

After, in order of effect:
1. **Two key tiers, both visible.** Boxed keys (`kbd`, today's style) only on the loop: the view
   segment (V F H S), the decision bar (J K U E R A), and Enter/Esc in boxes, sheets and the end
   card. Every other control prints its key as muted plain text after its label (`kbd.quiet`: no
   border, no background, `--muted` ink, same element so tests and `syncHints()` keep working).
   `control()` (actions.js:695) also sets `aria-keyshortcuts`.
2. **Toolbar from 13 controls to 7**: view segment (4), `Blink  L` beside Highlight (as today, a
   mode of Highlight, greyed outside it), `Zoom: Fit  Z`, `Display` menu.
   - Zoom: `Z` keeps today's meaning, one press cycles Fit, 1x, 2x, 4x, 8x. A click on the button
     (or Enter on it when focused) opens its menu: `Fit 0`, `Actual size 1`, `2x 2`, `4x 4`,
     `8x 8`; the digits act with the menu closed via `data-menukeys`. The button's label shows the
     current step.
   - Display (no key of its own; M is not added): `Show baseline  P`, `Image only  Shift+3`,
     `Layout: Auto  Y`, `Outline changed areas  B`, `Start zoomed on the change  O`. Toggles show a
     check mark. Every one of those keys acts with the menu closed (`data-menukeys`), each in one
     press: P, Shift+3, B, O toggle; `Y` cycles Auto, Side by side, Over and under (today Y opens
     a menu; a menu opened by a key stops every other key, keys.js:228-236, so Y becomes a cycle
     and the item's submenu is reached by pointer or Enter).
   - Technical details leaves the toolbar: a quiet `Details` text button at the end of the item
     line, next to the size it explains. `Copy link to this image` moves into that Details panel;
     the List menu's item is renamed `Copy link to this list`.
3. **Snapshots header from six layers to three** (about 96 px instead of 270):
   - line 1: `#4455` (never cut) + change title (cut first, full title in tooltip), chips (2.2),
     fold button `< Shift+2` at line end. Drop order when tight: title to `...`, then the two
     chips fold into `2 notices`; the number and the fold button never go.
   - line 2: the progress line (2.3) + bar. When tight the `accepted earlier` part goes first, then
     `decided`; `N left` never goes.
   - line 3: `Find, or #number  /`, `Show: Undecided`, `List` menu button, and the Up/Down pair
     (quiet `Up` / `Down` keys, today's `stepSnap`). Drop order: the Find placeholder shortens to
     `Find  /`, then to `/`; the Show value is never cut (it is the active filter).
4. **Say each count once.** `34 left` in the header and, stacked, on the rail. Decision bar drops
   `#1028, 34 left`. Message on open: `Opened #4455: 34 left.` Area counter only while zoomed
   above Fit (2.4 item 11), so at Fit no third "N of M" sits on screen.
5. **One loud button.** Accept is the only filled button. Reject: red outline, red text and mark.
   Finish: `Finish #4455...` in a primary-colored outline (never the grey of a disabled button)
   while anything is left, filled once nothing is left, same position.
6. **One selected style per meaning.** The view segment shows exactly one filled button (in Flash,
   Flash is filled and Spotlight is not; "flashing over Spotlight" is said in the label strip).
   Toggles inside menus show a check mark. Blink, the one toggle left in the toolbar, shows a check
   mark before its label when on. The pressed style (`button[aria-pressed=true]`, page.css:726
   inset ring) is deleted; focus keeps its outline and is the only thing drawn in that style.
7. **No empty viewer.** With no change open the page has two parts: the Changes list and the
   selected change's summary drawn in the viewer's area (title, `720 snapshots: 653 changed, 65 new,
   2 removed`, `648 left`, source and age, `Open [Enter]`). The middle Change pane, its Hide and the
   `Choose a change on the left...` card are deleted. A link with `change=` always opens that
   change.
8. **Quieter list.** Group headers are one line with two controls: the chevron toggles collapse;
   the name button `name (3)` (count muted inline, name middle-cut first) opens the group's menu
   (its former `...` items plus Collapse/Expand); then `Accept 3`. Every group's Accept has a
   neutral outline so it reads as a button; only the current group's is green and prints
   `Shift+A`. Row checkboxes stay in place (no layout shift), drawn in the muted border color until
   the row is hovered or a selection exists. `dark` / `light` pills become muted text after the
   story name (`graph-file, dark`). Only the story name is bold.
9. **One place to act on a selection.** The selection bar shows `3 selected`, `Clear [Esc]`, and
   `...` (Extend up, Extend down, Select all shown). Its Accept 3 / Reject 3... / Exclude 3... are
   deleted; with a selection the decision bar reads `Accept 3`, `Reject 3...`, `Exclude 3...`
   (`3 selected` is already in the selection bar).
10. **Decision bar fits 654 px with a selection.** Previous / Next print their letter boxed and
    their arrow quiet: `Previous [J] Left`, `Next [K] Right` (Up/Down are not printed here; they
    belong to whichever list owns them, keys.js:248-256, and are printed on that list's header).
    When the viewer is under 760 px wide, the words `Previous` / `Next` drop to their keys with an
    `aria-label`, then `Undo` drops its word; the decision words never drop. Budget at 654 px with
    a selection: about 90 + 80 + 73 + 120 + 115 + 110 = 588 px.
11. **Item line.** `Back  Esc`, `#1028 [mark] changed`, story name, size (`490k px`), badges,
    `Area 1 of 26  Next area  N` (counter only above Fit; at Fit `Next area  N`; only with more
    than one area), `Select  X  Shift+Up/Down` (quiet; Shift+Down is how a selection starts, so it
    is printed where the reader starts one), `Details`. Drop order when tight: badges other than
    `unstable` and `resized` first, then size, then cut the name (never below 24 characters);
    `unstable` and `resized` never drop.
12. **Top bar trimmed.** `New capture...` leaves the top bar (it stays on the Captures screen).
    `Updated 1 min ago` becomes muted text plus a small `Refresh` button, shown only when the data
    is older than 5 minutes or offline. `Next change  Shift+N` moves here, left of Finish, as its
    one home (removed from the Snapshots title line and the Changes header; the end card keeps its
    own). Finish and Next change show only on the Review screen. Drop order at 1024 px: the
    repository name first, then the age text (it moves into Refresh's tooltip and `aria-label`);
    Finish never leaves the screen.

## 3. Anticipated similar problems

### Accepted (each with its change)

| Problem | Change |
|---|---|
| Change-row status line cut mid-word (`behind r`, `shares 2188 base`) | Line 2 holds at most two facts: `34 left of 1,242` and one badge (`behind master`, `140 MB to download`, `overlaps #1677`). More badges fold to `+1 more` with the list in its tooltip. Never cut a word. |
| Change-row details joined by double spaces | Join with ` - `; drop `N projects ready` when all are ready. |
| Numbers without separators (`1208`, `2188`) | One formatter (`fmt`) for every count, including Finish sheet and badges, plus the short `k` / `M` form for pixel sizes. |
| `+1` pill with no noun | Show the hidden badge word when one is hidden; `+N more` only for 2 or more, words in the tooltip. Shorter badge words: `size changed` -> `resized`, `attempts disagree` -> `unstable`, `same as 4 others` -> `+4 identical`; `resized` and `unstable` never fold, on rows or the item line. Fix tooltip grammar `1 other`. |
| `Approved before 1,208 (already accepted)` pinned first with Show + `...` | Moves to the bottom of the list, collapsed, one quiet line `Accepted earlier (1,208)`; chevron + name menu like every group (Reject N..., Exclude N... kept); Show deleted. Row words `Accepted earlier (#1356)`. |
| Menus named by value (`Component`, `Spotlit, zoom auto`) | Every menu button names its setting: `Show: Undecided`, `Zoom: Fit`, `Layout: Auto`, and inside List `Group by: Component`, `Pictures`. When tight, the value is never cut; other parts of the line give way first (2.4 item 3). |
| Jargon | Panels are always `Baseline` and `New` (no `Spotlit new`). One name per effect: `Spotlight` in the viewer and `Spotlight rows` in the List menu, tooltip `Dims what did not change`. `Auto: when the change is small (2x Fit or more)` -> `Zoom to the change: when it is small` / `always` / `never`. `No pictures (text rows)` -> `Text only, no pictures`. `Open centered on the area` -> `Start zoomed on the change`. `Outline` -> `Outline changed areas`. `Approved before` -> `Accepted earlier`. `Changed on master` / `newer baselines` / `behind master` -> `behind master`. Every remaining term gets a one-line tooltip. Keep the `docs/the-screens.md` glossary in step. |
| Esc leaves the change by accident (a second Esc after clearing a selection or closing a box) | Esc keeps "back one level" (it is in the always-on key set, and Backspace is a worse accident key and is labelled `delete` on Macs), but it goes back only when nothing is on top AND the previous key press was not an Esc that closed or cleared something. The second Esc instead says in the message line `Press Esc again to go back to the changes.` After going back: `Back to the changes. Enter opens #4455 again.` |
| Zooming to 4x shows blank panels | Every zoom step centers on the current area (`Start zoomed on the change` governs only the first open). |
| A blank or still-loading panel looks broken | Each panel's label strip states it: `New (loading)`, `Baseline (missing)`, `New (blank image)`. |
| Toolbar clips at 1024 px (P, Y, B, O, Shift+3 lose their control) | Fixed by the 7-control toolbar; 1024x768 tests (section 6) that every keyed control is wholly inside the viewport. |
| Spotlight turns a many-area change into a dark slab | `SPOT_ALPHA` 190 -> 110, viewer and rows (2.1 item 6). |
| Changes rail `Shift+1` box clipped in the 43 px rail; rail badge words would not fit | Rail key stacked: `Shift` over `1`, quiet style. Rail badge stacked too: the number over a short word (`7` / `left`, `34` / `left`), each line under 40 px; tooltips `7 changes need you`, `34 snapshots left to decide`. Never a bare number. |
| Message line keeps stale text | A plain message clears on the reader's next action. A message with a button (Undo, Retry, Load it) stays until used or dismissed. A message reporting a bulk decision (`Accepted 34 in graph-file`) stays until the next decision. History only behind `Messages`; the Keys sheet's copy of the last 20 messages is deleted. |
| Keys sheet: four-line descriptions, no order | Grouped by task: Decide, Move, Look, Panes, Select. One short line each (`Enter`: `Open, or press the button that shows Enter`; `Esc`: `Close or clear; again to go back`). Checkbox `Single-letter keys` with muted line `Off: only arrows, Enter, Esc, Tab and Space work.` Edge cases go to docs/keys.md. |
| Finish sheet: plumbing paragraphs, `6-/hour`, zeros printed | Title `Finish #4455`, PR title on a muted line below, wrap only at spaces. Three lines: the save line (2.3 item 6, zero parts omitted), `34 left: they will block the merge  [Go to the first]`, `GitHub check: Reviewed`. Commit status text, signing progress and the shell command go under one closed `Details` disclosure. |
| Settings: adapters table among reviewer choices | Order: Theme, Highlight color, Single-letter keys, Passkeys, Picture storage. Adapters and disk detail under a closed `Repository setup` disclosure at the bottom; a problem there shows as `Repository setup: 1 problem` on the closed summary. |
| Focus-visible `Enter` hint widens the focused button | Draw it absolutely positioned outside the button box. |
| Muted text on tinted group headers at 3.44:1 | Raise muted ink on tints; extend `test/page/contrast.test.mjs` to text on every tint, including the quiet keys and the zoomed-thumbnail bar. |

### Rejected (one line each)

- Bigger thumbnails (230 x 90): breaks the 7-rows-at-1440 floor; removing the pills already gives the picture back.
- A Spotlight-strength setting: one constant covers it; no new setting.
- Backspace as the back key (first draft): ignored with letter keys off, a common correction key, and labelled `delete` on Macs; the guarded Esc replaces it.
- Z opening the Zoom menu (first draft): a key-opened menu swallows the next key; Z stays a one-press cycle.
- A `View [M]` menu (first draft): it was the old toolbar in a list, collided with the view segment, and M is a new key with no mnemonic; Display holds only once-a-session settings and has no key.
- Up/Down printed on Previous/Next (first draft): they act on whichever list owns them, so the bar would lie when the Changes pane has them.
- Moving Blink into a menu: it is a mode of Highlight and its state is invisible in a menu.
- Hover-only checkboxes: they either save nothing or move content under the pointer, and hide the pointer path to multi-select.
- Quiet borderless group `Accept N`: reads as a status; all keep a neutral outline.
- Area counter in the toolbar: a fact about the snapshot, so it stays on the item line.
- Select [X] moved into the decision bar: the bar must stay identical for every snapshot (locked principle 4).
- Roving-focus list, F6 pane cycling, a skip link, headings outline: real accessibility work, but additions; file separately.
- One-pane mode under 900 CSS px (200% zoom): a new layout mode; file separately.
- Reduced-motion Flash that stops alternating: Flash is opted into and the alternation is the feature.
- Message line fading on a timer: the clearing rules above cover it without timers.
- Hiding Refresh entirely when fresh: Refresh stays visible when shown; it only hides with the age text when the data is fresh.
- Status breakdown of what is left in the progress line (`34 left: 30 changed, 4 new`): it lives in the Show menu.
- Dropping the Accepted-earlier group menu: Reject N... / Exclude N... on already-accepted images is a real capability.
- Moving Next change only to the end card and the rail: needed before the end, so it gets one fixed home in the top bar.

## 4. Control inventory: opened-change view (1440 x 900, Changes folded to its rail)

Key column: `[K]` boxed key, `K` quiet printed key, `(closed)` printed on a menu item and acting
while the menu is closed through the menu button's `data-menukeys`.

| Before (control, key) | Where now | After |
|---|---|---|
| Tabs Review / Baselines / Captures | top bar | stays |
| New capture... | top bar | moves to Captures screen only |
| Updated 1 min ago (button) | top bar | muted text + small `Refresh`, only when older than 5 min or offline |
| Keys [?] | top bar | stays, `Keys ?` quiet |
| Settings | top bar | stays |
| Finish #4455 (1,208), filled blue | top bar | `Finish #4455...`, primary outline until 0 left, then filled |
| Changes rail [Shift+1] | left rail | stays, key stacked, badge `7` / `left` stacked |
| Title link `#4455 ci: run t...` | Snapshots line 1 | `#4455` never cut, title cut first |
| Next change [Shift+N] | Snapshots line 1 | moves to top bar, `Next change  Shift+N` |
| Hide [Shift+2] | Snapshots line 1 | compact fold `< Shift+2` at line end |
| -- | Snapshots line 1 | chips `Behind master: 1,242` / `Newer capture` (menus), fold to `2 notices` |
| 1,167 changed / 73 new / 2 removed (+N more) | Snapshots h3 | deleted; Show menu carries them |
| Find [/] (+ Clear [Esc] while text) | Snapshots h4 | line 3, `/` quiet |
| Up [Up] / Down [Down] | Snapshots h4 | line 3, quiet keys |
| Show: Undecided (34) | Snapshots h5 | `Show: Undecided` (count only while filtered), line 3 |
| Group: Component | Snapshots h5 | into `List` menu as `Group by: Component` |
| Pictures: Spotlit, zoom auto | Snapshots h5 | into `List` menu as `Pictures` section (`Spotlight rows`, zoom, text only) |
| `...` (Accept all shown, Undo all, JUnit, Copy link) | Snapshots h5 | `List` menu, Copy link renamed `Copy link to this list` |
| Changed on master / Update from master... | banner | into `Behind master` chip menu |
| Load it | banner | into `Newer capture` chip menu and the message line on arrival |
| Approved before: toggle, Show, `...` | list top | list bottom: `Accepted earlier (1,208)` chevron + name menu; Show deleted |
| Group: chevron, Accept N [Shift+A], `...` | each group header | chevron toggles; name opens the group menu (`...` merged in); `Accept N` outlined everywhere, green + `Shift+A` on the current group |
| Row checkbox | each row | stays, muted until hover or selection |
| Selection bar Accept N / Reject N... / Exclude N... | list header | deleted; decision bar `Accept 3` / `Reject 3...` / `Exclude 3...` |
| Selection bar Clear [Esc], `...` (Extend up, Extend down, Select all shown) | list header | stays |
| Side by side [V], Flash [F / hold Space], Highlight [H], Spotlight [S] | toolbar | stays, boxed, one filled |
| Blink [L] | toolbar | stays beside Highlight, `L` quiet, check mark when on |
| Zoom [Z] + Fit [0] 1x [1] 2x [2] 4x [4] 8x [8] | toolbar | `Zoom: Fit  Z` (Z cycles as today; click opens the menu); items `Fit 0` ... `8x 8` (closed) |
| Baseline [P] | toolbar | `Display` menu: `Show baseline  P` (closed) |
| Image only [Shift+3] | toolbar / More | `Display`: `Image only  Shift+3` (closed) |
| Layout: Auto [Y] | toolbar / More | `Display`: `Layout: Auto  Y`; Y cycles the three layouts (closed) |
| Options: Outline [B], Open centered [O] | toolbar | `Display`: `Outline changed areas  B`, `Start zoomed on the change  O` (closed) |
| Options: Details | toolbar | item line `Details` |
| Options: Copy link | toolbar | Details panel `Copy link to this image` |
| More, Options | toolbar | deleted (merged into `Display`) |
| Back to changes [Esc] | item line | `Back  Esc` (guarded, see section 3) |
| Next area [N] + `1 of 26` | item line | `Area 1 of 26  Next area  N`; counter only above Fit |
| Select [X] | item line | `Select  X  Shift+Up/Down` |
| Open [Enter] (two-level change) | item line | stays |
| -- | item line | size `490k px` and `Details` |
| Locator map | over the image | label strip of the New panel |
| Previous [Left][J] / Next [Right][K] | decision bar | `Previous [J] Left`, `Next [K] Right` |
| `#1028, 34 left` | decision bar | deleted |
| Undo [U], Exclude... [E] | decision bar | stays |
| Reject... [R] filled red | decision bar | red outline |
| Accept [A] filled green | decision bar | stays, the only filled button |
| Messages | message line | stays |

Counts: visible controls drop from about 72 to about 42 (toolbar 13 -> 7, header 6 layers -> 3,
group headers 3 controls -> 2, selection bar 6 -> 3); boxed keys from 29 to 10 (V F H S J K U E
R A).

Key check, every key in the Keys sheet after the change:

| Key | Visible control printing it |
|---|---|
| A, R, E, U | decision bar buttons, boxed |
| J, K | decision bar Previous / Next, boxed |
| Left, Right | decision bar Previous / Next, quiet |
| Up, Down | Up/Down pair on the header of the list that owns them (Snapshots, Changes, Baselines, Captures); `syncHints()` shows them on one list at a time |
| Shift+Up, Shift+Down | item line `Select  X  Shift+Up/Down`; also the selection `...` items |
| V, F (hold Space), H, S | view segment, boxed |
| L | toolbar `Blink` |
| Z | toolbar `Zoom: Fit` (cycles) |
| 0, 1, 2, 4, 8 | `Zoom` menu items (closed) |
| P, Shift+3, Y, B, O | `Display` menu items (closed) |
| N | item line `Next area` (only with more than one area, as today) |
| X | item line `Select` |
| Shift+A | current group's `Accept N` |
| Shift+N | top bar `Next change` |
| Shift+1, Shift+2 | Changes rail / Snapshots fold button |
| / | Find placeholder |
| ? | top bar `Keys` |
| Enter | Open (rows, item line), end card Finish, box defaults |
| Esc | Clear (selection, Find), Close / Cancel in boxes and menus, item line `Back` |

No key is removed or added. One key changes meaning: Y cycles the three layouts instead of
opening a menu. Esc keeps "back" behind a guard against the double-Esc accident.

## 5. What NOT to change

- One action table builds both buttons and keys; a key acts only through a visible control
  (`control()`, `syncHints()`, zone ranking). The spec only moves controls inside that system.
- Decision safety: the quarter-second unseen-image guard, a held key decides once, A/R/E never
  reverse a decision, focus never turns a key into a decision.
- The decision bar is identical for every snapshot and never wraps; Finish stays fixed top right
  and on screen at 1024.
- Viewer at least 800 px wide while it shows a snapshot at 1440; toolbar one row, never clipped.
- The four views and their keys; Spotlight stays the default viewer view; hold Space to flash.
- Bulk first: group `Accept N` / Shift+A, selection with X and Shift+arrows, Same change grouping.
- Status by mark and word (grayscale-distinct marks), color only on the shape.
- Never cut the story name below 24 characters or the decision word.
- Reason box flow for Reject / Exclude, recent reasons.
- End card (`All 720 decided`, Finish [Enter], Next change [Shift+N]).
- Small-change folding of the header (10 or fewer snapshots).
- Renderer-changed panel replacing the rows.
- Offline state disabling writes; letter-keys switch hiding letter hints.
- Every Finish, passkey and signing behavior (wording in the sheet changes, steps do not).

## 6. Tests and docs that move with this

- `test/page/list.page.test.mjs`: header budget (three lines, new heights), delete `.h3` and
  `[data-status]` checks; `.ztag` checks (594-610) become "no element over `.pic`" and
  `.pic.zoomed` + row text `zoomed 7x` + size words; Show label `Show: Undecided`; progress line
  `left` / `decided` / `accepted earlier`.
- `test/page/decide.page.test.mjs` 938 / 1068: chip `Behind master: N` and its menu text instead of
  `#snap-stale`; selection bar without bulk buttons; decision bar `Accept 3`.
- `test/page/viewer.page.test.mjs`: Z still cycles; Zoom menu by click and digits while closed;
  Display menu items and their keys while closed; Y cycles layouts; Blink stays in the toolbar;
  More/Options gone; locator in the label strip; Flash label text; Details on the item line.
- `test/page/keys.page.test.mjs`: Esc goes back; a second Esc right after an Esc that cleared
  something does not, and says so; Shift+Down printed on Select.
- `test/page/rows-and-panes.page.test.mjs` and `scripts/uat.mjs`: Previous/Next print J/K boxed
  and Left/Right quiet; Up/Down printed once, on the owning list; new progress-line regex.
- `test/page/changes.page.test.mjs`, `changes-model.test.mjs`: badge `behind master`.
- `test/page/frame.page.test.mjs`: Keys sheet without messages; Settings disclosure; top bar drop
  order; newer-capture message with `Load it`.
- `test/page/covers.mjs`: remove `statshow`, `statmore`, `accsel`, `rejsel`, `excsel`, `options`,
  `more`; `zoom-*`, `baseline`, layout and display toggles become menu items (ids kept); add
  `displaymenu`, `zoommenu`, `stalechip`.
- `test/page/contrast.test.mjs`: text on every tint, quiet keys.
- New 1024 x 768 tests: every keyed control wholly in the viewport (a) with a change open, (b) with
  3 rows selected, (c) with stale data and both chips; the decision bar on one line in each.
- Docs: `docs/the-screens.md`, `docs/keys.md` (Esc guard, Y cycle, Display menu, Shift+Down on
  Select), `docs/decisions.md` (records: nothing drawn on pictures, two key tiers, the thumbnail
  choice from 2.1 item 7, `accepted earlier` split, Y cycles).

## 7. Second pass: defects and calm (2026-10-31, after the first build review)

The first build was reviewed against before/after captures at 1440, 1280 and 1024. Where this
section and sections 2-6 disagree, this section wins.

### 7.1 Defects to fix (the first build broke or never met the spec)

1. **Pictures never disappear.** Opening a menu, toggling a setting or any other re-render that
   does not change the snapshot or the pixels a pane shows keeps the drawn pictures (call the stage
   with `keep`). When the pixels do change (new snapshot, new view, new zoom), the old pictures stay
   on screen until the new ones are ready; `Loading baseline...` on blank grey shows only on the
   first draw of a snapshot whose images are not cached yet, and only after 300 ms.
2. **Zoom shows the same place on both sides, resized snapshots included.** Every zoom step centers
   on the current area in New-image coordinates and maps that point into the baseline the way the
   diff aligns the two (top-left), so both panes show the same place. When that place lies outside
   the smaller image, that pane's label strip says `Baseline (outside this image)` instead of
   showing grey. A 1024 and 1440 test opens a resized snapshot at 4x and checks that both panes
   draw non-blank pixels around the area.
3. **One view at a time.** Flash is a view, never a toggle on Spotlight. In the view segment exactly
   one button is filled and none carries a check mark. F (or Flash) from Spotlight switches to
   Flash and flashes the spotlit pair; the label strip says `Baseline (flashing, spotlit)` /
   `New (flashing, spotlit)`. Leaving Flash (V, H, S) ends flashing: S after H is plain Spotlight.
   Hold Space keeps flashing only while held, then returns to the view it left.
4. **Image only gives back exactly what it took.** Shift+3 a second time restores the panes as they
   were before the first press (folded stays folded, open stays open), and the message says
   `Image only off: panes back as they were.` The remembered-panes store and the floor rule must not
   overwrite the saved pair in between. While Image only is on, `Back  Esc` stays visible in the
   merged toolbar.
5. **Laptop width (1024 x 768) keeps every name.** Previous, Next and Undo always keep their words;
   the fixed 760 px threshold is deleted. The decision bar fits by the 2.4 item 10 budget (588 px
   at 654 px). If it ever overflows, the quiet `Left` / `Right` after J / K shorten to `<-` / `->`
   (ASCII), never removed. Find keeps the word: `Find  /`. On the item line, `Details` and the
   `resized` / `unstable` tags never shrink (`flex-shrink: 0`); the story name is cut first. Group
   names are cut keeping their end (`...fidelity-cx-specimens`), so sibling groups that share a
   prefix stay distinct; a test fails when two visible group headers read the same. A 1024 test
   checks every visible control's box lies wholly inside the viewport.
6. **Every key printed at every width.** `Shift+Up/Down` leaves the Select button (it was dropped
   at 1280 and below). The List menu gains a `Select` section, always reachable on Snapshots line 3:
   `Extend selection up  Shift+Up`, `Extend selection down  Shift+Down`, `Select all shown`,
   acting with the menu closed. The selection bar's `...` button gets a word: `More`.
7. **Group actions are visibly a button.** The group name button draws a small CSS caret (a
   bordered triangle, no unicode glyph) after the name and underlines on hover; tooltip
   `Group actions`. Its menu lists `Accept N  Shift+A` (current group), `Collapse`, `Reject N...`,
   `Exclude N...`, `Select all N`.
8. **The owner's link works.** Before handing off, restart servherd `proofroom-studio` with
   `HOST=dev.ato.ms` (not 0.0.0.0) and check the brief's `#token=` link loads the review page.

### 7.2 Calmer (the cockpit complaint, which reviewers judged still open)

The first build cut controls from 72 to 65 and boxed keys from 29 to 23; the target was about 42
and 10. These close the gap:

1. **Each count once in the list.** Group headers drop `(N)`; the count lives in `Accept N`.
   `Accept N` shows always on the current group (green, `Shift+A`) and on other groups only while
   the header is hovered or focused; on every group it is also the first item of the name menu, so
   the pointer path and the capability stay visible. (Supersedes 2.4 item 8 and the rejected
   "quiet group Accept" line: the button is not quiet, it is shown where the reader is.)
2. **`resized` on rows is a word, not a pill.** On rows it is muted text after the story name like
   `dark` (`graph-file, dark, resized`); on the item line it stays a tag. `unstable` stays a pill
   (rare, needs attention).
3. **Item line holds no repeat.** Drop the size (`490k px`) from the item line; it is on the row and
   in Details. The item line is `Back  Esc`, `#1028 [mark] changed`, story name, tags,
   `Next area  N` (with counter above Fit), `Select  X`, `Details`.
4. **Blink only in Highlight.** L does nothing outside Highlight, so Blink is not drawn outside it
   (no greyed control taking space). In Highlight it sits beside the segment as today.
5. **Boxed keys only on the loop.** Exactly V F H S and J K U E R A are boxed. Every other printed
   key is plain muted text with no border and no background; check by eye in a capture, not only by
   class name.
6. **Rails read horizontally.** No rotated text. The rail widens to 56 px and stacks, horizontally:
   the badge (`7` / `left`), the pane name at 11 px (`Changes`, `Snaps`), and the key `Shift+1` on
   one line, quiet.
7. **Words for the change said once.** Top bar Finish reads `Finish review...` (the title already
   names the change; filled once nothing is left). The open message reads `Opened: 34 left.`
8. **Numbers.** Sizes in the change row use one formatter: `1.9 GB to download`, `140 MB to
   download`, never `1984 MB`.
9. **Reject / Exclude box heading on one line**, the story name middle-cut with `...`, full name in
   the tooltip.

Expected count on the opened change at 1440, Changes folded: about 48 controls, 10 boxed keys.

### 7.3 Rejected in this pass

- Merging the toolbar and the item line into one row: does not fit the 800 px viewer floor with
  seven toolbar controls; the item line lost its repeats instead.
- Hiding quiet keys until hover or focus: the owner's rule wants the key on the visible control.
- Dropping the locator: at 2x and above it is the only "where am I"; it stays in the label strip.
- A "most snapshots resized" header note: the muted word on each row already costs nothing.

## 8. Third pass (2026-11-01, after the second build review)

Where this section and sections 2-7 disagree, this section wins. Reviewers judged complaint 1
(the thumbnail) and complaint 4 (the cockpit) still open, found the test suite red, and found
regressions in zoom and the Finish sheet. Complaints 2 and 3 are closed.

### 8.1 Defects: the branch is not done while any of these stands

1. **The whole suite passes.** `test/page/plain-git.page.test.mjs` hangs at 60 s, also alone. Find
   the step that hangs (run it with a trace or step logging, do not guess) and fix the page, not the
   test, when the flow is broken. The likely cause is 8.3 item 7: the test reads why plain git
   cannot do something in Settings, and that text now sits in a closed disclosure.
   `test/finish-change.page.test.mjs` passes again by 8.1 item 2, not by editing its assertion.
2. **The Finish sheet says who signs.** `Signs with: Passkey '...'` (or why nothing is signed) is on
   the sheet's main body, right above the confirm button, never inside Details. Signing progress,
   commit status text and the shell command stay in Details.
3. **Zoom zooms, and the locator shows.** Re-capture 4x on the resized `images-charts-p-6`
   snapshot, waiting on the stage's drawn zoom, not on a timer. If 4x draws at Fit, fix it: the
   toolbar's `Zoom: 4x` and the pixels must always agree, including right after V and after a
   digit key. At 2x and above the 60 x 16 locator sits at the right end of the New panel's label
   strip (7.3: it is the only "where am I"). A test presses `4` on a resized snapshot and checks
   the drawn scale and the locator.
4. **Hiding the baseline is visible.** With the baseline hidden (P), the space where Baseline was
   is not silently gone: the remaining panel's label strip reads `New` and, at its left end, a
   button `Show baseline  P` (quiet key). The Display button reads `Display: baseline hidden`
   while it is hidden. Both go when P shows it again.
5. **Panels are named `Baseline` and `New`** in every view; delete `Spotlit new` (viewer.js
   `leftLabel` / `rightLabel`).
6. **A control does not come and go with the window width.** Find why `Open  Enter` shows on the
   item line at 1280 and 1024 but not at 1440 for the same snapshot; it shows for the same
   snapshot at every width or at none.
7. **The story name on the item line is never cut below 24 characters** (section 5); at 1024 it
   read `i...`. The cut order is: tags other than `unstable` and `resized`, then the name down to
   24 characters; if it still does not fit, the item line wraps to a second line rather than cut.
8. **Unexplained count change.** `Seed from master` went from 648 left to 646 left during a run
   while its decisions file stayed empty. Find the cause from the scratch clone (did its master
   or the change's capture move between the two reads?) and say it in the report. If the page or
   server changed two decisions without a reader's action, that is a data-safety defect: fix it
   and add a test.

### 8.2 The thumbnail shows the change (complaint 1, still open)

The labels are off the picture, but at the row's size most pictures were 60% flat Spotlight grey
with the change impossible to see, and every row said `zoomed 4x` over a picture that looked
unzoomed.

1. **Spotlight only where it helps.** A row picture is spotlit only when the changed areas cover
   less than a third of the part of the image the row shows. Otherwise it is the plain New image:
   when the whole thing changed, dimming hides everything and shows nothing.
2. **No grey filler.** The row crop is clamped inside the image. When the image is narrower than
   the crop at the row's shape, the picture is centered and the band beside it is the row's own
   background, not the Spotlight grey.
3. **Row words say what changed, once.** Row line 3 reads `66 changed areas` (`1 changed area`).
   `zoomed 4x` and the pixel size leave the row: the picture's tooltip says what part of the image
   it shows (9.2 item 5); the size stays in Details. The empty third line goes: a row is three text lines, the
   areas line directly under the story name.
4. Checked by eye before kept: capture the first 40 rows on the studio server at 1440 and 1024 and
   judge with the Read tool, row by row, whether the change can be seen. Record the count of rows
   where it can, before and after, in `docs/decisions.md`.

### 8.3 Calmer, round three (complaint 4, still open)

The reviewers' measure: about 64 controls on the opened change against the 48 aimed for, a
590 px List menu covering two thirds of the screen with `Undo all decisions...` next to `Accept all
shown`, three bulk Accepts at once, four numbers per row, a title that says nothing, and a cramped
find row. Most of what remains is per-row and per-group structure a list needs; this round removes
what makes it read as a cockpit: big mixed menus, repeated numbers, and controls that look alike
but do unlike things.

1. **The change's own menu.** Line 1's `#4455 ci: run th...` becomes a menu button with the CSS
   caret of 7.1 item 7 (no key; tooltip is the full title). Its menu: the full title as a heading,
   wrapped, never cut; `Open on GitHub` (the code host's name; today's `onhost` action and link);
   `Copy link to this list`; `Download the comparison report (JUnit)`; a separator; `Undo all
   decisions...`. Change-wide and rare things live with the change's name, and the one destructive
   bulk action sits apart from every Accept.
2. **The List menu is about the list only.** It holds `Group by` (5), `Pictures` (Spotlight rows,
   Zoom rows to the change: `When small` / `Always` / `Never`, `Text only, no pictures`) and
   `Select` (Extend up `Shift+Up`, Extend down `Shift+Down`, Select all shown). The `Auto: when the
   change is small (2x Fit or more)` item reads `When small`, its tooltip keeps the rule. The menu
   is at most 460 px tall at 1440 x 900 and opens over the list pane, left-aligned to it, never
   over the viewer's pictures when the list pane is wide enough to hold it.
3. **Accept all shown lives with Show.** `Accept all 34 shown...` is the last item of the Show
   menu, under a separator: it acts on what Show shows, so it sits with Show. Its confirm box is
   unchanged.
4. **One bulk Accept on screen at a time.** While a selection exists, group headers draw no
   `Accept N` (the decision bar's `Accept 3` is the bulk action); the group's name menu still lists
   `Accept N  Shift+A`, so Shift+A keeps a visible control and keeps working.
5. **Notices look pressable.** The `Behind master: 1,243` chip (and `Newer capture`, `2 notices`)
   is an outlined button with the 7.1 item 7 caret; only its small mark is amber, the text is
   ordinary ink. Its menu is unchanged.
6. **Find row.** Placeholder `Find  /` (tooltip `Find a story, or #number`). Up and Down use the
   same text size and height as Show and List. Up and Down stay (they print the Up and Down keys).
7. **Settings says the problem.** When Repository setup has problems, its disclosure starts open and
   its summary names the first one in plain words (`Repository setup: CI takes no capture requests`,
   `+1 more` when there are more). With no problems it stays closed and reads `Repository setup`.
8. **Group names at laptop width** are cut in the middle (`style-fi...cx-specimens`), keeping both
   ends, never from the left. Two visible group headers never read the same (7.1 item 5's test
   stays).
9. Expected on the opened change at 1440 with Changes folded: about 55 controls, no menu taller
   than 460 px, at most two numbers per row (`#688` and `66 changed areas`), one bulk Accept on
   screen. Check by counting in a capture.

### 8.4 Rejected in this pass

- Dropping Up / Down from the find row: they are the only controls that print the Up and Down keys.
- Dropping `Always` from Zoom rows: removing a capability nobody asked to lose.
- Removing row checkboxes or group chevrons to hit 48: they are the pointer path to selection and
  collapse; the count target moves to about 55 instead.
- A two-column List menu: shorter but harder to walk with the keyboard; moving four items out does
  the same.
- Narrowing the Snapshots pane to give the viewer more room: line 3 is already tight at 420 px.
- Moving `Signs with` to the confirm button's label: too long for a button; it is a line above it.

## 9. Fourth pass (2026-11-01, after the third build review)

Where this section and sections 2-8 disagree, this section wins. Complaint 1 is still not met: on
a snapshot whose size changed, the row shows the whole tall page shrunk into the frame. Everything
below is checked against change #4455 on the studio server (run 41129746454).

### 9.1 Why the row shows the whole page (measured)

- The captures are 2,400 px wide (scale 2) and often tall: 2,400 x 3,804, 2,400 x 4,792, up to
  2,400 x 15,618. A small height change shifts everything under it, so the diff's largest region
  runs from the first shifted line to the bottom: `ddram` has 17 regions, the largest
  `[0, 1150, 2400, 2654]`.
- `rowCrop` frames all areas only when that zooms 2x of Fit, else the largest cluster, and
  `cropAround` clamps the crop to the image. A region that spans the page clamps to the whole page,
  so the crop is the whole page (`ddram`: crop `[0, 0, 2400, 3804]`, zoom 1.00). Of the 5,636 row
  facts the server holds, 2,118 have zoom 1.0 (the whole image) and 1,399 more are under 2x.
- Even a plain 2,400 x 1,800 page fits the 400 x 156 row at about half its width, so a whole-image
  row always has empty bands beside it.
- `Zoom rows to the change: When small` and `Spotlight rows` were both on, but these rows got
  neither: zoom under 2x means no crop, and areas covering a third or more mean no Spotlight.
- The 3 px crop bar (2.1 item 2, 8.2 item 3) was never drawn: `.pic.zoomed` has no style.

### 9.2 The row picture shows the change (complaint 1)

1. **A row picture of a changed pair is always a crop of the change, at a size where it can be
   read, filling the row's shape.** Its largest crop is `ROW_MAX`: 400 x 156 CSS pixels of the
   page (800 x 312 image pixels at scale 2; image pixels = CSS x the capture's `results.scale`, which
   the picture job is now given). At the row's 167 x 64 CSS px that keeps 14 px text at about 6 CSS
   px, readable as text on a 2x screen (checked by eye on 8 real pairs, see item 6).
2. **What the crop frames**, first that fits in `ROW_MAX`:
   1. every changed area (today's all-areas box);
   2. the largest cluster of nearby areas (today's `clusters`);
   3. otherwise a `ROW_MAX` crop placed on the **start of the largest region**: its first changed
      pixel (top-most changed row inside that region, leftmost changed pixel on it) sits a quarter
      of the crop in from the crop's top-left corner, the crop clamped inside the image. On a
      resized page this is where the shift begins, with unchanged lines above it for context.
      Without the mask (`factsOf`, before the job ran) the region's top-left corner stands in; the
      drawn picture always comes from the job.
   4. A change where the only region is the strip the size change adds or removes at the image's
      edge (nothing else changed, as on `camera-controls--fit-two-d`, 2 px shorter): a `ROW_MAX`
      crop centered on the image, so the row shows what the story is, and its words say the rest
      (item 4).
   Boxes are clipped to the new image first, as today. `ROW_MIN` stays the smallest crop, so a tiny
   change is never blown past one image pixel per screen pixel. An image smaller than `ROW_MAX`
   both ways is shown whole, centered, the band beside it the row's own background (8.2 item 2).
   `ROW_ZOOM_FROM` and the 2x-of-Fit rule leave the row code.
3. **The List menu says what rows do.** Its `Pictures` section is three choices and one toggle:
   `Crop to the change` (default), `Whole image`, `Text only, no pictures`, and `Spotlight small
   changes`, tooltip `Dims what did not change when the change covers less than a third of the
   picture`. `Zoom rows to the change: When small / Always / Never` is deleted: a stored `auto` or
   `always` reads as `Crop to the change`, `never` as `Whole image` (supersedes 8.4's "dropping
   Always": nothing is lost, both become the one crop). Spotlight keeps the `SPOT_UNDER` rule; on a
   start-of-region crop the unchanged quarter above the start is what it dims.
4. **Row words.** Line 3 stays `66 changed areas`. A size-only change (item 2.4) reads
   `Only the size changed: 2 px shorter` (`taller`, `narrower`, `wider`; both when both).
   The muted `resized` after the story name gains the numbers in its tooltip:
   `Resized: 2,400 x 3,770 to 2,400 x 3,804`.
5. **The crop marker is dropped from the spec.** With `Crop to the change` every changed row is a
   crop, so a bar on every row says nothing. The crop is said where it is chosen (the List menu)
   and on the picture's tooltip: `Cropped to the changed areas`, `Cropped to 3 of the 66 changed
   areas`, `Cropped to where the largest change starts`, `Centered: only the size changed`, or
   `Whole image`. Locked principle 9 (a crop is never silent) is kept by the menu and the tooltip.
   Delete the bar from 2.1 item 2, 6 (contrast test) and 8.2 item 3.
6. **Checked before kept.** A prototype of item 2 on 8 real pairs of #4455 (`ddram`,
   `palette-picker`, `compact-overview`, `workspace-start-screen--answered`, `gallery-formats`,
   `compact-buttons--all-buttons`, `ai-control--default`, `camera-controls--fit-two-d`), drawn at
   the row's real size on a 2x screen, showed readable content at the change on all but the
   size-only pair, which item 2.4 handles. The build repeats it on the page: capture the first 40
   rows of graph-io-fidelity (555 of 573 resized) and the first 40 of graphty (6 of 353 resized,
   so these are ordinary same-size rows) at 1440 and 1024, light and dark, judge each row with the
   Read tool, and record the counts in `docs/decisions.md`. No row may show empty bands beside a
   page wider than `ROW_MAX`.
7. The picture version moves (`?v=4`, serve.mjs `SPOTS_MADE_BY`), so cached row pictures and
   `areas.jsonl` facts made the old way are made again.
8. A spotlit row picture asked for before the server knows its areas (no compare areas, job not
   run) is made first and then chosen as the job decides, never sent spotlit by default: a
   resized page asked for cold was a grey slab until a reload. Its tooltip reads `Cropped to the
   change` until the row knows which rule cropped it. Pictures `run` makes in CI take the
   capture's scale too (`compareRun({ scale })`).

### 9.3 Views on a resized snapshot do something visible (item 4)

Measured: Highlight does draw (red on 2.9% of the 2,400 x 3,804 pixels of `images-charts-p-6`), but
the pair's diff takes long enough that the old Spotlight pictures stay on screen (7.1 item 1)
while the Highlight button is already filled, so H looks like it did nothing. The same holds for S
and L.

1. While a view's pictures are being made, both label strips say so after 300 ms: `New (drawing
   Highlight...)`, and the button of the view being drawn is filled at once. The old pictures stay,
   as 7.1 item 1 requires.
2. When the changed areas cover a third or more of the image, pressing H or S also says why it
   looks like a slab, once per snapshot, in the message line: `Resized: everything below the first
   change moved, so it all counts as changed. Flash (F) shows the move.` (not resized: `Most of
   this image changed. Flash (F) shows it.`).
3. Blink moves to the right of `Zoom: Fit  Z`, so its appearing in Highlight shifts nothing but
   Display, which is right-aligned and does not move.
4. `Zoom: Fit` draws the menu caret of 7.1 item 7, as every menu button does.

Built as: the drawing state goes on both strips of the held pictures (`Baseline (drawing
Highlight...)`, `New (drawing Highlight...)`; `Blink...` while L draws, `Spotlight...` for S), only
for the same snapshot (a move to another snapshot keeps 7.1 item 1's rule). The share is the boxes'
cover of the whole diff (`covered`, `SPOT_UNDER` in spot.js), and the word is said only after an H or
S press, never on opening a snapshot in Spotlight. Tests: H on a resized pair whose diff is held
shows both drawing labels over the old pictures, then the diffmark canvases; H then S says the
resized sentence once; H on a wholly red, same-size pair says the other; Blink sits right of Zoom
without moving it, and Zoom holds the caret.

### 9.4 The header and the item line read at a glance (items 2 and 3)

1. **The change title is never cut to a stub.** Snapshots line 1 holds only the title menu button
   and the fold button. The title wraps to at most two lines and is cut only after that. The
   `Behind master` / `Newer capture` chip moves to the right end of line 2 (the progress line); its
   drop order there is: `accepted earlier`, then `Behind master: 1,243` shortens to `Behind:
   1,243`; `N left` never goes.
2. **Group names are cut keeping their end** (`...cytoscape-js-specimens`), full name in the
   tooltip. Supersedes 8.3 item 8: at 1024 the middle cut left eight letters of each end, and in
   this repository sibling groups share their start (`style-fidelity-`), so the end is what tells
   them apart. The no-two-headers-alike test stays.
3. **The item line's `Open  Enter` becomes `Wider  Enter`**, tooltip `Fold the snapshot list to its
   rail; Esc brings it back`. It does what it did (level 2); the word now says it.
4. **The fold button has a word:** `Hide  Shift+2`, with the CSS caret pointing left.
5. **Rails** widen to 64 px so `8` / `left`, `Changes` and `Shift+1` each sit on their own line
   without touching.

Built as: line 1 is `chgmenu` and `pane2` only; the title is a two-line clamp, so the header grows
from 121 to about 137 px only while a title needs its second line. On line 2 the chips sit at the
right end; when tight, in order: `accepted earlier` goes, two chips fold into `2 notices`, the chip
shortens (`Behind: 1,243`), `decided` goes, and last the chip's words are cut; `N left` never
goes. A group name is cut from its start with 4 px to spare, so its end is never clipped. With a
64 px rail, Snapshots' narrowest becomes 316 px (was 320), so a 1,180 px window still leaves the
viewer 800 px. Tests: line 1 holds only the two controls; a long title draws on two lines at 1440
and 1024; line 2 keeps `N left` and drops in that order; group names keep their end and none is
clipped; `Wider  Enter` and its tooltip; `Hide  Shift+2` with the left caret; both rails 64 px
with badge, name and key on their own lines.

### 9.5 Image only, Show menu, small items (items 5 to 7)

1. **Image only hides the chrome, not the loop.** With Image only on, the top bar (tabs, Next
   change, Keys, Settings, Finish), the rails and the message line (unless it holds a message) are
   hidden. One strip stays above the picture: the view segment, Blink (in Highlight), `Zoom`,
   `Back  Esc` and `Image only  Shift+3` (filled check, the way out). The decision bar stays. About
   14 controls instead of about 25. A key whose control Image only hid (`Shift+N`, `?`, `Shift+1`,
   `Shift+2`) does nothing and says once `Hidden in Image only: Shift+3 brings it back.` This is the
   one exception to section 5's "Finish stays on screen": the reader chose it and leaves it with one
   printed key.
2. **Show menu headings.** Order: `Undecided`, `All`; heading `By kind`: `Changed`, `New`,
   `Removed`; heading `By decision`: `Accepted earlier`, `Accepted`, `Rejected`, `Excluded`;
   separator; `Accept all N shown...`. Headings are muted, not focusable, and the arrow keys skip
   them.
3. **Baselines draws no view buttons** it cannot use; only what acts there is drawn.
4. **Contrast:** the quiet key text measures 4.5:1 or more on white, on every tint and in dark mode;
   the row checkbox border measures 3:1 or more against the selected row's background in both
   themes. `test/page/contrast.test.mjs` checks both.

Built as: Image only is its own state, on from its press until the next press, a Back, or a pane
coming out of its rail; both panes folded by hand (or a viewing level's two rails) are not Image
only and keep the top bar. While on, `body.ionly` hides `#top`, both rails, the item line and an
empty message line; the strip is Back and the snapshot's name, the view segment, Zoom, Blink in
Highlight, and `Image only  Shift+3` in Display's place: 7 to 8 strip controls and the decision
bar's, 14 to 16 in all. A key with no visible control says `Hidden in Image only: Shift+3 brings it
back.` once per Image only (P, Y, B, O and X too, whose controls went with Display and the item
line); Zoom's digits still act. The Show menu's headings are the menu's existing `head` items
(`.mh`), outside the arrow keys' walk. Baselines draws the view segment only once two versions are
ticked (all four act then); a view key before that says `The views compare two versions: tick two
in the history below.` Contrast: the current row's checkbox border is `--ink-2` (4.9:1 light, 5.5:1
dark on `--sel`); a key on a filled button (a filled view, the primary button, Accept) is drawn at
full strength, and Accept's words take `--on-ink` (white on dark green was 2.3:1 in dark mode).
Tests: viewer (the strip, Finish gone, the message line only while it speaks, the way out), keys
(hidden keys do nothing and say once, digits still zoom), list (the menu's order and the skipped
headings), baselines (no view buttons until two are ticked), contrast (the checkbox, the keys on
filled buttons).

### 9.6 The Removed count (item 8: checked, not a page defect)

The Show menu's `Removed 3` is right for today's data: #4455 has 1,543 snapshots (1,167 changed,
73 new, 3 removed, 284 unchanged, 16 excluded). The third removed one,
`graph-io-fidelity/style-fidelity-vis-network-matched--vis-siblings.png`, has no baseline at the
change's head (`fe2cc79e01`); master added it on 2026-10-31 (`7fcfd61bbc`), after the capture,
and the scratch clone fetched it between the two reads. So "removed" here counts a baseline master
gained, which the change never removed. That is a wording question for changes behind master,
filed separately, not changed in this pass.

### 9.7 Rejected in this pass

- A bigger row (rejected again, 3.2): the crop rule fills the row instead.
- Drawing the crop bar on every row: every changed row is a crop now, so it would mark nothing.
- Anchoring a resized row on the first changed pixel of the whole image: on `ddram` that is one
  stray pixel in the title at y 21; the largest region's start is where the shift begins.
- Keeping `When small`: it is the rule that drew the whole page on 3,517 of the 5,636 rows.
- Hiding the decision bar in Image only: A, R and E act only through a visible control, so Image
  only would stop deciding.
- Deleting the item-line `Open`: it is the only control for level 2 at that place; renaming it
  is enough.

## 10. Fifth pass (2026-11-01, after the fourth build review)

Where this section and sections 2-9 disagree, this section wins. Complaint 1 is still not met. The
labels are gone and resized rows fill the frame, but on change #4455 only 2 of 20 resized rows
(#1022, #1024) show the change: the `start` crop (9.2 item 2.3) lands on where the largest region
begins, and on a resized page that region spans the page, so its start is an unchanged-looking
table header or icon grid (#689 `images-charts-p-7`: the row shows the `passed / recorded` header
while Highlight puts the red in the overlay panel and lower table rows). Those rows are also shown
plain, because the change covers a third or more of the crop, so nothing in the picture marks what
differs while the List menu says the rows are spotlit.

### 10.1 The row crop goes where the most pixels changed

1. **`start` is replaced by `dense`.** When neither every area nor the largest cluster fits
   `ROW_MAX` (9.2 item 2, rules 1 and 2), the crop is the `ROW_MAX` window, at the row's shape and
   inside the new image, holding the most changed pixels of the raw pixelmatch mask (not the grown
   one, so a few stray pixels grown to blobs never win). Search it with a summed-area table of the
   mask counted per cell of a sixteenth of the window each way, trying every cell position (built:
   that is exhaustive at the sixteenth and costs about 45 ms on a 2,400 x 15,618 page, so the
   quarter-grid pass and its refinement were not needed); ties go to the top-most, then left-most. Changed pixels inside the
   strip a size change adds or removes at the edge do not count (the `kept` rect), so a resized row
   never frames the new blank band.
2. **Without the mask** (`factsOf`, before the job ran) the largest area's center stands in, and
   the tooltip reads `Cropped to the change` until the job says `dense`. The drawn picture always
   comes from the job. (Built: pictures `run` makes in CI keep only their files in results.json, so
   for those the server never learns `dense` and keeps the center's tooltip and cover; carrying the
   job's crop in results.json would close that, a new optional field.)
3. `firstChanged` and the `start` rule leave the code. Supersedes 9.2 item 2.3 and the 9.7 line
   about anchoring on the first changed pixel.
4. Tooltip for `dense`: `Cropped to where the most pixels changed`.

### 10.2 The row picture marks the change itself

1. **Every changed row marks its changed pixels, by one of two means, chosen per row:**
   - the changed areas cover less than a third of the crop (`SPOT_UNDER`): Spotlight, as today
     (`row-spot`);
   - a third or more: **Tint** (`row-tint`), a new kind: the new image's crop with each raw changed
     pixel, dilated by 2 image pixels so it survives the shrink to the row, blended 55% toward the
     Highlight view's red. Nothing else is dimmed or drawn, so it stays a picture of the page.
   Tint is the change, not a label over it: it is what Highlight shows, at row size.
2. **The List menu's toggle says it.** `Spotlight small changes` becomes `Mark the change`
   (default on), tooltip `Spotlights a small change; tints the changed pixels red when most of the
   picture changed`. Off shows the plain crop (`row-plain`). A stored `spot` setting reads as this
   toggle. The other Pictures choices stay (`Crop to the change`, `Whole image`, `Text only, no
   pictures`). With `Whole image` the same mark rule applies to the whole image (`tint`, by
   `coverAll`; built by tinting each pixel of the shrunk picture that shows a changed pixel or one
   within 2 of it, so a tall page is never copied whole).
3. `shownKind("auto")`: `row-spot` under `SPOT_UNDER`, else `row-tint`; with the toggle off,
   `row-plain`. `PAIR_KINDS` gains `row-tint` (and `tint`, item 2). The picture version moves to
   `5` (serve.mjs `SPOTS_MADE_BY`, `?v=5`), so every cached row picture and `areas.jsonl` fact is
   made again.
4. **The crop wording reaches every reader.** The row `img` takes the tooltip sentence as its
   `alt` (`Cropped to where the most pixels changed, changed pixels tinted`), not `alt=""`; the
   tooltip stays on the `.pic` box. Locked principle 9 then holds for keyboard and screen-reader
   readers too.
5. Tests: `rowCrop` on a synthetic resized pair whose largest region spans the page but whose
   dense change sits low picks the dense window (not the region's top); the edge strip never wins;
   `shownKind` picks `row-tint` at a third or more and `row-spot` under it; a `row-tint` picture
   has red pixels exactly where the mask is and the new image's pixels elsewhere; the toggle off
   gives `row-plain`; the img `alt` matches the tooltip.

### 10.3 Proof (the branch is not done without it)

1. Everything on the branch is committed before any capture, and the captures name the commit.
2. One capture set, `tmp/proofroom-studio/after-5/`, with every shot 01-33 of the earlier sets
   (same names) plus an `inventory.md` listing each file, the commit, the server version, and what
   each row close-up shows.
3. **Row judgment, both kinds of snapshot.** The first 20 rows of graph-io-fidelity (resized) and
   the first 20 of graphty (ordinary, same-size; take them from a change whose graphty rows are
   not resized, and list which) at 1440, light and dark, each row close-up at 2x next to the same
   snapshot's Highlight at Fit (`NN` and `NN-highlight`). Each row is judged with Read: does the
   row show, at a glance, the place Highlight marks? Wait for the row picture to be the job's
   (its `how` known, not `Making picture...`) before shooting: never capture the transient list
   after a restart. Record per-row yes/no and the totals in `docs/decisions.md`. The bar: at least
   18 of 20 yes on each kind, and every no explained.
4. The acceptance test runs on that same commit against the preview server, its log kept as
   `uat-after-5.log`, and the result is the run's own pass/fail/skip counts.

### 10.4 Rejected in this pass

- Drawing the crop bar (the "thin grey bar") again: dropped in 9.2 item 5; every changed row is a
  crop.
- Spotlight that ignores the one-third rule on rows: on a mostly-changed crop it is the dark slab
  8.2 removed. Tint marks the change without darkening the page.
- A bigger row: rejected in 3.2 and 9.7.
