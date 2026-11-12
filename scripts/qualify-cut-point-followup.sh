#!/bin/sh
# All heavy checks use the shared runner; public fixtures and hidden owned UI only.
set -u
followup_tmp=$(mktemp -d "$PWD/.tw-followup-tmp.XXXXXX")
export TMPDIR="$followup_tmp"
trap 'rm -rf -- "$followup_tmp"' EXIT
out=docs/design/2026-11-10-record-and-edit-video/built/slice-2
status=0
run() {
 label=$1
 shift
 "$@" > "$out/final-followup-$label.log" 2>&1
 code=$?
 printf '%s: exit %s\n' "$label" "$code"
 if [ "$code" -ne 0 ]; then status=1; fi
}
run typecheck npm run typecheck
run build npm run build
run unit npm run test:unit
run focused node scripts/run-tests.mjs test:transcription-setup test:transcription-words test:transcription-words-assembly test:transcription-inline test:transcription-slice2 test:transcription-native test:microphone-choice test:recording-recovery-real test:electron-security
run settings node e2e/slice2-words.mjs
run adapter node scripts/probe-native-adapter.mjs
run native-build npm run build:native
run package npx --no-install electron-builder --mac --dir --publish never -c.mac.notarize=false
run security-gate node scripts/verify-electron-security.cjs release/mac-arm64/TalkWeaver.app
run mac-package node scripts/verify-mac-package.mjs --require-signed release/mac-arm64/TalkWeaver.app
run helper-entitlements /usr/bin/codesign -d --entitlements :- release/mac-arm64/TalkWeaver.app/Contents/Helpers/transcription
run signed-helper python3 scripts/probe-signed-transcription-helper.py
exit "$status"
