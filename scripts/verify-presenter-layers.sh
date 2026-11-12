#!/bin/sh
set -u
DEST=docs/design/2026-11-10-record-and-edit-video/built/slice-1
status=0
run() { name="$1"; shift; "$@" > "$DEST/$name.log" 2>&1; result=$?; echo "$name exit $result"; if [ "$result" -ne 0 ]; then tail -30 "$DEST/$name.log"; status=1; fi; }
run build npm run build
if [ "$status" -ne 0 ]; then exit "$status"; fi
run typecheck npm run typecheck
run layers node scripts/test-recording-layers.mjs
run audio-loss node scripts/test-present-audio-loss.mjs
run stream node scripts/test-recording-stream.mjs
run permissions node scripts/test-recording-permissions.mjs
run e2e node e2e/diagnose-presenter-layers.mjs
run unit npm run test:unit
exit "$status"
