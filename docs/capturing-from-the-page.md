# Starting a capture from the page

The review page at `/next/` can capture on the machine the review server runs on, so you can look
at your own work before CI does, or review and finish a branch that never goes through CI.

## New capture

Press **New capture...** in the top bar (or on the empty Review screen, or **Capture again...** in a
change's **...** menu). The sheet asks four things, and its defaults are filled in, so **Start
capture [Enter]** is one key:

1. **What**: the working tree of the checkout the server runs in, a local branch, or a pull request
   from the code host.
2. **Against which baselines**: the change's target branch (the default), the default branch, or a
   commit you name.
3. **Which projects and stories**: every project by default; untick the ones you do not need. A
   story id prefix (`button--, badge--`) captures only the stories whose id starts with one.
4. **Where**: this machine. CI is shown unavailable, with the reason, when your capture store
   cannot start a CI job.

The capture's row is in the changes pane at once, under **Capturing or downloading**, and says how
many stories are done. Captures on this machine run one at a time; the others wait in order.

## The Captures screen

**Captures** in the top bar lists every capture in four sections: Running, Queued, Finished today
and Earlier. Pick one to see, for each project, how many stories are done of how many, the story
being captured, the stories that failed so far with their reason, and the log. **Cancel** stops a
capture and every browser it started. Once it has finished, **Review results [Enter]** opens what it
made on the Review screen.

## What can be reviewed and finished

| You captured                               | What you get                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| A pull request, every project and story    | That pull request's local preview: decided and finished like CI's capture of it, onto its branch |
| A local branch, every project and story    | A change of its own, named after the branch: decided, and finished onto the branch               |
| The working tree, with nothing uncommitted | The same as its branch                                                                           |
| The working tree, with uncommitted changes | Look only: there is no commit to finish onto. Commit them to review and finish                   |
| Only some stories (a story prefix)         | Look only: a partial capture reports every story it skipped as removed                           |
| Only some projects                         | Look only: the change's capture of every project stays as it was                                 |
| The default branch                         | Look only: it is never finished onto; finish a pull request's capture instead                    |
| Against a commit's baselines               | Look only: the gate compares a change with its target branch, not with that commit               |

Finishing a local branch commits the accepted baselines and one change statement
(`branch:<name>`) onto the branch. Where the branch is checked out, its files follow the new commit
(changes of your own that the commit does not touch stay as they are). A branch with an upstream is
pushed there; one without stays on this machine, and its row says "pending push". A branch whose
repository still uses tree statements (see [the approval format](approval-format.md)) cannot be
finished this way: open a pull request for it and finish that.

A capture uses the files as they are when it starts. If the branch or the pull request moves while
it runs, the capture is refused at its end, so whatever you review is always a capture of one
commit.

## Security

A capture builds and runs the code it captures. So:

- The working tree and your local branches are captured on this machine without asking, unless
  the branch is at the head of someone else's open pull request: then it is that pull request, and
  the next point applies. Your own pull requests (by the code host login you are signed in as) are
  captured without asking.
- A pull request from the code host can be someone else's code. Capturing it here asks once more,
  naming its author ("This builds and runs the code of #3471 by octocat on this computer"), and the
  server refuses it unless `visual-review.config.json` names a `captureCommand`, the place to
  isolate it from this machine. The server also refuses it when the pull request's head is not the
  one the page showed you.
- Starting and cancelling a capture are writes: like every other write, they are taken only from
  the review page's own origin, with its session.

## `captureCommand`

```json
{
    "captureCommand": "tools/with-browser.sh",
    "projects": { "web": { "storybook": "storybook-static", "build": "npm run build-storybook" } }
}
```

A shell command every capture the page starts runs through: the server appends the
`proofroom run` command line for one project and runs the result with `sh -c` in the checkout. Use
it to apply this machine's own limits (a queue of browser slots, a lower CPU priority) or to run
the capture somewhere isolated. It is optional for the working tree and local branches, and
required for pull requests.

Each project's `build` command runs first, in the same checkout. A branch or a pull request is
checked out on its own (a detached worktree under the work directory, removed afterwards), so its
`build` command must install whatever the build needs there.
