# Clean the Script — {{TALK_TITLE}}

You are cleaning the raw transcript of a recorded talk into a readable **Script**, one passage per
slide. This is the **Clean** job — faithful tidy-up, not rewriting. Read
`instructions/clean-format.md` first and follow it exactly: keep the speaker's words and meaning,
remove disfluencies, add punctuation and sentence breaks, fix names using each slide's own content —
**add nothing, reorder nothing, summarise nothing**.

Run pack: `{{PACK_PATH}}`. This folder is scoped to exactly one Run. Read and write only within this
Run pack; do not use files directly under the parent `agent-rewrite/` folder.

## Inputs (in this folder)

- `transcript.md` — the raw transcript, grouped by slide, timecodes included, trims removed.
- `structure.json` — the outline and, per slide, its `slideNumber`, `title`, `sectionPath`, authored
  `markdown`, and `images[{src, alt, ocrText}]`. This is your authority for spelling names and terms.
- `instructions/clean-format.md` — the faithfulness rules. Binding.

## Output

One file per slide, cleaned prose only (no heading, no slide link, no front matter):

```
cleaned/slide-<slideNumber>.md
```

A slide with no spoken words gets no file.

`cleaned.json` and `notes.json` are TalkWeaver-owned approval stores. **Do not create, edit, replace,
or delete either file.** Your only output for this job is in `cleaned/`.

## Your working mode for this run

{{MODE_INSTRUCTIONS}}

When you finish the slides this mode asks for, **stop** and let the person review in TalkWeaver.
