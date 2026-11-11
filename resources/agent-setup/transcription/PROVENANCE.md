# Vendored transcription script — provenance

`parakeet_to_srt.py` in this folder started as a verbatim copy and now carries TalkWeaver's own
additions (below). It ships with TalkWeaver so that setting up
transcription assumes nothing outside this repository (spec
`docs/plans/cloudflare-setup-in-app/spec-cloudflare-setup-in-app.md`, D16; ADR-0003, amendment of
2026-10-09). Duplication with the source is accepted by that rule.

- Source: the author's own speech-to-text skill (`speech-to-text/scripts/parakeet_to_srt.py`), copied byte for byte. Upstream repository:
  `techczech/speech-to-text-skill`.
- Last commit touching the file: `e16747717d0bd4a3b0f9b9b42bcfd2715e660043` (2026-07-10); repository
  head at copy time `03cc74de628ccd13c4e6f57bbcc5f488bc5af1a3` (2026-07-24).
- Copied: 2026-10-09. SHA-256 of the verbatim copy:
  `bbc019d405252ba8bfb600eaee45aaf7d4791c7902bbd2205448082bf528904a`.
- Changed in TalkWeaver on 2026-10-19 (video ticket 01, word timings): an optional
  `--words <file.json>` writes `{"words": [{"text", "start", "end"}]}` in seconds, words assembled
  from Parakeet's aligned sub-word tokens; opening punctuation (a quote, ¿, «, a bracket) joins the
  word after it and other punctuation the word before; SRT times are now
  rounded to the nearest millisecond (they were truncated) so each word lies inside its segment.
  Without `--words` the script behaves as before. SHA-256 of the file as shipped now:
  `e45d0de86786edef8fdb699fff058df5cf0cf9b332729edfd4d1afd1ed593487`.
- Changed 2026-11-03: punctuation-only sentences append their text without extending a word
  beyond the preceding sentence’s time span. Trailing pending punctuation within the same sentence
  retains its end time.
- Licence: the copy ships under TalkWeaver's MIT licence (`LICENSE` at the repository root);
  Dominik Lukeš, who holds the copyright in both, confirmed this on 2026-10-09. The source carries
  no licence file; its own provenance record classes the skill as Dominik's original work ("fine to
  publish as Dominik's", test fixtures excluded; none are copied here).
- Not copied: the skill's test fixtures (third-party broadcast content and family data), its other
  engines and references.

The script imports `parakeet_mlx` only when it transcribes, so `--help` runs without the speech
packages. It needs `ffmpeg` on `PATH` (TalkWeaver puts its own there when it runs the script).

When the source changes, copy it again, re-apply TalkWeaver's additions (or take them upstream
first), update the hashes and dates above, and run `npm run test:transcription-setup:python` and,
where Parakeet is installed, `npm run test:transcription-words:python`. TalkWeaver asks a script for
words only when its `--help` lists `--words`, so the upstream script without it still works.
