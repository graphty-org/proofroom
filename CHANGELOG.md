## 0.2.36 (2026-10-28)

### 🚀 Features

- **tools:** offer only the held nightly head on the review page, from its final capture ([#3741](https://github.com/graphty-org/graphty-monorepo/issues/3741))
- **ci:** finish the features-on configuration: capture query, ordering, on-demand runs ([#3476](https://github.com/graphty-org/graphty-monorepo/issues/3476))
- **visual-review:** flaky story detection and a blocking switch for story outcomes ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** offer nightly screenshot candidates and open the accept pull request on Finish ([#3463](https://github.com/graphty-org/graphty-monorepo/issues/3463), [#3418](https://github.com/graphty-org/graphty-monorepo/issues/3418))
- **visual-review:** merge-results combines the story tests' partial captures ([#3471](https://github.com/graphty-org/graphty-monorepo/issues/3471))
- **visual-review:** take each story's screenshot inside its story test ([#3389](https://github.com/graphty-org/graphty-monorepo/issues/3389), [#3471](https://github.com/graphty-org/graphty-monorepo/issues/3471))
- **visual-review:** add a parity command that compares two captures byte for byte ([#3389](https://github.com/graphty-org/graphty-monorepo/issues/3389))
- **visual-review:** offer a capture of a commit not yet pushed as pending push ([#3369](https://github.com/graphty-org/graphty-monorepo/issues/3369))
- **workspace:** publish graphty and githerd, and fold the fidelity tools into graph-io ([#3322](https://github.com/graphty-org/graphty-monorepo/issues/3322))
- **visual-review:** add ignoreBranches to leave pull requests out of the review page ([#3303](https://github.com/graphty-org/graphty-monorepo/issues/3303))
- **visual-review:** sign the review record of every Finish that commits decisions ([#3238](https://github.com/graphty-org/graphty-monorepo/issues/3238))

### 🩹 Fixes

- **visual-review:** keep merged heads' captures as master's reference ([#4043](https://github.com/graphty-org/graphty-monorepo/issues/4043))
- **visual-review:** pick master's reference capture from its first-parent line ([#4043](https://github.com/graphty-org/graphty-monorepo/issues/4043))
- **visual-review:** stop exporting the capture helpers only capture.mjs uses ([#3969](https://github.com/graphty-org/graphty-monorepo/issues/3969))
- **visual-review:** give both captures' story iframes the same compositor scroll ([#3969](https://github.com/graphty-org/graphty-monorepo/issues/3969))
- **visual-review:** parity agrees when the story-test capture is exactly the baseline ([#3473](https://github.com/graphty-org/graphty-monorepo/issues/3473), [#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** stitch tall screenshots in Chromium, not on the capture's one Node thread ([#3700](https://github.com/graphty-org/graphty-monorepo/issues/3700), [#3980](https://github.com/graphty-org/graphty-monorepo/issues/3980))
- **visual-review:** keep the story tests' Shift press from reaching the story ([#3969](https://github.com/graphty-org/graphty-monorepo/issues/3969))
- **visual-review:** give a transparent story document the top frame's white in story tests ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **ci:** preset FC_FONTATIONS for every Chromium launch; one shared vitest base ([#3787](https://github.com/graphty-org/graphty-monorepo/issues/3787))
- **visual-review:** pin actions/checkout@v7 in the workflow templates ([#3895](https://github.com/graphty-org/graphty-monorepo/issues/3895))
- **visual-review:** focus the capture's story frame before the story loads ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** focus the capture's story iframe, as the story tests do ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** shoot each story inside a same-origin iframe in the capture ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** reset the input modality before each story test ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** stop a timed-out story hook from shooting the next story ([#3743](https://github.com/graphty-org/graphty-monorepo/issues/3743), [#3740](https://github.com/graphty-org/graphty-monorepo/issues/3740))
- **visual-review:** a Dependabot action bump is not workflow drift ([#3769](https://github.com/graphty-org/graphty-monorepo/issues/3769))
- **visual-review:** read the frame height from the document element ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** story tests draw fixed elements in layers as the top frame does ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** write setup-node@v7, the version the workflows use ([#3758](https://github.com/graphty-org/graphty-monorepo/issues/3758))
- **visual-review:** end an approval pull request's description with a No issue line ([#3748](https://github.com/graphty-org/graphty-monorepo/issues/3748), [#3749](https://github.com/graphty-org/graphty-monorepo/issues/3749))
- **visual-review:** confirm a changed story picture in an afterEach hook of its own ([#3740](https://github.com/graphty-org/graphty-monorepo/issues/3740))
- **visual-review:** type scrollFrame and twoFrames for a page as well as a frame ([51fd98b766](https://github.com/graphty-org/graphty-monorepo/commit/51fd98b766))
- **visual-review:** keep pixelDifference module-private so knip passes ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** use Number.parseFloat when moving a pinned element ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** story parity compares decoded pixels, not PNG bytes ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** scroll tiles in quirks mode and test the pinned monospace font ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** shoot oversize stories in tiles, not a beyond-viewport capture ([#1976](https://github.com/graphty-org/graphty-monorepo/issues/1976), [#1982](https://github.com/graphty-org/graphty-monorepo/issues/1982), [#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** draw sticky elements once in story-test tile shots ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** copy only what a scrolled tile holds, instead of compositing the story frame ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** restore fixed styles when compositing a story frame fails ([43202792cf](https://github.com/graphty-org/graphty-monorepo/commit/43202792cf))
- **visual-review:** rewrite a reused accept pull request description so later notes are published ([cb510fbdc6](https://github.com/graphty-org/graphty-monorepo/commit/cb510fbdc6))
- **visual-review:** keep candidateBranch private so knip passes ([4261e7afc4](https://github.com/graphty-org/graphty-monorepo/commit/4261e7afc4))
- **visual-review:** type the optional complete flag of promotion's results ([d8a5973717](https://github.com/graphty-org/graphty-monorepo/commit/d8a5973717))
- **visual-review:** let an uncaptured story's wait decide nothing, and follow bare story imports ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **ci:** make the story capture's quarantine and promotion robust ([#3648](https://github.com/graphty-org/graphty-monorepo/issues/3648), [#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **ci:** keep screenshot runs in their own quarantine family ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** scroll a tile no further than the measured picture's end ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** scroll the body by what the window could not, and move pinned elements with it ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** type the parked iframe element as HTMLElement for the type-check ([50b8065690](https://github.com/graphty-org/graphty-monorepo/commit/50b8065690))
- **visual-review:** a broken story waits for promotion too; a bad quarantine file is a TypeError ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** judge unstable stories and promotion as the test quarantine does ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** let an excluded story finish before the next story test starts ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** type the tester iframe element before setting its style ([#3589](https://github.com/graphty-org/graphty-monorepo/issues/3589), [#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** composite only viewport-fixed elements, and on tall stories too ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** composite the story test's fixed elements as the top-level page does ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** scroll the body only on an axis the window cannot scroll ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** scroll the body when a story's window cannot scroll ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** composite the story-test iframe in its own layer, as a top-level page ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** declare vitest as an optional peer for the vitest entry point ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** templates name the action versions the workflows now use ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** shoot a slice below the viewport by scrolling, not with a full-page shot ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** read a full run's capture and jobs as a called workflow names them ([#3463](https://github.com/graphty-org/graphty-monorepo/issues/3463))
- **visual-review:** close a rejected candidate's accept pull request on a later refresh ([#3463](https://github.com/graphty-org/graphty-monorepo/issues/3463))
- **visual-review:** keep a rejected candidate until its accept pull request is closed ([#3463](https://github.com/graphty-org/graphty-monorepo/issues/3463))
- **visual-review:** story-test shots match graphty-element's built-Storybook capture ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** write the action versions the workflows use ([#3443](https://github.com/graphty-org/graphty-monorepo/issues/3443))
- **visual-review:** keep the story tests' page within the GPU's limits and draw grown frames whole ([#3472](https://github.com/graphty-org/graphty-monorepo/issues/3472))
- **visual-review:** name the approve branch on the sheet and survive its pull request's updates ([#3463](https://github.com/graphty-org/graphty-monorepo/issues/3463))
- **visual-review:** close a rejected candidate's accept pull request ([#3463](https://github.com/graphty-org/graphty-monorepo/issues/3463))
- **visual-review:** rebuild a candidate's accept commit from every decision on it ([#3463](https://github.com/graphty-org/graphty-monorepo/issues/3463))
- **visual-review:** publish decisions per candidate and let a candidate Finish run again ([#3463](https://github.com/graphty-org/graphty-monorepo/issues/3463))
- **visual-review:** end a candidate when its approval merges and never orphan an accept pull request ([#3463](https://github.com/graphty-org/graphty-monorepo/issues/3463))
- **visual-review:** merge-results is complete only when every story file ran ([#3471](https://github.com/graphty-org/graphty-monorepo/issues/3471))
- **visual-review:** keep merge-results under the complexity limit ([#3471](https://github.com/graphty-org/graphty-monorepo/issues/3471))
- **visual-review:** keep merge-results under the complexity limit ([#3471](https://github.com/graphty-org/graphty-monorepo/issues/3471))
- **visual-review:** clear the SonarQube findings on the story-test harness ([#3471](https://github.com/graphty-org/graphty-monorepo/issues/3471))
- **visual-review:** clear the SonarQube findings on the parity command and the spike ([#3389](https://github.com/graphty-org/graphty-monorepo/issues/3389))
- **visual-review:** type the pending-push capture's updatedAt in pendingPreview's return ([#3394](https://github.com/graphty-org/graphty-monorepo/issues/3394))
- **visual-review:** report flaky screenshot items instead of passing them silently ([#3364](https://github.com/graphty-org/graphty-monorepo/issues/3364))
- **visual-review:** ask for the passkey once per Finish ([b2e464affe](https://github.com/graphty-org/graphty-monorepo/commit/b2e464affe))
- **visual-review:** keep a preview current across a Finish, and never hide what is open ([fac9aef880](https://github.com/graphty-org/graphty-monorepo/commit/fac9aef880))
- **visual-review:** show a running Finish on the cards after a reload, whichever answer comes first ([2786823e67](https://github.com/graphty-org/graphty-monorepo/commit/2786823e67))
- **visual-review:** stop offering Finish after a reload while one runs ([#123](https://github.com/graphty-org/graphty-monorepo/issues/123))
- **visual-review:** list pull requests and their CI runs in one GraphQL query ([#2682](https://github.com/graphty-org/graphty-monorepo/issues/2682))
- **workspace:** build with CI's 8 GB heap in the visual-review update check ([51506bbd94](https://github.com/graphty-org/graphty-monorepo/commit/51506bbd94))
- **visual-review:** ask for the session token when the page has none ([0941a4b244](https://github.com/graphty-org/graphty-monorepo/commit/0941a4b244))

### ❤️ Thank You

- Adam Powers @apowers313
- graphty-agent @graphty-agent

## 0.2.35 (2026-10-21)

### 🚀 Features

- **visual-review:** approve baselines by a signed tree, not per pull request ([a19570386](https://github.com/graphty-org/graphty-monorepo/commit/a19570386))

### 🩹 Fixes

- **visual-review:** show the branch's baseline for an item changed only against master ([3ca52fcd5](https://github.com/graphty-org/graphty-monorepo/commit/3ca52fcd5))
- **visual-review:** keep an image unchanged within tolerance when master holds its baseline ([80e413c2c](https://github.com/graphty-org/graphty-monorepo/commit/80e413c2c))
- **visual-review:** check the prepared approval exists before comparing it ([80da7b8b2](https://github.com/graphty-org/graphty-monorepo/commit/80da7b8b2))
- **visual-review:** type the finish approval lookup so a missing entry is handled ([c6dcb5fec](https://github.com/graphty-org/graphty-monorepo/commit/c6dcb5fec))
- **visual-review:** make undecided images obvious and keep them after a partial Finish ([#3235](https://github.com/graphty-org/graphty-monorepo/issues/3235))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.34 (2026-10-20)

### 🚀 Features

- **visual-review:** approve screenshots by a signed baselines tree ([d0bdc047c](https://github.com/graphty-org/graphty-monorepo/commit/d0bdc047c))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.33 (2026-10-18)

This was a version bump only for visual-review to align it with other projects, there were no code changes.

## 0.2.32 (2026-10-17)

### 🚀 Features

- **visual-review:** record review page usage events locally, opt-in ([7218df139](https://github.com/graphty-org/graphty-monorepo/commit/7218df139))

### 🩹 Fixes

- **visual-review:** report a repeated Finish as already finished ([#3040](https://github.com/graphty-org/graphty-monorepo/issues/3040))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.31 (2026-10-15)

This was a version bump only for visual-review to align it with other projects, there were no code changes.

## 0.2.30 (2026-10-15)

### 🩹 Fixes

- **visual-review:** never offer a draft pull request for review ([#2727](https://github.com/graphty-org/graphty-monorepo/issues/2727))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.29 (2026-10-15)

### 🩹 Fixes

- **visual-review:** list pull requests and their CI runs in one GraphQL query ([#2682](https://github.com/graphty-org/graphty-monorepo/issues/2682))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.28 (2026-10-14)

### 🩹 Fixes

- **workspace:** keep core files off in the update check and heap the root builds ([#2562](https://github.com/graphty-org/graphty-monorepo/issues/2562))
- **workspace:** build with CI's 8 GB heap in the visual-review update check ([#2475](https://github.com/graphty-org/graphty-monorepo/issues/2475))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.27 (2026-10-13)

### 🩹 Fixes

- **visual-review:** check an update's merge before pushing it ([#2296](https://github.com/graphty-org/graphty-monorepo/issues/2296))
- **visual-review:** an accept counts as published only while the branch's baseline holds it ([bab1e4cfc](https://github.com/graphty-org/graphty-monorepo/commit/bab1e4cfc))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.26 (2026-10-13)

### 🩹 Fixes

- **visual-review:** ask for the session token when the page has none ([affee9300](https://github.com/graphty-org/graphty-monorepo/commit/affee9300))
- **visual-review:** keep a screenshot approval across a merge of master ([#2272](https://github.com/graphty-org/graphty-monorepo/issues/2272))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.25 (2026-10-13)

### 🩹 Fixes

- **visual-review:** drop a double click's second click by item, and time the guard from the paint ([#2175](https://github.com/graphty-org/graphty-monorepo/issues/2175))
- **tools:** cap each test slot's Node workers at its share of the cores ([9daf98f16](https://github.com/graphty-org/graphty-monorepo/commit/9daf98f16))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.24 (2026-10-12)

This was a version bump only for visual-review to align it with other projects, there were no code changes.

## 0.2.23 (2026-10-11)

### 🩹 Fixes

- **visual-review:** wait for the redraw the settling capture starts before measuring ([#1982](https://github.com/graphty-org/graphty-monorepo/issues/1982))
- **visual-review:** size every capture to the settled page, not the page before the first capture ([#1982](https://github.com/graphty-org/graphty-monorepo/issues/1982))
- **visual-review:** stitch tall captures whose page shrinks after the first slice ([#1976](https://github.com/graphty-org/graphty-monorepo/issues/1976))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.22 (2026-10-11)

### 🚀 Features

- **tools:** fail a CI test that uses more than 25% of its time limit ([#1602](https://github.com/graphty-org/graphty-monorepo/issues/1602))

### 🩹 Fixes

- **visual-review:** capture stories taller than 8,192 device px in stitched slices ([#1958](https://github.com/graphty-org/graphty-monorepo/issues/1958))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.21 (2026-10-10)

### 🩹 Fixes

- **visual-review:** document the review handler as returning a promise ([#1896](https://github.com/graphty-org/graphty-monorepo/issues/1896))
- **visual-review:** let tests wait for the tiles the server makes in advance ([#1896](https://github.com/graphty-org/graphty-monorepo/issues/1896))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.20 (2026-10-10)

### 🩹 Fixes

- **visual-review:** start fewer processes in the journey, gate and commitlint tests ([#1719](https://github.com/graphty-org/graphty-monorepo/issues/1719), [#1720](https://github.com/graphty-org/graphty-monorepo/issues/1720), [#1744](https://github.com/graphty-org/graphty-monorepo/issues/1744), [#1745](https://github.com/graphty-org/graphty-monorepo/issues/1745))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.19 (2026-10-09)

### 🩹 Fixes

- **visual-review:** selecting the story name no longer reflows the header ([cfafa2580](https://github.com/graphty-org/graphty-monorepo/commit/cfafa2580))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.18 (2026-10-09)

### 🩹 Fixes

- **visual-review:** wait on the settled list in the inbox tests, and run the update without git-lfs ([#1601](https://github.com/graphty-org/graphty-monorepo/issues/1601), [#1580](https://github.com/graphty-org/graphty-monorepo/issues/1580), [#1613](https://github.com/graphty-org/graphty-monorepo/issues/1613))
- **visual-review:** see a finished job and a first list load without a fixed wait ([#1530](https://github.com/graphty-org/graphty-monorepo/issues/1530))

### 🔥 Performance

- **visual-review:** make the grid's spotlit and zoomed tiles on the server ([04e9f5295](https://github.com/graphty-org/graphty-monorepo/commit/04e9f5295))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.17 (2026-10-08)

This was a version bump only for visual-review to align it with other projects, there were no code changes.

## 0.2.16 (2026-10-08)

### 🩹 Fixes

- **visual-review:** retry Finish's network steps after a transient failure ([f631fdb1d](https://github.com/graphty-org/graphty-monorepo/commit/f631fdb1d))
- **visual-review:** read approvals from before passkeys off the list request ([34abb97b4](https://github.com/graphty-org/graphty-monorepo/commit/34abb97b4))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.15 (2026-10-08)

### 🚀 Features

- **visual-review:** safe filters, grouped review and pull request context in the review page ([fe6dd3bba](https://github.com/graphty-org/graphty-monorepo/commit/fe6dd3bba))

### 🩹 Fixes

- **visual-review:** reuse an earlier approval only where it cannot be planted ([73463ef6a](https://github.com/graphty-org/graphty-monorepo/commit/73463ef6a))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.14 (2026-10-07)

### 🩹 Fixes

- **visual-review:** treat a decision as published only while the branch holds it ([#1006](https://github.com/graphty-org/graphty-monorepo/issues/1006))
- **visual-review:** suggest Finish only when every project is reviewed ([#888](https://github.com/graphty-org/graphty-monorepo/issues/888))

### 🔥 Performance

- **visual-review:** take the default branch tip from the last refresh ([a7bdfcbea](https://github.com/graphty-org/graphty-monorepo/commit/a7bdfcbea))
- **visual-review:** read the branch tips once per refresh ([72b1eaefd](https://github.com/graphty-org/graphty-monorepo/commit/72b1eaefd))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.13 (2026-10-07)

### 🩹 Fixes

- **visual-review:** compare a merge-queue batch with the commit it sits on ([2752fc86d](https://github.com/graphty-org/graphty-monorepo/commit/2752fc86d))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.12 (2026-10-06)

### 🚀 Features

- **visual-review:** let the gate accept a not-affected marker in place of a capture ([0f2118f90](https://github.com/graphty-org/graphty-monorepo/commit/0f2118f90))
- **visual-review:** group coupled pull requests in the review inbox ([b7f48e3e2](https://github.com/graphty-org/graphty-monorepo/commit/b7f48e3e2))

### 🩹 Fixes

- **tools:** run every test's git without the developer's own git config ([e4840e0f2](https://github.com/graphty-org/graphty-monorepo/commit/e4840e0f2))
- **visual-review:** show a skipped Storybook as not affected and keep renamed root files ([279601c8a](https://github.com/graphty-org/graphty-monorepo/commit/279601c8a))
- **visual-review:** pin member captures in group accept-all and mark group decisions not opened ([e420cc50a](https://github.com/graphty-org/graphty-monorepo/commit/e420cc50a))
- **visual-review:** keep request interception on in the page tests ([#2](https://github.com/graphty-org/graphty-monorepo/issues/2))
- **visual-review:** hold a pull request with a failed story out of the inbox ([d5d8e80df](https://github.com/graphty-org/graphty-monorepo/commit/d5d8e80df))
- **visual-review:** open a target's first project from a link that names no project ([4dcc68437](https://github.com/graphty-org/graphty-monorepo/commit/4dcc68437))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.11 (2026-10-05)

### 🚀 Features

- **visual-review:** open the review page on a pending-approvals inbox and add a quiet notifier ([8cbbd540b](https://github.com/graphty-org/graphty-monorepo/commit/8cbbd540b))
- **ci:** test Mergify batches of up to 4, with a visual gate that accepts a batch ([020bf7138](https://github.com/graphty-org/graphty-monorepo/commit/020bf7138))

### 🩹 Fixes

- **ci:** drop the Microsoft apt sources before apt runs ([3e757a40c](https://github.com/graphty-org/graphty-monorepo/commit/3e757a40c))
- **visual-review:** type the gate's pull request as one number or a batch ([094f91532](https://github.com/graphty-org/graphty-monorepo/commit/094f91532))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.10 (2026-10-05)

### 🩹 Fixes

- **visual-review:** show a local preview while another project of the CI run downloads ([fc534d028](https://github.com/graphty-org/graphty-monorepo/commit/fc534d028))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.9 (2026-10-05)

### 🚀 Features

- **visual-review:** review and finish on a local preview of a pull request ([f5636fb54](https://github.com/graphty-org/graphty-monorepo/commit/f5636fb54))
- **visual-review:** capture with the fonts the config's fontconfig pins ([5eb56d652](https://github.com/graphty-org/graphty-monorepo/commit/5eb56d652))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.8 (2026-10-04)

### 🚀 Features

- **visual-review:** finish without merging master first ([f4cc31c41](https://github.com/graphty-org/graphty-monorepo/commit/f4cc31c41))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.7 (2026-10-04)

### 🩹 Fixes

- **visual-review:** with Focus on, show an image only once its focus point is known ([96302a86b](https://github.com/graphty-org/graphty-monorepo/commit/96302a86b))
- **visual-review:** label a loading Flash, Highlight or Spotlight as that view ([74af30a73](https://github.com/graphty-org/graphty-monorepo/commit/74af30a73))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.6 (2026-10-04)

### 🚀 Features

- **visual-review:** ask the reject reason in its own box; J previous, K next ([#862](https://github.com/graphty-org/graphty-monorepo/issues/862), [#863](https://github.com/graphty-org/graphty-monorepo/issues/863))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.5 (2026-10-04)

This was a version bump only for visual-review to align it with other projects, there were no code changes.

## 0.2.4 (2026-10-04)

### 🚀 Features

- **visual-review:** a compact control panel laid out by use, for an iPad ([#860](https://github.com/graphty-org/graphty-monorepo/issues/860))
- **visual-review:** one breadcrumb to move between targets, projects, grid and item ([#859](https://github.com/graphty-org/graphty-monorepo/issues/859))
- **visual-review:** open each item framed on where to look (Focus, O) ([#858](https://github.com/graphty-org/graphty-monorepo/issues/858))
- **visual-review:** hide the baseline pane so the new image takes both widths ([#857](https://github.com/graphty-org/graphty-monorepo/issues/857))
- **visual-review:** accept what the grid's filter shows ([#856](https://github.com/graphty-org/graphty-monorepo/issues/856))
- **visual-review:** accept a component in place, keeping the grid's place ([#855](https://github.com/graphty-org/graphty-monorepo/issues/855))

### 🩹 Fixes

- **visual-review:** whole labels and a pressable tile Undo on an iPad with hundreds of items ([#123](https://github.com/graphty-org/graphty-monorepo/issues/123), [#855](https://github.com/graphty-org/graphty-monorepo/issues/855), [#859](https://github.com/graphty-org/graphty-monorepo/issues/859), [#860](https://github.com/graphty-org/graphty-monorepo/issues/860))
- **visual-review:** escape closes the grid's More menu, and the crumbs hold still ([#859](https://github.com/graphty-org/graphty-monorepo/issues/859))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.3 (2026-10-03)

### 🚀 Features

- **visual-review:** update a pull request from master in one step ([#673](https://github.com/graphty-org/graphty-monorepo/issues/673))

### 🩹 Fixes

- **visual-review:** offer approvals from before passkeys on a branch behind master ([21920e63](https://github.com/graphty-org/graphty-monorepo/commit/21920e63))
- **visual-review:** sign approvals made before passkeys again from the review page ([2a478234](https://github.com/graphty-org/graphty-monorepo/commit/2a478234))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.2 (2026-10-02)

### 🚀 Features

- **visual-review:** blocking waits in a centered modal, and faster loading ([8fe5078a](https://github.com/graphty-org/graphty-monorepo/commit/8fe5078a))
- **visual-review:** approve Finish with the owner's passkey and enforce it in the gate ([d04b4d6c](https://github.com/graphty-org/graphty-monorepo/commit/d04b4d6c))
- **visual-review:** fixed decision bar, loading progress and next-project flow in the review page ([94564d06](https://github.com/graphty-org/graphty-monorepo/commit/94564d06))
- **visual-review:** cached target list, download progress, thumbnails and a Finish preview ([a4d30061](https://github.com/graphty-org/graphty-monorepo/commit/a4d30061))
- **visual-review:** publish accept notes in Finish's comment and the seed pull request ([1720f048](https://github.com/graphty-org/graphty-monorepo/commit/1720f048))
- **visual-review:** register a passkey and approve Finish with Face ID in the page ([6ca1466f](https://github.com/graphty-org/graphty-monorepo/commit/6ca1466f))
- **visual-review:** passkey registration and approval routes in the review server ([cce0cfb7](https://github.com/graphty-org/graphty-monorepo/commit/cce0cfb7))
- **visual-review:** commit only the passkey-approved record at Finish ([83e1e617](https://github.com/graphty-org/graphty-monorepo/commit/83e1e617))
- **visual-review:** gate requires passkey approvals once a key is registered ([3912c7d6](https://github.com/graphty-org/graphty-monorepo/commit/3912c7d6))
- **visual-review:** verify passkey approvals of review records ([68ca01f2](https://github.com/graphty-org/graphty-monorepo/commit/68ca01f2))

### 🩹 Fixes

- **visual-review:** review page on narrow windows and touch, and the Keys overlay ([edc72f0b](https://github.com/graphty-org/graphty-monorepo/commit/edc72f0b))
- **visual-review:** steady story panes, next project first, finished decisions kept in view ([61f4d890](https://github.com/graphty-org/graphty-monorepo/commit/61f4d890))
- **visual-review:** keep the grid bar's labels on one line, in two rows on an iPad ([04a514c0](https://github.com/graphty-org/graphty-monorepo/commit/04a514c0))
- **visual-review:** start Face ID inside the press, and trust only master's keys ([17b40be5](https://github.com/graphty-org/graphty-monorepo/commit/17b40be5))
- **visual-review:** refuse approvals from another host and numbers with two forms ([9fa904d5](https://github.com/graphty-org/graphty-monorepo/commit/9fa904d5))
- **visual-review:** count a review record only from the base branch's contents ([d18af012](https://github.com/graphty-org/graphty-monorepo/commit/d18af012))
- **visual-review:** fail closed when the server cannot read its passkeys ([9b75eaea](https://github.com/graphty-org/graphty-monorepo/commit/9b75eaea))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.1 (2026-10-02)

### 🚀 Features

- **visual-review:** flash the spotlighted baseline and new image in Spotlight ([48526aa4](https://github.com/graphty-org/graphty-monorepo/commit/48526aa4))

### 🩹 Fixes

- **visual-review:** stale tiles never re-accept, Accept all counts removals, Finish shows restarts ([e283dc64](https://github.com/graphty-org/graphty-monorepo/commit/e283dc64))
- **visual-review:** keep decisions, targets and Finish whole when GitHub, git or the disk fail ([7a61e563](https://github.com/graphty-org/graphty-monorepo/commit/7a61e563))
- **visual-review:** check project ids and mode names before capturing; gate survives bad JSON ([126926a2](https://github.com/graphty-org/graphty-monorepo/commit/126926a2))
- **visual-review:** make the review page's caches, decisions and routing robust ([7c64a548](https://github.com/graphty-org/graphty-monorepo/commit/7c64a548))
- **visual-review:** make Finish show feedback at once and ask in the page ([cd50d329](https://github.com/graphty-org/graphty-monorepo/commit/cd50d329))
- **visual-review:** log gh failures and load the other targets when one fails ([da6678ea](https://github.com/graphty-org/graphty-monorepo/commit/da6678ea))
- **visual-review:** retry gh on network failures and load the other projects when one fails ([842011da](https://github.com/graphty-org/graphty-monorepo/commit/842011da))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.2.0 (2026-10-01)

### 🩹 Fixes

- **visual-review:** an unseeded reference item counts as captured, so status stops alternating ([#632](https://github.com/graphty-org/graphty-monorepo/issues/632))
- ⚠️ **visual-review:** every story needs an approved baseline before a merge ([a7f350b1](https://github.com/graphty-org/graphty-monorepo/commit/a7f350b1))
- **visual-review:** fail closed on projects with no baselines ([6e413454](https://github.com/graphty-org/graphty-monorepo/commit/6e413454))

### ⚠️ Breaking Changes

- **visual-review:** every story needs an approved baseline before a merge ([a7f350b1](https://github.com/graphty-org/graphty-monorepo/commit/a7f350b1))
  the gate fails every story without an approved baseline,
  and visual-review.config.json refuses the removed "gate" project setting.

### ❤️ Thank You

- Adam Powers @apowers313

## 0.1.3 (2026-10-01)

### 🩹 Fixes

- **workspace:** build algorithms and layout before their Storybooks ([8b1d284d](https://github.com/graphty-org/graphty-monorepo/commit/8b1d284d))
- **visual-review:** seed each project on its own, and only those asked for ([26e1767c](https://github.com/graphty-org/graphty-monorepo/commit/26e1767c))
- **visual-review:** keep keyboard focus on the review page so shortcuts work on an iPad ([392b9c63](https://github.com/graphty-org/graphty-monorepo/commit/392b9c63))
- **visual-review:** rasterize captures on the CPU so text renders the same each time ([64a2e89b](https://github.com/graphty-org/graphty-monorepo/commit/64a2e89b))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.1.2 (2026-10-01)

### 🚀 Features

- **workspace:** lay the changed pixels over the images, blink them, make the box optional ([1b12ba88](https://github.com/graphty-org/graphty-monorepo/commit/1b12ba88))

### 🩹 Fixes

- **visual-review:** download each capture once and atomically ([d86b594e](https://github.com/graphty-org/graphty-monorepo/commit/d86b594e))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.1.1 (2026-09-30)

### 🚀 Features

- **visual-review:** pair renamed stories with their old baselines ([92f6a1be](https://github.com/graphty-org/graphty-monorepo/commit/92f6a1be))

### 🩹 Fixes

- **visual-review:** find master's newest capture through its commits ([a45d676f](https://github.com/graphty-org/graphty-monorepo/commit/a45d676f))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.1.0 (2026-09-30)

### 🚀 Features

- ⚠️ **visual-review:** read every repository setting from visual-review.config.json ([c2cfdec2](https://github.com/graphty-org/graphty-monorepo/commit/c2cfdec2))
- **visual-review:** link to every screen and keep decided items in the pass ([6b85c52a](https://github.com/graphty-org/graphty-monorepo/commit/6b85c52a))
- **visual-review:** review and undo decisions from the grid ([101c7a73](https://github.com/graphty-org/graphty-monorepo/commit/101c7a73))
- **visual-review:** fit both captures side by side on one screen ([23c6af01](https://github.com/graphty-org/graphty-monorepo/commit/23c6af01))
- **workspace:** capture like chromatic and make the review page easier to judge ([a8f4ad8c](https://github.com/graphty-org/graphty-monorepo/commit/a8f4ad8c))
- **visual-review:** capture layout's storybook in ci ([a1fe565a](https://github.com/graphty-org/graphty-monorepo/commit/a1fe565a))
- **visual-review:** store baselines in git lfs and seed one story at a time ([cfbb8290](https://github.com/graphty-org/graphty-monorepo/commit/cfbb8290))
- **visual-review:** resume, zoom, keys and accept all in the review page ([90bf7dfa](https://github.com/graphty-org/graphty-monorepo/commit/90bf7dfa))
- **visual-review:** serve the review page and commit accepted baselines ([5e88241f](https://github.com/graphty-org/graphty-monorepo/commit/5e88241f))
- **visual-review:** capture every story of a built storybook ([770b80fb](https://github.com/graphty-org/graphty-monorepo/commit/770b80fb))
- **visual-review:** compare captures with baselines ([59c20d5b](https://github.com/graphty-org/graphty-monorepo/commit/59c20d5b))
- **visual-review:** add the visual-review package and its results format ([ae9d9708](https://github.com/graphty-org/graphty-monorepo/commit/ae9d9708))

### 🩹 Fixes

- **visual-review:** keep the Finish step in the status line when a screen opens ([9f63e8c9](https://github.com/graphty-org/graphty-monorepo/commit/9f63e8c9))
- **workspace:** run visual-review Finish in the background and show its progress ([5bf87820](https://github.com/graphty-org/graphty-monorepo/commit/5bf87820))
- **visual-review:** seed from a commit older than the LFS rule ([ecd396fe](https://github.com/graphty-org/graphty-monorepo/commit/ecd396fe))
- **visual-review:** capture every story as the whole canvas ([0786ff92](https://github.com/graphty-org/graphty-monorepo/commit/0786ff92))
- **visual-review:** crop to what a web component draws inside its shadow root ([a6fccb19](https://github.com/graphty-org/graphty-monorepo/commit/a6fccb19))
- **workspace:** count a canvas inside a shadow root when cropping a capture ([#409](https://github.com/graphty-org/graphty-monorepo/issues/409))
- **workspace:** load the review page in seconds, not 40 ([f184d0e6](https://github.com/graphty-org/graphty-monorepo/commit/f184d0e6))
- **visual-review:** hold layout's master seed until its capture stability is measured ([812d7be2](https://github.com/graphty-org/graphty-monorepo/commit/812d7be2))
- **visual-review:** capture layout as a canvas project and build layout before its storybook ([1974491a](https://github.com/graphty-org/graphty-monorepo/commit/1974491a))
- **workspace:** fit wide captures, warn about missing emoji fonts, align counts ([4423172f](https://github.com/graphty-org/graphty-monorepo/commit/4423172f))
- **workspace:** crop captures to their ink and fix the review page's scrolling ([45dd843f](https://github.com/graphty-org/graphty-monorepo/commit/45dd843f))
- **workspace:** leave out what a scroll area hides when cropping a capture ([25c4ec2f](https://github.com/graphty-org/graphty-monorepo/commit/25c4ec2f))
- **visual-review:** keep test git commands out of the real repository inside git hooks ([3d9bee5a](https://github.com/graphty-org/graphty-monorepo/commit/3d9bee5a))
- **visual-review:** name the signing key, crop highlight, keep posted rejects ([5f877fcb](https://github.com/graphty-org/graphty-monorepo/commit/5f877fcb))
- **visual-review:** require review records in the gate and state its limits ([28b53cb8](https://github.com/graphty-org/graphty-monorepo/commit/28b53cb8))
- **visual-review:** close the merge gate's gaps and document the review ([ed2f7455](https://github.com/graphty-org/graphty-monorepo/commit/ed2f7455))

### ⚠️ Breaking Changes

- **visual-review:** read every repository setting from visual-review.config.json ([c2cfdec2](https://github.com/graphty-org/graphty-monorepo/commit/c2cfdec2))
  visual-review/projects.json is gone: projects and settings are read
  from visual-review.config.json at the repository root (seedFromMaster is now
  seedFromDefaultBranch, stableFrame is now waitFor), and the accept worktree moved
  under the work directory.

### ❤️ Thank You

- Adam Powers @apowers313
