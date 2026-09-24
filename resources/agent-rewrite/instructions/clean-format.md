# Clean Format Guide — faithful per-slide transcript clean-up

This guide governs the **Clean** job: turning the raw, verbatim transcript of a recorded talk into a
readable **Script** — one cleaned passage per slide. Cleaning is **faithful**. It is NOT the Notes job
(that is an independent, rewritten document); do not confuse the two.

## The one rule

**Keep the speaker's words and meaning. Tidy the delivery, never the content.**

You are transcribing a human speaking, not rewriting them. A reader who compares your cleaned text to
the audio should find the same things said, in the same order, in the same voice — just legible.

## Do

- **Remove disfluencies**: "um", "uh", "er", "you know", "sort of", "kind of" (when filler), "like" (when
  filler), throat-clearing, and false starts ("I was— I mean, we were going to…" → "We were going to…").
- **Cut verbatim repetition** that is only hesitation ("the the model", "we we need") — keep deliberate
  repetition that carries emphasis.
- **Add punctuation, capitalisation, and sentence boundaries.** Break the run-on stream into sentences
  and short paragraphs where the speaker clearly moved on.
- **Fix obvious transcription errors of proper nouns and technical terms** using the slide's own content.
  `structure.json` gives every slide its `title`, `sectionPath`, authored `markdown`, and `images`
  (with `alt` and `ocrText`). If the transcript says "clawed code" and the slide says **Claude Code**,
  correct it. If it says "mark map" and the slide shows **markmap**, correct it. The slide is the
  authority for names.
- **Keep the speaker's voice and tense.** First person if they spoke in the first person ("I built…").
  Present tense for facts, past for what was done — as they said it.

## Do NOT

- **Do not rewrite, paraphrase, summarise, or compress.** No "the speaker explained that…". These are
  their words.
- **Do not add anything** — no linking sentences, no clarifications, no facts not spoken. (That is the
  Notes job, which marks additions. Clean adds nothing.)
- **Do not reorder** points or merge across slides.
- **Do not invent** words to fill a gap. If the transcript is genuinely garbled and the slide does not
  resolve it, keep it minimal and leave it as spoken rather than guess.
- **Do not add slide links or headings.** The app already groups your text under the right slide; you
  write only the cleaned prose for that slide.

## Inputs

- `transcript.md` — the raw transcript, grouped by slide, with timecodes (trims already removed).
- `structure.json` — the outline tree and, per slide, its `slideNumber`, `title`, `sectionPath`,
  `markdown`, and `images[{src, alt, ocrText}]`. Use the per-slide content to get names right.

## Output

This guide is bundled at `<talk>/agent-rewrite/<run-id>/instructions/`; resolve every relative path
inside that Run pack. Ignore legacy files directly under `<talk>/agent-rewrite/`. Never write
`cleaned.json` or `notes.json`: they are TalkWeaver-owned approval stores.

Write one file per slide into `cleaned/`:

```
cleaned/slide-<slideNumber>.md
```

Each file contains **only the cleaned prose for that slide** (no heading, no slide link, no front
matter) — plain paragraphs. A slide with no spoken words gets no file (the app shows it as silent).

## How to proceed — the app tells you the mode

The app writes a `CLEAN.md` prompt that names one of three working modes. Follow the one it states:

1. **Section by section (approve each).** Clean the slides of the **first section only**, write those
   `cleaned/slide-N.md` files, then **stop and wait** — the person approves that section before you
   continue to the next. Repeat section by section.
2. **One pass.** Clean **every** slide in order, writing all `cleaned/slide-N.md` files, then stop. The
   person reviews the whole cleaned Script at once.
3. **Per slide, on demand.** The prompt lists **specific slide numbers** to clean. Clean only those,
   write their files, and stop.

In every mode: one slide → one `cleaned/slide-<slideNumber>.md`, faithful, nothing added.
