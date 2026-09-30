## 0.1.1 (2026-09-30)

### 🚀 Features

- **visual-review:** pair renamed stories with their old baselines ([92f6a1be](https://github.com/graphty-org/graphty-monorepo/commit/92f6a1be))

### 🩹 Fixes

- **visual-review:** find master's newest capture through its commits ([a45d676f](https://github.com/graphty-org/graphty-monorepo/commit/a45d676f))

### ❤️ Thank You

- Adam Powers @apowers313

## 0.1.0 (2026-09-30)

### 🚀 Features

- ⚠️  **visual-review:** read every repository setting from visual-review.config.json ([c2cfdec2](https://github.com/graphty-org/graphty-monorepo/commit/c2cfdec2))
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

### ⚠️  Breaking Changes

- **visual-review:** read every repository setting from visual-review.config.json  ([c2cfdec2](https://github.com/graphty-org/graphty-monorepo/commit/c2cfdec2))
  visual-review/projects.json is gone: projects and settings are read
  from visual-review.config.json at the repository root (seedFromMaster is now
  seedFromDefaultBranch, stableFrame is now waitFor), and the accept worktree moved
  under the work directory.

### ❤️ Thank You

- Adam Powers @apowers313