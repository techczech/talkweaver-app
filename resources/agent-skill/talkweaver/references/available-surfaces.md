# What an agent can and cannot do in TalkWeaver

Use the [CLI](cli.md) for publishing a Talk handout, setup, settings and skill installation. Work with source files and the app's windows for the other content operations.

| Surface | Appropriate action |
| --- | --- |
| Read-only file access | Inspect outlines, slide IDs, assets, manifests; produce a proposed revision. |
| Authorised content-file writes, editor state resolved | Apply narrow source and manifest changes; preserve unknown fields; verify fresh bytes. Report file changes without claiming app lifecycle effects. |
| The app's windows, when you can drive them | Use observed commands when authorised. Do not assume a keyboard shortcut ran. |
| `talkweaver setup`, `settings`, `agent` | See [CLI](cli.md). |
| `talkweaver publish` | Publish the Talk handout when the owner asks, check a dry run or read its previous attempts. |

Deck previews and file exports use the app. If you cannot drive the app, finish the draft or change proposal and say the app preview is unverified.

Do not substitute any older presentation pipeline for the app's own compiler without verifying format compatibility and the person's intent.
