#!/bin/sh
# A separate machine slot: the complete unit run already has its own recorded result.
set -eu
TW_ALIGNMENT_RUNTIME_TMP=$(mktemp -d "$PWD/.tw-alignment-runtime-tests.XXXXXX")
export TMPDIR="$TW_ALIGNMENT_RUNTIME_TMP/"
trap 'rm -rf "$TW_ALIGNMENT_RUNTIME_TMP"' EXIT HUP INT TERM
npm run typecheck
npm run test:precise-word-timing
npm run test:alignment-lifecycle
node scripts/test-transcription-slice2.mjs
node scripts/test-transcription-cut-quality.mjs
node scripts/test-transcription-review.mjs
node scripts/test-shared-settings.mjs
node scripts/test-run-page.mjs
sh scripts/precise-word-timing/qualify-models.sh
sh scripts/precise-word-timing/qualify-package.sh
node scripts/precise-word-timing/benchmark-utility.mjs en
node scripts/precise-word-timing/benchmark-utility.mjs cs
