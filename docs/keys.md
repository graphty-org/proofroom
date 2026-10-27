# Keys

Every key the review page answers is printed on the control it presses, in a key box such as
**Accept [A]**, and a key does only what a visible key box says. **Keys [?]** in the top bar opens
the Keys sheet: this whole map, the switch for letter keys and the last 20 messages.

| Key                   | Action                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| Left / J              | Previous snapshot                                                                                               |
| Right / K             | Next snapshot                                                                                                   |
| Up / Down             | Move the current row (in the list: Previous / Next)                                                             |
| Shift+Up / Shift+Down | Extend the selection                                                                                            |
| Enter                 | Open the current change or snapshot; the default button of a box or the end card; a button you focused with Tab |
| Esc                   | Close a menu, box or selection; else what the Back button says                                                  |
| A                     | Accept (or the selection)                                                                                       |
| Shift+A               | Accept the current group                                                                                        |
| R                     | Reject...                                                                                                       |
| E                     | Exclude...                                                                                                      |
| U                     | Undo the last decision                                                                                          |
| X                     | Select or unselect the row                                                                                      |
| V                     | Side by side                                                                                                    |
| F                     | Flash; again: Side by side (in Spotlight: Spotlight flash)                                                      |
| hold Space            | Flash the current view while held                                                                               |
| H                     | Highlight; again: Side by side                                                                                  |
| L                     | Blink (in Highlight)                                                                                            |
| S                     | Spotlight; again: Side by side                                                                                  |
| P                     | Baseline shown / hidden                                                                                         |
| Y                     | Layout menu                                                                                                     |
| B                     | Outline                                                                                                         |
| O                     | Open centered on the area                                                                                       |
| N                     | Next area                                                                                                       |
| 0                     | Fit                                                                                                             |
| 1 / 2 / 4 / 8         | Zoom 1x, 2x, 4x, 8x                                                                                             |
| Z                     | Cycle zoom                                                                                                      |
| Shift+1               | Show / hide Changes                                                                                             |
| Shift+2               | Show / hide Snapshots                                                                                           |
| Shift+3               | Image only                                                                                                      |
| Shift+N               | Next change that needs you                                                                                      |
| /                     | Find in the focused pane                                                                                        |
| ?                     | This sheet                                                                                                      |

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
- **Enter does what the visible [Enter] says**: open the current change or snapshot, the default
  button of a box or the end card, or a button you focused with Tab.
