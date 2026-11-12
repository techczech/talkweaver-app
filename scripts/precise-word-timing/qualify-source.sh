#!/bin/sh
# Run with agent-run --scope risk --timeout 1800 --wait 5400.
set -eu
TW_ALIGNMENT_SOURCE_TMP=$(mktemp -d "$PWD/.tw-alignment-source-tests.XXXXXX")
export TMPDIR="$TW_ALIGNMENT_SOURCE_TMP/"
trap 'rm -rf "$TW_ALIGNMENT_SOURCE_TMP"' EXIT HUP INT TERM
npm run build
npm run typecheck
npm run test:precise-word-timing
npm run test:alignment-lifecycle
node scripts/test-transcription-slice2.mjs
node scripts/test-transcription-review.mjs
node scripts/test-transcription-cut-quality.mjs
node scripts/test-shared-settings.mjs
node scripts/run-tests.mjs --tier unit --jobs 4
