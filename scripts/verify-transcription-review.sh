#!/bin/sh
set -u
out=evidence/builtin-transcription-review
result=0
run() {
  label=$1
  shift
  "$@" > "$out/$label.log" 2>&1
  status=$?
  printf "%s\n" "$status" > "$out/$label.exit"
  printf '%s: exit %s\n' "$label" "$status"
  if [ "$status" -ne 0 ]; then result=1; fi
}
run focused node scripts/run-tests.mjs test:transcription-cut-quality test:transcription-review test:transcription-slice2 test:transcription-words test:transcription-words-assembly test:transcription-inline test:transcription-setup test:transcription-setup:python test:transcription-words:python
run typecheck npm run typecheck
run build npm run build
run native-fixture npm run test:transcription-native
run unit npm run test:unit
exit "$result"
