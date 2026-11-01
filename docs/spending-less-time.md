# Spending less time on pixel changes

A large change can hold hundreds of changed snapshots. The review page saves time on them without
hiding one.

## Accepted earlier

A capture that is byte for byte an image you already accepted for the same story and mode arrives
already accepted, marked "Accepted earlier (#1356)". It counts as decided and sits in a folded
group **Accepted earlier (12)** at the bottom of the list, under every grouping. Its rows show
under Show: All or Accepted earlier, or when you open the group by its chevron. The menu under its
name offers **Reject 12...** and **Exclude 12...**; Reject or Exclude on one row replaces it. It has
no Undo: nothing was stored for it.

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
**Accept N**, green and printing **Shift+A** on the group of the current snapshot. After a group
accept the next group's first undecided snapshot becomes current, so Shift+A, look, Shift+A walks
the change group by group. The group's name button shows its count, "legend (19)", its tooltip the
split by status ("19: 12 changed, 7 new"), and opens the group's menu (Collapse, Reject N...,
Exclude N..., Select all N). More than 20 at once asks first.

**Group: Same change** puts first the snapshots whose change is exactly the same (the same baseline
and the same new image, so one look decides them all: "Identical change 128"), then look-alike
changes ("Look alike: ..."): changes of the same kind, in the same place, of a similar size, which
the server guesses from where and how much each image changed. Its first row is the one that
changed most. The rest are listed last, "Different from the rest". A component's rows also carry a
badge "+11 identical" when their change is identical to others'.

## Row pictures

**Pictures** in the list header's **List** menu chooses what each row's picture shows:

- **Crop to the change** (the default): a changed row's picture is a crop of the change, at most
  400 x 156 CSS pixels of the page, so it can be read at the row's size. It frames every changed
  area when they fit, else the largest group of areas close together ("Cropped to 1 of the 3
  changed areas"), else where the largest change starts ("Cropped to where the largest change
  starts"): on a resized page, everything under the first change moved, and the crop shows where
  that begins. When only the size changed, the crop is centered and the row reads "Only the size
  changed: 2 px shorter". The row itself says how many areas changed, "3 changed areas".
- **Whole image**: the whole new image, shrunk to the row.
- **Text only, no pictures**: text rows, the densest list.
- **Spotlight small changes** (on by default): dims what did not change, so a small change stands
  out. A picture is spotlit only when its changed areas cover less than a third of it; when most
  of it changed it is shown plain, because dimming would hide the change.

## Selecting

Select rows with **Select [X]**, a checkbox, a shift-click or **Shift+Up / Shift+Down**, and decide
them together from the selection bar, or with A, R or E while the current row is in the selection.
**Accept all 34 shown...**, the last item of the **Show** menu, accepts every undecided row the
filter and Find show, after asking. Every bulk decision is one step for **Undo [U]**.
