# Vendored Compiler — Provenance

This directory is a verbatim vendored copy of the rendering compiler from the
`html-presentations` skill (a TalkWeaver predecessor, being retired). It is the
single source of TalkWeaver's slide rendering and ships inside the app.

- Source repo: `~/gitrepos/05_skills/html-presentations`
- Vendored: 2026-06-22
- Layout mirrors the original (`scripts/` + sibling `reference/`, `assets/`) so the
  compiler's `scriptDir = dirname(import.meta.url)/..` asset resolution is unchanged.

## What was taken (transitive closure TalkWeaver imports)
- `scripts/lib/`: 01-cli-utils, 02-triggers-layout, 03-markdown-lexer, 04-html-extraction,
  05-icons, 06-block-renderers, 07-assembly, 08-source-adapters, 09-output-builders,
  10-projections, 12-outline-edit
- `scripts/`: triggers.mjs, highlight.mjs
- `reference/`: layout-templates, fixtures, reference-outline, layout-fixture-map (+ .mjs),
  fixtures-thumbnail-map.json, fixtures-assets/two-box.svg
- `assets/`: icons/{lucide,svgl,extra,concept-icons}.json,
  templates/presenter-popup-single-html.html, vendor/qrcode-generator.js

## What was dropped (never imported by TalkWeaver)
- lib/11-cli.mjs, lib/13-editor-app.mjs, all test-*.mjs / build-*.mjs / tooling scripts
- reference/reference-deck.html (12 MB built artifact; the server route that reads it,
  `buildServer` in 09-output-builders, is never invoked by TalkWeaver), READMEs, .DS_Store

## Editing policy
Do NOT hand-edit these files in Phase 1 — they are a vendored snapshot. Phase 2 ports
modules to TypeScript under `src/main/compiler/`, at which point this tree is retired
module-by-module.
