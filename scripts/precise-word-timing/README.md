---
title: Precise word timing build and qualification
register: FOR AGENTS
status: shipping models measured; production security gate and signed hidden walkthrough passed; review pending
created: 2026-11-10
---

Run from repository root. Runtime: TypeScript + ONNX Runtime 1.31.1 in an Electron utility process. Its arm64 binary requires macOS 14; earlier Macs get an unavailable explanation before any native load. Python scripts are local build-time conversion/inventory tools; no Python runtime, weights or audio enter the app bundle.

- Install: `bun install --frozen-lockfile` (real local node_modules).
- Inventory: `python3 scripts/precise-word-timing/inventory-model-hosts.py`.
- English public INT8: `python3 scripts/precise-word-timing/fetch-english.py` (exact revision and all hashes).
- Export tools: `uv venv --python 3.12 scripts/precise-word-timing/local/export-venv`; `uv pip install --python scripts/precise-word-timing/local/export-venv/bin/python --exclude-newer '7 days' -r scripts/precise-word-timing/export-requirements.txt`.
- Local Czech conversion: `~/.local/bin/agent-run --wait 5400 -- scripts/precise-word-timing/local/export-venv/bin/python scripts/precise-word-timing/export-ctc.py cs --source <pinned-snapshot-folder>`. Exact input weight SHA-256 and configuration Git blobs are in `export-input-pins.json`. No remote code loading or upload.
- Public audio: existing `scripts/restore-cut-point-audio.py` and `scripts/fetch-cut-point-corpus.py czech`. Never regenerate frozen reference labels.
- Models: after conversion, `~/.local/bin/agent-run --wait 5400 -- sh scripts/precise-word-timing/qualify-models.sh` runs both languages through the app's real chunk/inference/validation/write service, then executes the original scorer unchanged, computes fixed-label companion tables and generates listening pairs.
- Source/full unit: `~/.local/bin/agent-run --scope risk --timeout 1800 --wait 5400 -- sh scripts/precise-word-timing/qualify-source.sh`. It uses repository-local temporary fixtures and preserves every assertion. The known baseline watcher failures remain failures, not load-only passes.
- Runtime/package/signed hidden UI/actual utility metrics: `~/.local/bin/agent-run --scope risk --timeout 1800 --wait 5400 -- sh scripts/precise-word-timing/qualify-runtime-final.sh`. This is separate from the full suite so signing keeps its own time budget; no release archive, installation or publication.
- FP32 control: `~/.local/bin/agent-run --wait 5400 -- sh scripts/precise-word-timing/qualify-precision-control.sh`.
- Actual utility performance: `~/.local/bin/agent-run --wait 5400 -- node scripts/precise-word-timing/benchmark-utility.mjs en` and `cs`, after `npm run build`.
- Utility smoke: `~/.local/bin/agent-run --wait 5400 -- node scripts/precise-word-timing/smoke-utility.mjs`.
- Actual synthetic hour: `~/.local/bin/agent-run --wait 5400 -- node scripts/precise-word-timing/long-recording.mjs`.

`local/` and `.tw-*` are ignored. Downloaded/exported models and corpus audio stay there. Listening output: `.tw-listening-slice2b/`; only its manifest goes in the acceptance directory. Do not upload any weights. The coordinator handles the owner's hosting decision separately.

Manifest data: `resources/alignment-models/{en,cs}.json`, version 1. Null/missing/invalid entry means unavailable. A `download` entry needs a pinned HTTPS URL; a `local` entry needs the expected hash/size and offers Install from file. Both go through the same verified atomic store. Runtime never accepts a model path or URL from a renderer. A native Settings picker selects local files; other windows cannot install/remove/download.

Runtime map:

- `src/shared/word-alignment.ts`: CTC path, normalisation, confidence and midpoint primitives.
- `src/main/alignment-inference.ts`: bounded PCM normalisation, ORT logits, token-to-word mapping.
- `src/main/alignment-model-bytes.ts`: no-follow descriptor read into a size-bounded buffer; SHA-256 over exactly the bytes ORT parses, closing the pathname replacement race.
- `src/main/alignment-worker.ts`, `alignment-utility.ts`: one utility process per alignment job, reused across bounded chunks, killed on cancellation/quit.
- `src/main/alignment-chunks.ts`: pause-preferred word ownership, provisional joins with overlapping context and revalidation in `alignment-service.ts`.
- `src/main/alignment-model-store.ts`, `alignment-models.ts`: atomic verified download/local install, source manifests and status. Crash partials are unusable and a new operation cleanly restarts; status removes only manifest-matching dead-owner partials, preserving live/foreign files.
- `src/main/alignment-service.ts`: explicit vault home, authority across awaits, latest automatic job queue, final staging/rename barrier, provenance and readback. Earlier transcripts survive failure/cancellation/staleness. Publication adds to the raw original metadata after validating through the read projection; a closed view cannot turn a committed result into a failure.
- `src/main/transcription.ts`: explicit alignment invalidation and automatic post-commit hook, carrying the captured vault home.
- `src/main/index.ts`: Settings-only model mutations and Tools-only Run alignment/readback/cancellation.
- `PreciseWordTimingSettings.tsx`, `Studio.tsx`: locked Settings/Run states. Source, production-package and event-fixture proof remain separately reported.

CTC label identity is model-specific: English blank/pad is 0 and its word separator is 4; Czech blank/pad is 43 and its word separator is 0. The manifest reader rejects separator/blank collisions and disagreement with a declared pad label. Qualification asserts the shipping alphabet equals the pinned checkpoint configuration/vocabulary; a one-word silence smoke alone cannot detect a wrong word separator.

Normalisation `ctc-nfc-v1`: NFC; curly apostrophe to ASCII; model case; strip Unicode punctuation/separators except apostrophe. Digits and out-of-alphabet characters are recorded, never expanded into guessed speech. The model's unknown label preserves their place in the CTC target; unsupported words themselves retain earlier times and remain unplaced. Confidence is the minimum character geometric-mean posterior, threshold 0.5, not a calibrated probability. Unknown joins and overlapping aligned ranges are marked unplaced. Only two consecutive confident words get a clean shared midpoint.

Read acceptance.md for the measured confidence coverage, precision trade-offs, and current package/test proof; no release, installation into the owner's apps, merge or model publication is authorised in this lane.

Privacy: `ORT_DISABLE_TELEMETRY=1` is set in the utility environment before native import. Conversion/measurement entry points also opt out before import; the Python converter additionally forces local-only/offline model loading. Node and Python ORT are pinned to 1.31.1; ONNX conversion tools to 1.23.2. See the frozen export requirements and primary-source privacy notes in acceptance.md.

Package source boundary: `scripts/alignment-package-inputs.cjs` evaluates the installed builder's normalised matchers before copying. Platform file lists include their positive app allowlist; negative-only lists can implicitly include the whole worktree. A regression test exercises both forms, and the final content check requires only out/, package.json and production node_modules in the app root, with no model/audio anywhere.
