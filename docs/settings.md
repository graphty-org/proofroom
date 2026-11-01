# Settings

**Settings**, in the review page's top bar, holds, in this order:

- **Theme**: Light, Dark, or Match the system (the default).
- **Highlight color**: the color Highlight paints changed pixels in: red (the default), magenta or
  cyan.
- **Keys**: **Single-letter keys** on or off (see [Keys](keys.md)). Off, only the arrows, Enter,
  Esc, Tab and Space work.
- **Passkeys**: every passkey Finish accepts on this server, by name and host, and those still
  waiting for their pull request to merge. **Register passkey...** registers one for the host the
  page is served from: press **Create the passkey** and confirm on your device (Face ID, Touch ID or
  a security key). The server then opens a pull request adding the key to
  `visual-review/passkeys.json` on the default branch, and the page names the key's credential id:
  merge that pull request only if it names the same id. See [Approving with a
  passkey](../README.md#approving-with-a-passkey).
- **Picture storage**: how much the server may keep on disk (the config's `diskBudget`, 10 GB by
  default) and how much it holds now. See [Troubleshooting](troubleshooting.md).
- **Repository setup**, closed until you open it: the adapters, that is the code host, capture
  store, story source and renderer the server uses, from `visual-review.config.json`, and for each
  the functions it lacks with the buttons hidden because of them (for example, plain git has no CI,
  so "CI" in New capture is unavailable). Read only. When CI takes no capture requests, the closed
  line reads "Repository setup: 1 problem".

The keys switch, the Highlight color and the theme are kept in this browser. The passkeys, the
picture storage and the adapters are the server's.
