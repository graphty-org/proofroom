# Using it without GitHub

proofroom works in a git repository with no GitHub at all. Your branches are the changes you
review, every capture is made on your machine, and what GitHub would hold (comments, commit
statuses, issues) goes into files on the branch instead.

## Set it up

```sh
npx proofroom init --code-host plain-git
```

This writes `visual-review.config.json` with two settings of its own, and no GitHub Actions
workflows:

```json
{
    "codeHost": "plain-git",
    "repositoryId": "6f1c2b0e-3a4d-4c5e-9f8a-7b6c5d4e3f21",
    "projects": { "storybook": { "storybook": "storybook-static", "build": "npm run build-storybook" } }
}
```

- `codeHost: "plain-git"` makes the branches the changes.
- `repositoryId` is a random UUID that names this repository in every approval, so an approval
  made here never counts in another repository. Keep it as it is: a branch that changes it fails
  the gate. To set up a repository by hand, put any random UUID there (`uuidgen`).

Without GitHub there is no CI to capture for you, so `captureStore` is `"local-folder"` and needs no
setting.

## Review a branch

1. Start the review page: `npx proofroom serve`, and open the address it prints.
2. Press **New capture...**. Choose **A local branch** (or the working tree, which is its branch
   when nothing is uncommitted) and press **Start capture [Enter]**.
3. When the capture is done, its row is in the changes pane, named after the branch, with its last
   commit's subject as the title and its last committer as the author. Open it and decide each
   snapshot as usual.
4. Press **Finish**. The summary says what it will do, for example:

    > **Will commit:** 1 accepted (0 not opened), 0 excluded, to branch feat/x as Ada Owner.
    >
    > **Will write** 1 reject to visual-review-rejects/feat-x.md on the branch.

Finish commits onto the branch, in this order:

- the accepted baselines and one approval (`visual-review-approvals/branch-<name>/...`), as on any
  code host;
- then, when you rejected anything or accepted with a note,
  `visual-review-rejects/<branch>.md`: each rejected snapshot with your reason, the text a pull
  request comment would hold. The branch name's slashes and other characters become dashes
  (`feat/x` writes `visual-review-rejects/feat-x.md`). A later Finish replaces the file.

Finish sets no commit status. Where the branch is checked out, its files follow the new commits. A
branch with an upstream is pushed there; one without stays on your machine and its row says
"pending push".

## Branches on a remote

**A branch from the remote** in New capture lists the branches that are on a remote but not yet a
local branch here. Their code is someone else's, so capturing one works like capturing another
person's pull request: the server refuses it unless `visual-review.config.json` names a
`captureCommand` (see [Starting a capture from the page](capturing-from-the-page.md)), and the
page asks once more, naming the branch's last committer. The capture makes a local branch that
tracks the remote one, so Finish pushes its commits back to it.

## What the page leaves out

Settings > Adapters lists what plain git cannot do and which buttons it hides because of that:

| Missing         | What you see                                                                   |
| --------------- | ------------------------------------------------------------------------------ |
| Comments        | Rejects are written to `visual-review-rejects/<branch>.md` on the branch       |
| Commit statuses | Finish sets none, and its summary has no "Will set" line                       |
| Issues          | Rejects on the default branch would go to the same file                        |
| Opening changes | No "Open on" button; a passkey registration pushes its branch for you to merge |
| CI              | Every capture runs on this machine; "CI" in New capture is unavailable         |

Branches have no numbers: the page names each change by its branch, and its tag says "branch".
`proofroom update` (Update from the default branch) needs numbered changes: merge the default
branch into your branch yourself.

## The gate

Run the gate wherever you merge, naming the change by its branch:

```sh
npx proofroom gate --captures <capture dir> --base main --head feat/x --change branch:feat/x
```

It reads `repositoryId` from the base branch's config, and passes the baselines the branch changes
only when an approval Finish committed covers them. See [the approval format](approval-format.md).
