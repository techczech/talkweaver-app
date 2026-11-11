---
name: talkweaver
description: Use TalkWeaver, a presentation app. Create and revise talks as Markdown outlines, cut Pathways, convert PowerPoint decks, make handouts (including any handout or follow-up notes after a delivered talk or workshop), process recordings into Scripts or Notes, set up publishing and read or change the app's settings through its command line. Content and app use, not TalkWeaver development.
metadata:
  app: talkweaver
  app-version: 0.43.0
---

# TalkWeaver

Markdown outline = canonical source. Slides and exported decks are projections. A Pathway = an alternate ordered cut of the same slides. A Run = a record of one delivery.

## Reach the app

- Command: `talkweaver <command>`. Installed with this skill by the app (a small script in `~/.local/bin`; add that folder to `PATH` if the command is not found).
- Fallback: the app's own binary with the same arguments: `/Applications/TalkWeaver.app/Contents/MacOS/TalkWeaver <command>`.
- Three command families, all in [CLI](references/cli.md): `setup` (publishing, live service, recording storage, transcription), `settings` (read and change preferences and shortcuts), `agent` (this skill's own install state).
- Check before acting: `talkweaver setup status --json`, `talkweaver settings list --json`. Do only what the states call for.
- `setup` refuses while TalkWeaver is open. `settings` and `agent` run beside the open app.
- Never ask for a token or key in chat; never put one in an argument. See [set-up procedure](references/talkweaver-setup.md).
- No command edits outlines, builds decks or exports handouts. Those are file work plus the app's own UI: see [available surfaces](references/available-surfaces.md).

## Search the knowledge stores first

- Before producing new material, search the federated stores you have, for outlines, saved slide versions, session abstracts, lessons, research reports and reading highlights.
- Run: `scout search --hybrid --limit 20 --json "<query>"` (all corpora), or add `--in <corpus>` to restrict. `scout similar <passage-id>` finds neighbours.
- Passage ids look like `<corpus>:<path>:<line>`.
- Reuse a hit by reference: copy it with its passage id or `scout cite` output as provenance. Never retype it without that. Check quotes with `scout verify-quote`.
- Nothing reusable stays only in chat: before your final answer, file every table, visualisation, piece of evidence and search result worth keeping with `scout capture` into the project's `research/` folder, with its sources.
- Command: `scout capture --project <talk folder> --kind <kind> --title "<title>" [--prompt "<question>"] [--source scout:<id>|URL|file:<path>]... [--artefact <file>] --by agent --json -` (body on stdin). Kinds: `evidence`, `table`, `visualisation`, `snippet`, `search`, `widget`.
- Inspect: `scout capture --list --project <talk folder>`; `scout capture --where-used <file>` finds Markdown that mentions a file.

## Establish the task

Locate the vault, the Talk and its `*-outline.md`. Read frontmatter, existing slide IDs, object conventions and the manifest before changing anything. Classify the request: source revision, Pathway, extraction/conversion, handout, recording transcription, Script cleanup, rewritten Notes, app set-up, settings.

For app recording work, identify the exact Talk and Run/session before reading its files. Standalone audio transcription needs only the supplied source and output scope; do not require a nonexistent Talk or Run.

Use only what exists: the commands above, the app's UI when authorised, ordinary file tools. Do not invent a CLI, install a bridge, start a development server or change app code.

## Planning a talk is not this skill's job

This skill covers how TalkWeaver content is structured and operated: outlines, sections and subsections, slide identity, layouts, Pathways, Runs, handouts and recordings. How a talk is planned, sized and reviewed belongs to the author. If the author has a presenting-style skill or notes (pace, slide density, narrative and planning habits), load them before planning and give them to every reviewer. Without one, ask the author for the duration, the audience and an earlier talk of theirs to take the pace from; do not apply a general slides-per-minute rule.

What this skill does require of any plan:

- Implement the planned hierarchy as real section and subsection headings using the content-format contract; a slide count is not structure.
- When the author asks for an outline or proposal first, deliver it before changing the canonical outline, and keep the existing talk intact while it is under review.
- Once implementation is authorised, keep the latest complete version in the main canonical outline and normal Talk entry; preserve an earlier draft as an archive when needed.
- When the author requires every source slide, verify ordered coverage of wording, heading levels, parents and layouts before accepting additions.

## Choose the content operation

- For SVG figures, interactive HTML widgets and source-linked visual galleries with portable insertion codes, use `talkweaver-visuals` when available.
- Website or web app on a slide: `[embed: <url>]` first, then one or more screenshots under it as saved views, so the presenter can show the live site and fall back to the screenshots on a slow connection. Capture fresh screenshots into the Talk's `assets/` when none exist:

  ```
  [embed: https://example.org]
  <!-- saved views {capture} -->
  ![Saved view, <date>](assets/<file>.png){capture}
  ```
- Shorter or reordered cut of existing slides: a Pathway. Keep the outline and slide IDs unchanged.
- Revised ideas or wording: precise source edits. Move whole slide blocks with notes, triggers and assets. Do not renumber IDs after a move or title change.
- Before building a custom HTML widget or diagram image, choose a native layout or object from the [layout and object chooser](references/layout-and-object-chooser.md): every registered trigger by content shape, with syntax, an example and how often it is used. Native slides stay editable by the author; a widget is for interaction a slide cannot show.
- New content: a draft outline. Use registered layout and object syntax; do not invent triggers from their English names.
- AI chat or terminal slide (a chat or shell transcript drawn as a slide): `{chat}`, `{chat-lanes}`, `{terminal}`, `{terminal-agent}` per [AI chat and terminal slides](references/talkweaver-ai-chat-and-terminal-slides.md). Strip secrets and personal data first.
- Formats: [outline and Pathway formats](references/content-formats.md). Research material: [research folder](references/research-folder.md).

## Conversion, handouts and recordings

- After a talk or workshop has been delivered and recorded, "a handout" (with "more explanation to go along with the slides") means the Run's **Notes**, drafted from the recording into the Run pack, approved in TalkWeaver and exported with the Run handout. It never means a new web page or a page on another site.
- Every talk gets a self-study companion as well as its recording: a summary per section, the talk's widgets in self-study mode, and links. Offer it when a talk is finished, together with a short summary video: a new script written from the transcript and Notes, voiced in the house narrator, about 5-7 minutes for an hour's talk or several 2-4 minute videos for a workshop, linked from the Notes (`animated-talk-video` N76, N77).
- [Extraction and conversion](references/talkweaver-extraction-conversion.md): PowerPoint to outline, import-cleanup packs, gaps report.
- [Handout creation](references/talkweaver-handout-creation.md): select Talk or Run, build the audience export through the app, verify, publish only to an authorised destination.
- [Recording and transcript processing](references/talkweaver-recording-processing.md): locate audio and transcript, clean the Script, draft Notes in the app-prepared pack.

These workflows use the current app contracts. Older standalone conversion, handout-site and lecture-notes skills may describe different formats; use them only for a matching legacy project or an explicitly requested alternative. Do not create a new website or repair application code to complete an ordinary content request.

## File-only workflow

Read and draft with ordinary file tools. Apply requested edits only within the authorised content scope, against freshly read bytes and with concurrent editor state accounted for. If an open unsaved buffer cannot be ruled out, prepare a separate patch/revision instead of overwriting the live outline or manifest. Preserve unrelated keys and bytes.

Do not edit the slide ledger or manufacture app-save receipts. External edits cannot be described as app-saved, ledgered or undoable without evidence from the app.

## Verify

Check stable IDs, Pathway order, missing references, balanced fences and relative assets. Use a compiler or preview only through an existing verified surface; opening Markdown or running an app build is not a presentation preview. Distinguish source prepared, compiled, visually checked, exported, published. Publishing needs authorisation for that destination; a request for a local preview does not give it.

## Image crop and markup

The in-process verbs `imageEdit.read` and `imageEdit.save` are the typed functions `readImageEdit` and `saveImageEdit` in `src/main/image-edit.ts`. Read with the target talk's authorised vault root and pooled image id. Save with original id, a version-1 recipe (crop rectangle and arrow/box/highlight/text marks in original oriented pixels), and a live vault-write check. Direct posture; save returns a new image id. The UI uses these same operations through `window.tw.asset.readImageEdit` / `saveImageEdit`. Files are a derived PNG plus `<id>.edit.json` in `_assets`, beside the untouched original. Use the returned reference only where requested. Reopening an edited id reads its original and recipe. No external CLI route is provided for these in-process verbs.
For static offline HTML copies of web pages and local widgets, see [Offline web pages](references/offline-web-pages.md).
