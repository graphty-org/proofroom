# Example change statements

Each file is one example of the approval contract (docs/approval-format.md): a change to the
baselines and the statements a reviewer's Finish committed for it, and whether the gate must pass
it. `test/change-approval.test.mjs` runs every one on a fresh repository and checks the outcome and,
for each statement, whether it validates against docs/change-statement.schema.json.

Fields:

- `description`: what the example shows.
- `expect`: `pass` or `fail`; `problem`, for a failure, is part of the gate's message.
- `schemaValid`: whether every statement validates against the JSON Schema.
- `head`: the files under `visual-baselines/` the change writes (text stands for an image's bytes,
  committed through Git LFS as a pointer), null for a deletion.
- `statements`: the statements, in the order Finish committed them. Strings are replaced before
  signing: `{repository}` by the repository's id, `{capturedHead}` by the change's head before its
  statements, `{baseCommit}` by the base's commit (what a seed's reviewer saw), `{base:<path>}` and `{head:<path>}` by that file's hash at the base and the head (null
  when absent), `{hash:<text>}` by the SHA-256 of the text and `{id:<n>}` by the id of statement n.
  `$unsigned` leaves a statement unsigned, `$file` stores it at another path than its content
  gives, and `$after` changes fields after it is signed (a forgery).
