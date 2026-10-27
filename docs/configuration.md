# Configuration: the systems proofroom works with

proofroom talks to four outside systems: the code host that holds your changes, the store that
holds CI's captures, the source of your stories, and the browser that draws them. Four keys in
`visual-review.config.json` name which one each is. All four are optional, and the first value of
each is its default, so a config that leaves them out works exactly as one that sets them to it.

```json
{
    "codeHost": "github",
    "captureStore": "github-actions",
    "stories": "storybook",
    "renderer": "playwright-chromium",
    "projects": {
        "web": { "storybook": "packages/web/storybook-static" }
    }
}
```

| Key            | Values                           | What it is                                                                                                                                                                                                                                                                                                                   |
| -------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codeHost`     | `github`, `plain-git`            | Where your pull requests are. The review page lists them, and Finish comments on them, sets the "Visual review" commit status, files issues and opens pull requests, all with your `gh` login. `plain-git`: your branches are the changes, with no GitHub ([Using it without GitHub](plain-git.md)); it needs `repositoryId` |
| `captureStore` | `github-actions`, `local-folder` | Where CI's captures are: the `visual-<project>-<attempt>` artifacts of the runs of your `workflow`, and the `visual (<project>)` jobs that made them. `local-folder`: no CI, every capture is made on this machine; the default under `plain-git`                                                                            |
| `stories`      | `storybook`                      | Where the stories come from: each project's built Storybook (its `storybook` directory, built by its `build` command)                                                                                                                                                                                                        |
| `renderer`     | `playwright-chromium`            | What draws each story: Playwright's Chromium, at a 1200 x 900 viewport and device scale factor 2                                                                                                                                                                                                                             |

Any other value is refused when the config is read, with a message naming the key and the values
it accepts.

Local previews and `proofroom serve --results <dir>` are read from folders on this machine
whatever `captureStore` says.
