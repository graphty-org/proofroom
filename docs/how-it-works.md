# How it works

proofroom keeps an approved picture of every story of your Storybooks (a baseline PNG in your
repository, stored with Git LFS), shows you every story that no longer looks like its baseline, and
keeps a pull request from merging until you have decided each one.

1. **Capture and compare (CI).** On every pull request and every push to your default branch, one
   job per Storybook builds it and runs `proofroom run`: every story is opened in Chromium (1200 x
   900 at device scale factor 2, a fixed clock, software WebGL, WebGPU removed), shot once per
   snapshot (a story, or a story in one mode), and compared with its baseline the moment it is shot.
   The job uploads what needs review (`results.json`, the new images, the baselines they were
   compared with, the list's pictures and a JUnit file) as an artifact. A snapshot that draws
   differently from one render to the next is the runner's to shoot again: `run --retries 1`, or
   your test runner's own retries. See [Capture and compare](capture-and-compare.md).
2. **Review (your machine).** `proofroom serve` lists every open change (pull request) that has
   captures, downloads them, and serves the review page: the changes, each change's snapshots, and
   a viewer that shows a snapshot side by side, flashing, highlighted or spotlit against its
   baseline. You accept, reject (with a reason the author reads) or exclude each one. See
   [The screens](the-screens.md) and [What each decision does](decisions.md).
3. **Finish.** One button publishes your decisions on a change: the accepted images are committed
   to its branch, the rejects are posted as one comment, and your passkey signs a statement of
   what you decided. CI captures again, and the accepted snapshots now read `unchanged`. See
   [Finish](finish.md).
4. **Gate (CI).** The "Visual gate" job fails while a pull request holds a snapshot nobody accepted,
   or baselines that differ from the base branch's without your signed approval. See [The approval
   format](approval-format.md).

Every story needs a baseline you approved before a pull request can merge. A story with no baseline
blocks every pull request until you accept it, either on a pull request or by seeding it from the
default branch, so seed a project's baselines before its stories start blocking work.

There is no service, account or per-snapshot bill: the captures live in your CI's artifacts, the
baselines live in git, and the review page runs on your own machine and reads both through the `gh`
CLI with your login (or, [without GitHub](plain-git.md), from plain git and a folder).
