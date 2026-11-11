# TalkWeaver extraction and conversion

## Select the source and operation

- Identify the source PPTX, existing extraction bundle or legacy handout export; inspect its instructions and destination. Keep the original read-only. Use a fresh output directory.
- Default PPTX route: the separate **TalkWeaver PPT Extractor** application. Its portable extraction and derived TalkWeaver outline are distinct outputs. Do not assume an importer inside TalkWeaver has the same interface.
- Use an observed UI command or an actually exposed app tool. Current Extractor UI: choose **PowerPoint**, choose the destination parent, optionally configure original-slide rendering in **Settings**, then **Extract PowerPoint**. Verify labels and results in the installed version.
- No installed command-line extractor exists. Do not build the app, run development scripts or invent extraction flags.

## Inspect the extraction

The current Extractor produces portable `presentation.md`, `presentation.json`, per-slide source records, content-addressed assets and a derived `talkweaver-outline.md`. Preserve the complete bundle and its manifest; use actual paths from its records. Do not move only the outline and strand its assets. Normal app extraction creates a numbered sibling rather than overwriting an earlier output; independently check the actual destination when using another surface.

Compare the source inventory with extracted slides, notes, sections, tables/SmartArt and images/video. Keep wording and source speaker notes; report missing, duplicated, hidden or deliberately omitted items. Distinguish extracted text, native editable content, original-slide images and unsupported content. Use original renders as evidence, not proof of editable conversion.

Original-slide PNG rendering is optional and needs the installed renderer dependencies (currently LibreOffice and Poppler). Text/media extraction can still succeed without those renders. If rendering fails, retain successful extraction and report render status separately. If the Extractor crashes, inspect its output and error first; a fresh retry with optional rendering disabled is appropriate only when available and relevant. Do not loop on the same failing operation.

## Import-cleanup pack, when supplied

Read the pack's `AGENTS.md`, `PROMPT.md` and `instructions/` first. Honour selected slides and passes. Inspect each slide's original render when present, extracted source, deterministic decision and current Markdown. These pack files are inputs; write suggestions only to the designated outputs.

Current output: `suggestions/slide-NNN.json`, one per selected slide. Required fields:

- `slideNumber`: the source slide number.
- `category`: `structure`, `layout`, `accessibility` or `editorial`.
- `evidence`: at least one real relative evidence-file path in that pack.
- `rationale`: explain the supported change.
- `markdown`: the complete proposed slide block, retaining identity and source content.
- `sourcePreserving`: false for editorial rewriting, which requires the selected `editorial` pass.

Do not add path-control fields or edit accepted output behind the app. Parse each JSON, check evidence paths and slide identity, then report suggestions prepared. App acceptance remains unverified until observed. Pack existence does not establish that every installed version can create or accept it.

## Manual recovery or conversion

Use only when explicitly requested or already authorised by the user's task. Follow destination workspace rules. Do not replace the current Extractor with a retired converter by default, rewrite extraction JSON to hide gaps, or change extractor/compiler code.

Work from preserved source text, notes, media and renders. Preserve slide order and meaning; account for structural title/section slides rather than assuming compiled slide count must equal PPTX count. Retain an original render when an unsupported visual has no faithful native equivalent. Flag unreadable or missing content; invent nothing.

Prepare a separate Talk candidate with `<slug>-outline.md`, `<slug>-abstract.md`, `<slug>-conversion-report.md` and relative assets, following [content formats](content-formats.md). Keep source metadata/evidence private; never invent a public URL. Treat the Extractor's `talkweaver-outline.md` as tool-owned output; adapt a copy for a destination requiring a different basename and verify all relative references.

The report records source, destination, source/imported slide accounting, notes and media coverage, layout decisions, omissions, warnings and unresolved gaps. Compile through a verified current surface when available. Compare representative text, tables, diagrams, notes and media against original slides. Keep the candidate separate when destination rules require review before installation. Report extraction, conversion, compilation and visual review separately; compiler success alone does not establish faithful conversion.
