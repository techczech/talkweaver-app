# resources/agent-rewrite — bundled agent instructions for the Notes rewrite

These files ship with the app (electron `extraResources` → `agent-rewrite/`, resolved at runtime from
`process.resourcesPath/agent-rewrite` in prod, this folder in dev). When the user runs **Rewrite…** on a
recording, the main process copies `instructions/` into that recording's handoff pack and renders
`PROMPT.template.md` into the pack's `PROMPT.md`. See ADR-0013 and
`docs/design/2026-07-15-talk-as-text/`.

- `instructions/AGENT-INSTRUCTIONS.md` — the lecture-notes workflow.
- `instructions/narrative-format.md` — the authoritative style guide.
- `instructions/data-formats.md`, `instructions/transcript-formats.md` — supporting references.
- `PROMPT.template.md` — the per-talk prompt; `{{PLACEHOLDERS}}` are filled at pack-write time.

**Provenance:** Adapted from an internal lecture-notes skill. Version-pinned to the app build so
every pack is self-contained and reproducible.

**Future:** when Bridle is built into TalkWeaver, the same instructions drive an in-app agent — no pack,
no external tool. The pack is the contract that makes that swap invisible to the user.
