# What an agent can and cannot do in TalkWeaver

Commands exist only for set-up, settings and this skill's install: see [CLI](cli.md). Everything else goes through files and the app's own windows.

| Surface | Appropriate action |
| --- | --- |
| Read-only file access | Inspect outlines, slide IDs, assets, manifests; produce a proposed revision. |
| Authorised content-file writes, editor state resolved | Apply narrow source and manifest changes; preserve unknown fields; verify fresh bytes. Report file changes without claiming app lifecycle effects. |
| The app's windows, when you can drive them | Use observed commands when authorised. Do not assume a keyboard shortcut ran. |
| `talkweaver setup`, `settings`, `agent` | See [CLI](cli.md). |

No command compiles, previews, exports or publishes a talk. If you cannot drive the app, finish the content draft or the change proposal and say the app preview is unverified. That does not stop useful authoring work.

Do not substitute any older presentation pipeline for the app's own compiler without verifying format compatibility and the person's intent.
