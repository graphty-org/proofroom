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
- ⚠️  **visual-review:** every story needs an approved baseline before a merge ([a7f350b1](https://github.com/graphty-org/graphty-monorepo/commit/a7f350b1))
- **visual-review:** fail closed on projects with no baselines ([6e413454](https://github.com/graphty-org/graphty-monorepo/commit/6e413454))

### ⚠️  Breaking Changes

- **visual-review:** every story needs an approved baseline before a merge  ([a7f350b1](https://github.com/graphty-org/graphty-monorepo/commit/a7f350b1))
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
