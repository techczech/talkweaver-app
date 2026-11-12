#!/bin/sh
# macOS 26 + Xcode 26 SDK. Run via agent-run --wait 5400, never around the slot.
# Command exits do not settle the mixed-language or continuous-human-cut quality gates.
set -u
out=docs/design/2026-11-10-record-and-edit-video/built/slice-2
mkdir -p "$out"
slice_overall=0
slice_stage_status=0
run() {
  slice_label=$1
  slice_log=$2
  shift 2
  "$@" > "$out/$slice_log" 2>&1
  slice_stage_status=$?
  printf '%s: exit %s\n' "$slice_label" "$slice_stage_status"
  if [ "$slice_stage_status" -ne 0 ]; then slice_overall=1; fi
}
run 'full unit tier' final-unit.log npm run test:unit
run 'isolation rechecks' rechecks.log node scripts/recheck-slice2-failures.mjs final-unit.log
run 'typecheck' typecheck.log npm run typecheck
run 'build' build.log npm run build
if [ "$slice_stage_status" = 0 ]; then
  native/transcription --inventory > "$out/final-inventory.json" 2> "$out/final-inventory.stderr"
  slice_stage_status=$?
  printf 'native inventory: exit %s\n' "$slice_stage_status"
  if [ "$slice_stage_status" -ne 0 ]; then slice_overall=1; fi
  run 'native fixture' native-fixture.log node scripts/test-native-transcription.mjs
  run 'native acceptance probes' probes.log python3 scripts/probe-native-transcription.py
  run 'hidden Settings' ui.log node e2e/slice2-words.mjs
  run 'hidden Settings repeat' ui-repeat.log node e2e/slice2-words.mjs
  run 'native adapter' native-adapter.log node scripts/probe-native-adapter.mjs
  run 'English waveform' human-english-waveform.log node scripts/plot-speech-probe.mjs english
  run 'Czech waveform' human-waveform.log node scripts/plot-speech-probe.mjs
  run 'English cut measurement' human-english-measurement.log node scripts/measure-human-probe.mjs english
  run 'Czech cut measurement' human-measurement.log node scripts/measure-human-probe.mjs
else
  printf '%s\n' 'NOT RUN: runtime checks require a fresh successful build'
fi
run 'contract checks' contract-tests.log node scripts/test-transcription-slice2.mjs
exit "$slice_overall"
