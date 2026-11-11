# TalkWeaver handout creation

## Select the intended content

- After a talk or workshop has been delivered and recorded, "a handout" (with "more explanation to go along with the slides") means the Run's **Notes**, drafted from the recording into the Run pack, approved in TalkWeaver and exported with the Run handout. It never means a new web page or a page on another site.

- Establish whether the user wants the whole Talk or a named Run, and whether the deliverable is local or public. Reuse the existing Talk; do not scaffold a separate handout website by default.
- For a Talk, use the intended canonical outline revision and current editor content, resolving unsaved edits before export.
- For a Run, read its identity, event/date and `slideSet`; use the app's Run handout operation. A Pathway Run requires its selected slide order, not the whole outline.
- The current Run builder resolves the Run against current Talk content and current Pathway membership. It does not by itself establish a historical snapshot of what was delivered. If the request is for the exact delivered content, verify its archived source/cut; report the gap if unavailable.

## Build locally

Discover the installed app's export/build UI or connected tool. The app's export operations are not shell commands, and no command-line handout builder exists. Do not invent a bridge. A separately verified compiler CLI is usable only with its documented handout mode and compatible source format.

Current Talk export writes `dist/<slug>-handout.html` beside the outline and returns its path. Run builds return the actual output path plus selected `slideIds` and `missing` references; use those results rather than guessing the filename. Check missing references and inspect the generated output before claiming the requested cut is complete. Do not hand-edit generated HTML.

The standard audience handout uses the reading export with speaker notes excluded (`includeNotes: false`). It is distinct from the presenter view, raw transcript, cleaned Script and rewritten Notes. A request for a handout does not itself authorise including private recording material. If the user specifically requests a transcript-based reader or notes handout, prepare the appropriate approved content and verify that the chosen export supports it; do not imply standard export includes it automatically.

Verify the file exists and opens, title/event/date match, selected slides and order are correct, assets and links work, and speaker notes/private material are absent. Check offline behaviour only to the extent actually tested; externally linked resources and live services may still need a network. A file-only draft is useful, but is not an app-generated handout or verified preview.

## Publish when authorised

Publication is a separate operation. Use the configured existing Talk or Run publishing surface only for the authorised destination and content. Inspect the complete candidate before publishing. Do not add credentials, change hosting/routing, create a new deployment project, or publish to obtain a local preview.

Let the app manage publication metadata and URLs. Read back the returned live page, download and relevant links before claiming delivery. A local file URL or local QR code is not a phone-accessible public URL. Distinguish built locally, visually checked, published and live-verified; do not infer one from another.
