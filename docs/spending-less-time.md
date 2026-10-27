# Spending less time on pixel changes

A large change can hold hundreds of changed snapshots. The review page saves time on them without
hiding one.

## Approved before

A capture that is byte for byte an image you already accepted for the same story and mode arrives
already accepted, marked "Accepted (approved before #1356)". It counts as decided and sits in a
folded group **Approved before** at the top of the list, under every grouping. Its rows show under
Show: All or Accepted, or when you open the group. Its header offers **Reject 12...** and **Exclude
12...**; Reject or Exclude on one row replaces it. It has no Undo: nothing was stored for it.

The earlier approval must still be the newest decision on that file where it lives: a later accept
of another image, an exclusion or a reject replaces it. Before a passkey is registered, only review
records on the default branch count. Once one is, a signed record or change statement at the
default branch's tip or an open pull request's head counts too, when its signature verifies against
the default branch's passkeys and it names this repository (see [The approval
format](approval-format.md)). Finish's sheet counts these and the new statement names the approval
each came from, and the gate accepts the snapshot only when that approval holds for exactly this
image of this story. Nothing is taken on the page's word.

## Groups

The list is grouped by component by default above 10 snapshots, and each group header has
**Accept N**, with **[Shift+A]** on the group of the current snapshot. After a group accept the
next group's first undecided snapshot becomes current, so Shift+A, look, Shift+A walks the change
group by group. The header shows the group's split by status in marks and words ("19: 12 changed,
7 new") before you accept it. More than 20 at once asks first.

**Group: Same change** puts first the snapshots whose change is exactly the same (the same baseline
and the same new image, so one look decides them all: "Identical change 128"), then look-alike
changes ("Look alike: ..."): changes of the same kind, in the same place, of a similar size, which
the server guesses from where and how much each image changed. Its first row is the one that
changed most. The rest are listed last, "Different from the rest". A component's rows also carry a
badge "same as 11 others" when their change is identical to others'.

## Row pictures

**Pictures** in the list header chooses what each row's picture shows:

- **Spotlight rows** (on by default): everything outside the changed pixels is dimmed, so a small
  change stands out.
- **Zoom rows to the change**: **Auto** (the default) zooms a row when its crop around the largest
  changed area shows the change at least twice as large as the whole image would; **Always** and
  **Never** override it. A zoomed row's corner says how much ("zoomed 7x", "+2 areas").
- **No pictures**: text rows, the densest list.

## Selecting

Select rows with **Select [X]**, a checkbox, a shift-click or **Shift+Up / Shift+Down**, and decide
them together from the selection bar, or with A, R or E while the current row is in the selection.
**Accept all shown...** in the list's menu accepts every undecided row the filter and Find show,
after asking. Every bulk decision is one step for **Undo [U]**.
