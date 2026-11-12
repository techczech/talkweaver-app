#!/bin/sh
# Run through agent-run; no app launch or installation.
set -u
out=evidence/builtin-transcription-review
result=0
run() {
 label=$1; shift
 "$@" > "$out/second-$label.log" 2>&1
 code=$?
 last=$code
 printf '%s: exit %s\n' "$label" "$code"
 if [ "$code" -ne 0 ]; then result=1; fi
}
run review sh scripts/verify-transcription-review.sh
run native-build npm run build:native
if [ "$last" -ne 0 ]; then printf "NOT RUN: native runtime/package checks require a fresh native build\n"; exit 1; fi
run baseline-measurement node scripts/measure-cut-point-corpus.mjs
run measurement-reconciliation python3 scripts/validate-cut-point-measurements.py
run threshold-table node scripts/report-clean-cut-thresholds.mjs
printf '%s\n' 'NOT RETAINED: relative RMS candidate failed the no-worse corpus gate; see relative-calibration.json and rejected-relative evidence.'
if [ "$(cat "$out/build.exit")" != 0 ]; then printf "NOT RUN: package requires a fresh successful app build\n"; exit 1; fi
run package npx --no-install electron-builder --mac --dir --publish never -c.mac.notarize=false
if [ "$last" -ne 0 ]; then printf "NOT RUN: security checks require a fresh successful package\n"; exit 1; fi
run production-security node scripts/verify-electron-security.cjs release/mac-arm64/TalkWeaver.app
run package-signature node scripts/verify-mac-package.mjs --require-signed release/mac-arm64/TalkWeaver.app
run helper-entitlements /usr/bin/codesign -d --entitlements :- release/mac-arm64/TalkWeaver.app/Contents/Helpers/transcription
run helper-empty-entitlements python3 scripts/verify-transcription-entitlements.py
run signed-public-helper python3 scripts/probe-signed-transcription-helper.py
exit "$result"
