# Developing proofroom

Node 22 or later, git and git-lfs:

```sh
npm ci
npx playwright install chromium
npm run lint    # ESLint and the TypeScript type check
npm test        # the Node tests, the Playwright page tests and the published-files check
```

`package-lock.json` is committed; `npm ci` installs exactly it. To change a dependency, use npm
11 or later (`npx npm@11 install ...`): npm 10 fails to resolve vitest 4's optional peers ("Cannot
read properties of null (reading 'edgesOut')"), though its `npm ci` installs the lock file fine.

`scripts/check-old-gate.mjs <graphty-monorepo checkout>` checks that `test/fixtures/old-gate/`
still holds the gate graphty-monorepo runs, which proofroom's output must keep passing until that
repository moves to proofroom.
