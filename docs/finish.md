# Finish

Finish publishes your decisions on a change: it commits the accepted and excluded images to the
change's branch, posts the rejects, and sets the commit status.

## Finish one change

With a change open, **Finish #3486...** is at the right of the top bar: outlined in the primary
color while snapshots are left, filled once none is. With no new decision to publish, pressing it
says "Nothing new to finish". You can also press **Finish #3486 (12) [Enter]** on the card that
shows once every snapshot is decided (its number counts the decisions it will publish), or **Finish...** on a row of **Decided, not finished** in the changes pane, which
finishes that change without opening it.

Each opens the summary sheet, which says what will happen before anything does. It is titled
"Finish #3486", with the change's title muted below, and says three things:

- **Saves**: what it commits, your own work apart from what was accepted before this capture,
  each part only when it is not 0, then the branch and the git identity that commits: "Saves 12
  you accepted (2 not opened), 3 excluded and 1,208 accepted earlier to branch feat/x, as Ada
  Owner."
- **Left**, when snapshots are left: "17 left: they will block the merge", with **Go to the
  first**, which closes the sheet on the first of them. Finishing with snapshots left is allowed.
- **The check** it sets, by its short name: "GitHub check: Reviewed".

The rest is under **Details**, closed until you open it:

- **Will post**: the rejects, as one comment on the pull request, with their reasons under **The
  reasons**.
- **Will set**: the commit status, in the server's own words, for example
  `"Reviewed: 190 accepted, 12 rejected, 2 excluded, 17 left undecided" (failure)`.
- **Signs with**: the passkey that signs it. When nothing can sign ("Not yet protected: no passkey
  registered.", or why Finish cannot be approved now) this line is outside Details.
  **Register passkey...** opens Settings; closing Settings brings the sheet back.
- **Start this server from your own shell**: the command, when someone else started the server.

**Sign and finish #3486 [Enter]** (or **Finish #3486 [Enter]** with no passkey) starts it; **Cancel
[Esc]** closes the sheet and changes nothing. If your decisions changed in another tab meanwhile,
the sheet refuses, opens again with the new counts, and says why.

## While it runs

Finish runs on the server. The change's row shows where it is, "Step 3 of 6: commit", and you can
keep reviewing other changes. Reloading the page shows the running Finish again.

- **Finished**: the row moves to Nothing to decide and reads "Finished 14:02, signed", with links
  to the commit (and to the pull request the comment is on, when rejects or accept notes were
  posted) and **Dismiss**. When the comment or the commit status could not be posted, the row adds
  "comment not posted" or "status not set", and the message line says why. The message line
  offers **Next change**, as does the changes pane's header [Shift+N].
- **Failed**: every decision is kept. The row reads which step failed, as in "Finish failed: push
  rejected" (its tooltip has the whole reason, and so does the message line), and offers
  **Retry**, which opens the sheet again. A
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

Each signed Finish needs its own passkey touch, so a run needs you at the page until it ends. The
first change's prompt starts with **Finish all**; for each later one the message line asks you to
touch your passkey and shows **Sign #3487**, which starts its prompt (browsers start a passkey
prompt only from a press). Stop while it waits ends the run there.

## Seeding

A run of the default branch, opened with `proofroom serve --master-run <run id>`, shows as a
**seed** row, "Seed from master". Finish on it works the same way, except that it pushes a branch
`visual/seed-<date>` with the accepted baselines and opens its pull request, and rejects open one
issue instead of a comment.
