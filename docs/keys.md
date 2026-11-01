# Keys

Every key the review page answers is printed on the control it presses, and a key does only what
a visible printed key says. Keys on the look-decide-next loop (the view switch, the decision bar,
boxes) are printed in a key box such as **Accept [A]**; every other control prints its key as
quiet muted text after its label, such as **Next change Shift+N** or the Find box's "Find /". Each control also names its key to a screen reader (`aria-keyshortcuts`). **Keys ?** in the top bar opens
the Keys sheet: this whole map, grouped by task (Decide, Move, Look, Panes, Select), one short line
a key, and the switch for single-letter keys. Earlier messages are behind **Messages** on the
message line.

Where each key is printed:

- **A, R, E, U**: the decision bar, boxed. **J, K**: Previous and Next on the decision bar, boxed,
  with **Left** and **Right** quiet after them (Up and Down belong to the list that owns them and
  are printed on its header).
- **V, F (hold Space), H, S**: the view switch at the left of the viewer's toolbar, boxed. **Z**: the
  **Zoom: Fit** button after them, which also opens the zoom menu when clicked; its items print
  **0, 1, 2, 4, 8**. **L**: **Blink**, after Zoom, shown in Highlight, the one view it works in.
- **P, Shift+3, Y, B, O**: the **Display** menu at the right end of the toolbar (Show baseline,
  Image only, Layout, Outline changed areas, Start zoomed on the change).
- **Shift+N**: **Next change** in the top bar (and on the end card). **Shift+1**, **Shift+2**:
  the Changes pane's **Hide** and the Snapshots pane's fold button, and each pane's rail, where the
  key is printed quietly on one line under the pane's name. **?**: **Keys** in the top bar. **/**: the Find box's
  placeholder.
- **Shift+A**: **Accept 14** on the current snapshot's group header, and the first item of that
  group's name menu. While rows are selected the header draws no Accept (the decision bar's
  **Accept 12** is the bulk action); the name menu still lists **Accept 14 Shift+A** and the key
  still accepts the group.
- No key: the change's own menu (its number and title in the Snapshots header) holds **Open on
  GitHub**, **Copy link to this list**, **Download the comparison report (JUnit)** and, apart,
  **Undo all decisions...**; **Accept all 34 shown...** is the last item of the **Show** menu.
- **N**: **Next area** on the item line, when the snapshot has more than one changed area. **X**:
  **Select X** on the item line. **Esc**: **Back** on the item line, and Clear,
  Close and Cancel wherever something can be cleared or closed.

| Key                   | Action                                          |
| --------------------- | ----------------------------------------------- |
| Left / J              | Previous snapshot                               |
| Right / K             | Next snapshot                                   |
| Up / Down             | Previous / next row of the list you are in      |
| Shift+Up / Shift+Down | Extend the selection                            |
| Enter                 | Open, or press the button that shows Enter      |
| Esc                   | Close or clear; again to go back                |
| A                     | Accept (or the selection)                       |
| Shift+A               | Accept the current group                        |
| R                     | Reject...                                       |
| E                     | Exclude...                                      |
| U                     | Undo the last decision                          |
| X                     | Select or unselect the row                      |
| V                     | Side by side                                    |
| F                     | Flash; from Spotlight, the spotlit pair flashes |
| hold Space            | Flash the current view while held               |
| H                     | Highlight; again: Side by side                  |
| L                     | Blink (in Highlight)                            |
| S                     | Spotlight; again: Side by side                  |
| P                     | Show or hide the baseline                       |
| Y                     | Next layout: Auto, side by side, over and under |
| B                     | Outline changed areas                           |
| O                     | Start zoomed on the change                      |
| N                     | Next area                                       |
| 0                     | Fit                                             |
| 1 / 2 / 4 / 8         | Zoom 1x (actual size), 2x, 4x, 8x               |
| Z                     | Next zoom step: Fit, 1x, 2x, 4x, 8x             |
| Shift+1               | Show / hide Changes                             |
| Shift+2               | Show / hide Snapshots                           |
| Shift+3               | Image only; again: the panes back as they were  |
| Shift+N               | Next change that needs you                      |
| /                     | Find in the focused pane                        |
| ?                     | This sheet                                      |

Rules:

- **No key acts while a text field, a box or a menu has focus**, except the keys those print
  (Enter, Esc, the arrows in a menu or the reason box's recent reasons).
- **Digits are read by their place on the keyboard**, so Shift+1, Shift+2 and Shift+3 work on AZERTY
  and other layouts; letters are read by their character.
- **Letter keys can be switched off** in the Keys sheet or in Settings: every key made of a letter,
  digit or symbol then does nothing and its key boxes are hidden, so speech input or a stray key
  cannot decide anything. The arrows, Enter, Esc, Tab and Space keep working. The choice is kept in
  this browser.
- **No key reverses a decision.** A, R and E on a snapshot already decided say "Already accepted.
  Undo it to change it."; press U (or Undo) first.
- **A decision key waits for the image.** A held A, R, E or U decides once, and A, R or E pressed
  within a quarter second of a snapshot's images being drawn is ignored, and the message line says
  why. While a decision is being saved the page says "Saving the last decision..." and waits for
  it before moving on; a save that fails leaves the snapshot undecided, with why.
- **Keys printed in a closed menu act with it closed.** The Zoom menu's digits and the Display
  menu's P, Shift+3, Y, B and O each act in one press without opening their menu. Y steps the
  layout (Auto, Side by side, Over and under); the Display menu's Layout item, clicked or given
  Enter, lists the three. Z steps the zoom; a click on Zoom (or Enter on it) opens its menu. Every
  zoom step centers the view on the current changed area; Start zoomed on the change decides only
  how a snapshot first opens.
- **Esc goes back only on purpose.** Esc first closes a menu or box, clears a field or the
  selection. It goes back one level (to the list, or to the changes) only when nothing is on top
  and the key pressed just before was not an Esc that closed or cleared something. That second Esc
  says "Press Esc again to go back to the changes." instead; the next one goes back, and the message
  line says "Back to the changes. Enter opens #4455 again."
- **Shift+Down starts a selection** from the current row (Shift+Up the other way); both are
  printed in the **Select** section of the Snapshots header's **List** menu (**Extend selection up
  Shift+Up**, **Extend selection down Shift+Down**) and in the selection bar's **More** menu, and
  act with either menu closed.
- **One view at a time.** V, F, H and S each choose a view, and pressing the key of the view
  already shown goes back to Side by side. F is never a toggle on another view: from Spotlight it
  switches to Flash and flashes the spotlit pair; V, H or S leaves Flash. Holding Space flashes only
  while held, then returns to the view it left.
- **Shift+3 gives back what it took.** Image only folds both side panes; pressed again it restores
  exactly the panes it folded, so a pane you had folded yourself stays folded.
- **Enter does what the visible [Enter] says**: open the current change (its summary's **Open
  [Enter]** while no change is open) or snapshot, the default button of a box or the end card, or
  a button you focused with Tab. A focused button shows its Enter just under itself, so focusing it
  never moves the controls beside it.
