# Usage events

Off by default. With `"usage": true` in `visual-review.config.json`, the review page records how you
use it, so its layout and controls can be improved from real use. The page sends each event to the
`serve` process it was loaded from, and that process appends it to
`<workDir>/state/usage-events.jsonl` on its own disk. Nothing goes anywhere else: no third-party
script, no other server. With the setting off, the page sends nothing and no file is written.

Each line is one JSON event with its `type`, the time `at` (milliseconds since 1970) and `s`, an id
made new at each page load (a session). The page writes:

| Type       | When, and what it holds                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| `load`     | The page loaded: viewport width and height (`w`, `h`) and device pixel ratio (`dpr`)                   |
| `action`   | A control pressed: its action id (`a`, for example `accept`) and how (`via`: `pointer` or `key`)        |
| `controls` | The controls on screen not seen before in the session, by action id, so the report can name those never used |
| `idle`     | No event for a minute or more: the gap, in milliseconds                                                |

No image, no pull request text, no reject or exclude reason and no session token is recorded: the
server drops any event that contains the token.

`proofroom usage` sums the file up as plain text, or as JSON with `--json`; `--since 2026-10-01`
leaves out older events. It reports the sessions, the controls and keys used most, least and never
(a control counts as used when it was pressed either way), and the gaps. It also reads the events
`@graphty/visual-review`'s page wrote (`press`, `item`, `decide` and the rest), so a file kept from
before moving over sums up in one report.

To delete what was recorded, delete `<workDir>/state/usage-events.jsonl`. To stop recording, set
`"usage": false` (or remove it) and restart `serve`.
