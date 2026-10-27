# Trying the new page

The review server serves a new review page beside today's at `/next/`. Both pages read and write
the same decisions, so you can switch between them in the middle of a review. Today's page stays
the page at `/` until the new one does everything it does.

## Open it

Take the address `proofroom serve` printed and put `next/` after the host and port:

```text
proofroom: open https://review.example:4800/#token=<token>
               https://review.example:4800/next/#token=<token>
```

The token works on both pages, and a browser that already opened one page with it opens the other
without asking. To make the new page the page at `/`, start the server with `--ui next`:

```sh
PORT=4800 proofroom serve --ui next
```

## What it has so far

- **The changes pane.** Every change with captures, in sections: Needs you, Decided, not finished,
  Capturing or downloading, Not ready, Look only, Nothing to decide and Drafts. Each row says what
  state the change is in and what it waits for. **Find [/]** finds a change by number, title,
  branch or author; **Sort** orders them; **Next change [Shift+N]** opens the next change that
  needs you. A row's **...** menu has About this change, Open on GitHub and Copy link.
- **Panes and levels.** **Hide [Shift+1]** and **Hide [Shift+2]** turn the Changes and Snapshots
  panes into narrow rails; the rail, or the same key, brings the pane back. Opening a change folds
  the panes the review does not need, and the viewer is never narrower than 800 px. **Back [Esc]**
  says where it goes: back to the list, or back to the changes. The page remembers your pane
  choices in this browser, separately for small changes (10 snapshots or fewer) and large ones.
- **The snapshots of a change**, as a plain list for now.
- **The viewer.** The current snapshot in four views: **Side by side [V]**, **Flash [F]** (or hold
  Space), **Highlight [H]** (with **Blink [L]**) and **Spotlight [S]**; pressing a view's key again
  goes back to Side by side. **Zoom [Z]** and Fit [0], 1x [1], 2x [2], 4x [4] and 8x [8] zoom both
  images together, and from 2x a small map of the whole image at the lower right moves the view
  where you click it. **Baseline [P]** hides the baseline to see the new image alone; **Image only
  [Shift+3]** folds both side panes; **Layout [Y]** puts the two images side by side or over and
  under (Auto picks whichever draws them larger); **Options** has Outline [B], Open centered on the
  area [O], Details and Copy link. **Next area [N]** steps through the changed areas, and
  **Previous [Left / J]** and **Next [Right / K]** move between snapshots. Decisions come next;
  until then, decide on today's page.
- **The Baselines tab.** Every approved baseline, at the default branch or at any change's head:
  see [Browsing baselines](../README.md#browsing-baselines).
- **Addresses.** Every change and snapshot you open is in the address, so a copied link opens it
  again and the browser's Back and Forward move between them. Links today's page wrote, such as
  those in pull request comments, open the same change and snapshot here.

Every key is printed on the control it presses, and a key does only what a visible key box says.
