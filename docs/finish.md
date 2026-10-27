# Finish on the new page

Finish publishes your decisions on a change: it commits the accepted and excluded images to the
change's branch, posts the rejects, and sets the commit status. On the new page (`/next/`) it
works over the same server as today's page, with the same decisions and the same approvals.

## Finish one change

With a change open, **Finish #3486 (12)** is the primary button at the right of the top bar. The
number counts the decisions it will publish. At 0 it is unavailable and says "Nothing new to
finish". You can also press **Finish [Enter]** on the card that shows once every snapshot is
decided, or **Finish...** on a row of **Decided, not finished** in the changes pane, which
finishes that change without opening it.

Each opens the summary sheet, which says what will happen before anything does:

- **Still undecided**, first, when snapshots are left: "17 snapshots are still undecided; they
  will block the merge." **Go to the first undecided** closes the sheet on the first of them.
  Finishing with undecided snapshots is allowed.
- **Will commit**: how many accepted (and how many of those you never opened) and excluded, the
  branch, and the git identity that commits.
- **Will post**: the rejects, as one comment on the pull request, with their reasons under **The
  reasons**.
- **Will set**: the commit status, in the server's own words, for example
  `"Reviewed: 190 accepted, 12 rejected, 2 excluded, 17 left undecided" (failure)`.
- **Signs with**: the passkey that signs it, or "Not yet protected: no passkey registered."
  **Register passkey...** opens Settings; closing Settings brings the sheet back.
- **Start this server from your own shell**: the command, when someone else started the server.

**Sign and finish #3486 [Enter]** (or **Finish #3486 [Enter]** with no passkey) starts it; **Cancel
[Esc]** closes the sheet and changes nothing. If your decisions changed in another tab meanwhile,
the sheet refuses, opens again with the new counts, and says why.

## While it runs

Finish runs on the server. The change's row shows where it is, "Step 3 of 6: commit", and you can
keep reviewing other changes. Reloading the page shows the running Finish again.

- **Finished**: the row moves to Nothing to decide and reads "Finished 14:02, signed", with links
  to the commit (and to the comment when rejects were posted) and **Dismiss**. The message line
  offers **Next change**, as does the changes pane's header [Shift+N].
- **Failed**: every decision is kept. The row reads "Finish failed" (its tooltip and the message
  line say which step failed and why) and offers **Retry**, which opens the sheet again. A
  cancelled passkey says "Passkey cancelled: nothing was changed."

## Finish all

When more than one change is in **Decided, not finished**, its header has **Finish all 29...**. It
opens one sheet with a line per change (what it will commit, post and set, and any undecided
left) and says what the run costs: "Stay on this page: about 6 minutes, 29 passkey confirmations,
one as each change's turn comes." Changes that need no passkey run back to back and are counted
separately.

**Finish all 29 [Enter]** starts the run. The page finishes one change at a time: it prepares the
change, asks for your passkey when its turn comes, starts its Finish and waits for it to end, then
moves on. Waiting rows read "Queued: Finish all, 4th" and have **Remove from the run**. A failure
stops only that change; the run goes on with the next.

**Stop**, on the section header while the run goes, ends the run after the change finishing now.
Leaving or reloading the page does the same. Changes not yet run return to Decided, not finished.

Each signed Finish needs its own passkey touch, so a run needs you at the page until it ends.

## Seeding

A run of the default branch, opened with `proofroom serve --master-run <run id>`, shows as a
**seed** row, "Seed from master". Finish on it works the same way, except that it pushes a branch
`visual/seed-<date>` with the accepted baselines and opens its pull request, and rejects open one
issue instead of a comment.
