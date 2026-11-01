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
2. A zoomed thumbnail is marked outside its pixels by a 3 px bar in `--muted` on the picture's left
   edge (`.pic.zoomed`, a `box-shadow: -3px 0 0 var(--muted)` or border-left; never an outline,
   never the focus color, so focus stays the only outline on the page). A whole-image thumbnail
   keeps its plain 1 px border. (Keeps locked principle 9: a crop is never silent.)
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
- `test/page/contrast.test.mjs`: text on every tint, quiet keys, zoomed bar.
- New 1024 x 768 tests: every keyed control wholly in the viewport (a) with a change open, (b) with
  3 rows selected, (c) with stale data and both chips; the decision bar on one line in each.
- Docs: `docs/the-screens.md`, `docs/keys.md` (Esc guard, Y cycle, Display menu, Shift+Down on
  Select), `docs/decisions.md` (records: nothing drawn on pictures, two key tiers, the thumbnail
  choice from 2.1 item 7, `accepted earlier` split, Y cycles).
