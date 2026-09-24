# Rewrite this talk into lecture notes

You are an agent pointed at a folder TalkWeaver prepared from one recorded talk. Everything you need is
in this folder. Draft the **Notes** — an independent, slide-linked document — section by section, and
write each part here for approval.

Run pack: `{{PACK_PATH}}`. This folder is scoped to exactly one Run. Read and write only within this
Run pack; do not use files directly under the parent `agent-rewrite/` folder.

## Inputs (all in this folder)

- `transcript.md` — the verbatim transcript, grouped by slide, with timecodes (trims omitted).
- `structure.json` — the talk's outline: a **recursive** heading tree (any depth) and, for every slide,
  its `sectionPath` (full heading ancestry), `title`, `slideNumber`, timings, the slide's authored
  **`markdown`** (its text, including image references), and **`images`** — each image's `src`, `alt`,
  and **`ocrText`** (the text TalkWeaver extracted from the image for search). Use the slide's markdown
  and image text as the content of each slide; you are not given rendered pictures.
- `instructions/AGENT-INSTRUCTIONS.md` (+ `narrative-format.md`, `data-formats.md`) — **the authoritative
  style guide**. Read it fully before writing. It is the LectureNotesSkill instruction set, bundled with
  TalkWeaver.

Talk: **{{TALK_TITLE}}**
Speaker: **{{SPEAKER_NAME}}**
Event: {{EVENT}} · {{DATE}}

## What to produce — one section at a time, for approval

These are **Notes**: an independent, readable document that links to the slides — NOT the transcript
reflowed. (TalkWeaver renders the faithful per-slide transcript separately as "Script"; you do not
produce that here.)

Work **section by section**, top-level section at a time. For each section:

1. Write it to `parts/NN-<section-slug>.md` (e.g. `parts/01-{{FIRST_SECTION_SLUG}}.md`).
2. **Stop and present it for approval.** Do not move to the next section until the human approves,
   edits, or asks you to regenerate. TalkWeaver folds each approved part into Notes as it lands.

Follow `instructions/narrative-format.md` exactly for every part:

- **Third person, speaker by name** — never "I"/"we".
- Preserve the **recursive heading hierarchy** from `structure.json` (do not flatten — render
  `#`/`##`/`###`/`####` to match each node's `depth`, any depth).
- Each leaf section starts with a **Key points:** bullet list, then prose.
- Reference **every slide** in the section at least once with `[slide N](/slides/N)` syntax.
- Omit filler, housekeeping, audience interaction, self-corrections, repetition (see the guide).
- Bold key terms and tool/product names on first use.

**Grounding + provenance.** Base every claim on `transcript.md`. Notes MAY include a clarifying sentence
or cross-reference that was not said aloud where it genuinely helps a reader — but wrap anything not in
the transcript in `<!-- added -->…<!-- /added -->` so TalkWeaver can mark it. If the transcript is thin
for a slide, keep that part short rather than inventing.

## When you are done with a part

Leave the file in `parts/`. TalkWeaver watches that folder and surfaces each part for approval. You do
not need to run any build. Continue to the next section only once the current part is approved.

`cleaned.json` and `notes.json` are TalkWeaver-owned approval stores. **Do not create, edit, replace,
or delete either file.** Write agent output only to `parts/` (or `cleaned/` when following `CLEAN.md`).

---

*This folder is TalkWeaver's interim handoff. When Bridle is built into TalkWeaver, the same rewrite
runs in-app against these same inputs and instructions — no external agent, no folder to open.*
