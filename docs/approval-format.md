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

1. **Settings come from the base's config only**: `approvals`, `baselines`, `approvalFormat`,
   `repositoryId` and `selfApproval`. A change that moves `approvals` or `baselines`, or changes
   `repositoryId`, fails. A change may set `approvalFormat` or `selfApproval`; the setting takes
   effect once it is on the default branch.
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
9. **Self-approval**, when the base's config forbids it (see "Forbidding self-approval" below).

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

## Keys and identity

`visual-review/passkeys.json` lists the keys a statement may be signed by:

```json
{
    "version": 1,
    "keys": [
        {
            "id": "<credential id>",
            "publicKey": "<base64url SubjectPublicKeyInfo, P-256>",
            "rpId": "dev.example.com",
            "label": "iPad passkey, 2026-10-01",
            "registeredAt": "2026-10-01T09:12:44.000Z",
            "identity": {
                "user": "rita",
                "emails": ["rita@example.com"],
                "signingKeys": ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA..."]
            }
        }
    ]
}
```

`identity` is optional. It says whose key this is: `user`, the person's user name on the code host
(GitHub); `emails`, the e-mail addresses they commit with; and `signingKeys`, the SSH public keys
they sign commits with, used only outside GitHub (below). It names a user, an e-mail address, or
both. Registering a key on the review page fills in `user` from the account `gh` is signed in as
and `emails` from git's `user.email`, when they are known; check them in the key's pull request,
and add `signingKeys` by hand if you need them. Adding or changing a key is an administrator's
merge, as always.

## Forbidding self-approval

With `"selfApproval": "forbid"` in `visual-review.config.json` on the default branch (the default
is `"allow"`), the gate refuses a change statement signed by a key whose identity contributed to
the change:

```
::error::self-approval -- visual-review-approvals/pr-7/20261025T140211Z-3f9a1c0b2d4e.json: signed by rita (<key id>), who contributed to pr:7; this repository forbids approving your own change
```

The contributors of a change are:

- on GitHub Actions, the account that opened the pull request, and for each of its commits the
  author's and the committer's accounts and e-mail addresses. A commit's signer is its committer:
  GitHub verifies a signature only against the committer's own keys. The gate reads the pull
  request through the GitHub API, so give the gate step the workflow's token:

    ```yaml
    - name: Check visual changes were accepted
      env:
          GITHUB_TOKEN: ${{ github.token }}
      run: npx --yes proofroom@<version> gate ...
    ```

- anywhere else, for each commit of the change, the author's and the committer's e-mail
  addresses, and the identity whose `signingKeys` signed it.

Two kinds of commit do not count: Finish's own commit, recognized by what it changes (one
statement, and only the baseline files that statement's entries name), never by who made it; and a
merge that adds nothing of its own, such as a clean merge of the default branch.

The policy fails closed. With it on, the gate fails when:

- any key in the base's `visual-review/passkeys.json` has no `identity`, since a key without one
  could be anyone's;
- a commit of the change, other than the two kinds above, carries no signature the code host
  verifies (outside GitHub: no SSH signature by one of the `signingKeys` an identity names), since
  anyone can write any name and e-mail address into a commit;
- GitHub cannot be asked (no `GITHUB_TOKEN`, an error, or a pull request of 250 commits or more,
  more than GitHub lists);
- a version 1 tree statement approves the change, since its signer is not checked: use change
  statements (`"approvalFormat": "change"`).

The policy is only as strong as the code host's identities. It trusts GitHub to say who opened the
pull request and whose key signed a commit, and it trusts each key's `identity` as an administrator
merged it. Someone with two accounts on the code host, or a key whose identity names the wrong
person, gets past it.

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

## What Finish writes: `approvalFormat`

Finish writes the format the repository's gate reads, chosen by the default branch's
`visual-review.config.json`, so a change that edits its own config never switches it:

- `"approvalFormat": "change"`: one change statement per Finish, as above, and nothing under
  `<baselines>/reviews/`. The review records already there stay as they are; the review page still
  reads them, with the statements, to preselect images approved before.
- `"approvalFormat": "tree"`: a tree statement and a review record, as `@graphty/visual-review`
  wrote them.
- No `approvalFormat`: `"tree"` when the approvals directory on the default branch holds tree
  statements and no change statement (a repository coming from `@graphty/visual-review`), else
  `"change"`.

In change mode, every Finish that commits a decision signs one statement with one passkey touch,
whatever it leaves undecided or rejects; a Finish that only rejects posts its comment and writes no
statement. The statement names the change's newest statement on the branch as `previous`, and
both ends of a fork when there are two, so Finishing again closes it.

A statement committed unsigned, while the default branch held no key, fails the gate once a key is
there. The next Finish of that change removes it and signs a new statement of what it decides, so
decide again every snapshot the unsigned statement held.

A capture of the default branch (a seed) cannot be approved with a change statement: in change
mode, Finish refuses it. Accept those snapshots on a pull request's capture instead.

Two Finishes of one change can race: each builds its commit on the branch tip it fetched, and the
first push wins. When a push is refused, Finish fetches the branch again and:

- when the new commits hold the captured head and change none of the files this Finish writes (the
  author pushed code, say), makes the same commit, with the same signed statement, on the new tip
  and pushes it, with no new touch;
- when the branch gained another statement of this change that decided no snapshot differently,
  pushes nothing and asks you to press Finish again: the new statement names the other as
  `previous`, with one touch;
- otherwise pushes nothing, naming the snapshots the two Finishes decided differently, or saying
  the capture is stale.

The repository's id (see "Repository") must be known when Finish writes a change statement: on
GitHub it is read from GitHub, elsewhere it is the default branch's `repositoryId`, and without one
Finish refuses.

### Moving a repository to change statements

1. Run proofroom's gate in CI (`proofroom gate`, with `--change` or `--pr`). It reads tree
   statements and change statements both while the base is in tree mode.
2. Then set `"approvalFormat": "change"` in `visual-review.config.json` and merge it. From the next
   Finish on, the review page writes change statements, and the gate refuses tree statements.

Never set it while CI still runs `@graphty/visual-review`'s gate: that gate reads only tree
statements, and would fail every change finished afterwards. A repository whose CI runs proofroom's
gate but has not set `approvalFormat`, and whose approvals directory holds tree statements, keeps
receiving tree statements, which that gate still reads, so leaving it unset is safe.

## Where the gate's trust comes from

The gate proves what it checks only if it runs. On a pull request, CI runs the pull request's own
workflow file, so a change can alter the pinned proofroom version or drop the gate step, and no
check inside the gate can see that. Protect it outside the gate: run the gate's workflow from the
default branch (on GitHub, a ruleset's required workflow), or require code owner review of
`.github/` with the gate a required check. The gate also warns when a change edits the workflow,
`visual-review/passkeys.json` or `visual-review.config.json`.
