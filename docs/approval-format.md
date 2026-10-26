# The approval format

Every baseline file a change alters needs a reviewer's signed approval before the change can
merge. `proofroom gate` checks this in CI. This page describes what an approval is, where it is
stored, and the exact rule the gate applies to it.

Words used here:

- **Change**: a pull request (GitLab: merge request; plain git: a branch).
- **Base**: the default branch commit the change is checked against. **Merge result**: the change
  merged onto the base, which CI captures and gates.
- **Hash** of a baseline file: the PNG's SHA-256, read from its Git LFS pointer (no image is ever
  downloaded), or the SHA-256 of the bytes of any other file, such as a story settings file.

## The change statement

One Finish on the review page writes one change statement, and the reviewer's passkey signs it
once. It lists every decision of that Finish.

```json
{
    "version": 2,
    "type": "change-approval",
    "repository": "github:123456789",
    "baselines": "visual-baselines",
    "change": "pr:3486",
    "capturedHead": "<commit whose capture the reviewer saw>",
    "previous": null,
    "approvedAt": "2026-10-25T14:02:11Z",
    "entries": [
        { "path": "app/button--primary.dark.png", "from": "<hash>", "to": "<hash>", "decision": "accept" },
        { "path": "app/old-id.png", "from": "<hash>", "to": null, "decision": "accept", "movedTo": "app/new-id.png" },
        { "path": "app/new-id.png", "from": null, "to": "<hash>", "decision": "accept", "movedFrom": "app/old-id.png" },
        {
            "path": "app/spinner--loading.json",
            "from": null,
            "to": "<hash>",
            "decision": "exclude",
            "reason": "animation never settles"
        },
        {
            "path": "app/empty.light.png",
            "from": "<hash>",
            "to": "<hash>",
            "decision": "reject",
            "reason": "the toolbar lost its border"
        }
    ],
    "approval": { "credentialId": "...", "authenticatorData": "...", "clientDataJSON": "...", "signature": "..." }
}
```

| Field             | Meaning                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`, `type` | Always `2` and `"change-approval"`.                                                                                                                                                                                                                                                                                                                                     |
| `repository`      | The repository's id (see "Repository" below).                                                                                                                                                                                                                                                                                                                           |
| `baselines`       | The baselines directory the entries' paths are relative to.                                                                                                                                                                                                                                                                                                             |
| `change`          | The change, as the code host names it: `pr:3486`, `mr:212`, `branch:feat/x`.                                                                                                                                                                                                                                                                                            |
| `capturedHead`    | The change's own head commit whose capture the reviewer saw; never a merge commit CI built.                                                                                                                                                                                                                                                                             |
| `previous`        | `null` for the change's first statement; otherwise the id of the one before it, or an array of ids when it closes a fork (see "Order").                                                                                                                                                                                                                                 |
| `approvedAt`      | When the reviewer finished, in UTC. It names the file; it never decides order.                                                                                                                                                                                                                                                                                          |
| `entries`         | One per decided file: `path` (relative to the baselines directory), `from` (the hash the reviewer was shown on the default branch's side, null when absent), `to` (the hash decided, null for a deletion), `decision` (`accept`, `exclude` or `reject`), an optional `reason`, and `movedTo` / `movedFrom` for the two halves of a rename. A path appears at most once. |
| `approval`        | The passkey's WebAuthn assertion.                                                                                                                                                                                                                                                                                                                                       |

The JSON Schema is [change-statement.schema.json](change-statement.schema.json). No other field is
allowed.

### Its id and its signature

The canonical JSON of a document is its JSON with object keys sorted and no whitespace.

- The passkey signs the SHA-256 of the canonical JSON of the statement without `approval`: that
  hash is the WebAuthn challenge.
- The statement's **id** is the SHA-256 of the canonical JSON of the whole statement, `approval`
  included. `previous` and the file name use it.

### Where it is stored

```
<approvals>/<change>/<approvedAt>-<first 12 hex digits of its id>.json
```

`<approvals>` is the config's `approvals` directory (default `visual-review-approvals`), `<change>`
is `change` with `:` and `/` written as `-`, and `<approvedAt>` is written without `-`, `:` or
fractions of a second. For example:

```
visual-review-approvals/pr-3486/20261025T140211Z-3f9a1c0b2d4e.json
```

The folder and the name must be the ones the content gives. Names are unique, so two changes'
statements never conflict in a merge, and merging the default branch into a change never voids
them.

## Repository

`repository` stops a statement made in one repository counting in another that trusts the same
reviewer key.

- On GitHub Actions it is `github:<numeric repository id>`, which the gate reads from
  `GITHUB_REPOSITORY_ID`. A rename or a transfer of the repository does not change it, and no file
  a change edits can set it.
- Anywhere else it is `repositoryId` in `visual-review.config.json` on the default branch, for
  example a random UUID. It has no default: without it no change statement counts. Once set it
  never changes, and a change that changes it fails.

## What the gate checks

On the merge result against the base:

1. **Settings come from the base's config only**: `approvals`, `baselines`, `approvalFormat` and
   `repositoryId`. A change that moves `approvals` or `baselines`, or changes `repositoryId`,
   fails. A change may set `approvalFormat`; it takes effect once it is on the default branch.
2. **Keys** come only from `visual-review/passkeys.json` on the base. A change that edits it fails
   once the base holds a key, and so does one that would leave no key. While the base holds no
   key, no signature is checked: that is how a repository registers its first key.
3. **History is append-only.** A change that modifies or deletes a file the base holds under the
   approvals directory or under `<baselines>/reviews/` fails, naming the file.
4. **What the change alters**: every file under the baselines directory whose content differs
   between the base and the merge result, `reviews/` left out. When there is none, the approval
   check passes.
5. **Which statements count**: the files the change adds under the approvals directory. Each must
   parse, match the schema, sit where its content says, verify against a key of the base (user
   verification, the key's host, the challenge), and name this repository and this baselines
   directory. A statement that fails any of this fails the gate, naming its file; a bad signature
   is never ignored, even in a statement nothing needs. Then:
    - A statement that names another change is not counted (the gate prints a notice). A change
      started from another open change's branch therefore Finishes its own decisions on that
      change's files until it lands.
    - A statement of this change must have a `capturedHead` that is in the change's history and not
      on the base. One whose signed content (everything but `approval`) matches a statement that
      ever existed in the default branch's history fails: a landed statement never counts again,
      whether kept under its name, copied under another, or signed again.
6. **Order**: a change's statements form one chain through `previous`. Newer means later in the
   chain, never a later `approvedAt`. A `previous` that names no statement of the change fails, and
   so do two statements that both end the chain ("two Finishes of this change were made at once;
   finish again"). Finishing again closes the fork without deleting anything: the new statement
   names both ends in `previous`.
7. **Every altered file is approved**: for each file, with `b` its hash at the base and `h` at the
   merge result (null when absent), the newest decision in the chain must be `accept` or
   `exclude` with `from` equal to `b` and `to` equal to `h`.
    - A `reject` fails with its reason.
    - No decision fails as "not reviewed".
    - Another `from` fails as stale: the default branch changed the file after the review; update
      the change and decide it again.
    - Two ends of a closed fork that decided the file differently, with no later decision, fail.
8. Entries for files the change does not alter are ignored.

So an approval cannot move to another story (the path is matched exactly), another repository or
another change, and a superseded image cannot come back: once the default branch accepts Z over Y,
every entry that approved Y has a `from` other than Z, and a landed statement never counts again.
The gate never reuses an image hash approved elsewhere. Removing a key voids every statement it
signed that has not landed; landed baselines are never checked again.

What the signature does not prove: that the reviewer looked at every image. And a change's author
can delete a statement from their own unmerged branch, dropping a later reject; the deletion shows
in the change's diff.

The command:

```
proofroom gate --captures <dir> --base <ref> [--head <ref>] [--change <id> | --pr <number>]
```

`--pr N` is the same as `--change pr:N`.

## Tree statements (coming from @graphty/visual-review)

`@graphty/visual-review` signed the whole baselines directory instead: a version 1 tree statement
at `<approvals>/<tree>.json`. They still verify, in **tree mode** only:

- In tree mode the change passes when it adds the tree statement of exactly its merge result's
  baselines tree, or when change statements cover what it alters. A tree statement already on the
  base never counts, so a change cannot restore an earlier approved tree without a review.
- In **change mode** a version 1 statement is refused.

The mode is the base config's `approvalFormat` (`"change"` or `"tree"`). Without one, the gate is
in tree mode. Version 1 statements name no repository, so tree mode trusts any repository that
trusts the same key; it exists for moving over.

## Where the gate's trust comes from

The gate proves what it checks only if it runs. On a pull request, CI runs the pull request's own
workflow file, so a change can alter the pinned proofroom version or drop the gate step, and no
check inside the gate can see that. Protect it outside the gate: run the gate's workflow from the
default branch (on GitHub, a ruleset's required workflow), or require code owner review of
`.github/` with the gate a required check. The gate also warns when a change edits the workflow,
`visual-review/passkeys.json` or `visual-review.config.json`.
