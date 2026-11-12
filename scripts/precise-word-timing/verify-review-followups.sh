#!/bin/bash
# Local qualification only. No installed application, real vault, private audio or model upload.
set -u
cd "$(dirname "$0")/../.." || exit 1
proof=docs/design/2026-11-10-record-and-edit-video/built/slice-2b
failures=0
run_check(){
  name="$1";shift
  "$@" > "$proof/review-final-$name.log" 2>&1
  result=$?
  printf '%s exit %s\n' "$name" "$result"
  if [ "$result" -ne 0 ];then failures=$((failures+1));fi
  return "$result"
}
git rev-parse HEAD > "$proof/review-final-head.txt"
# The existing worktree basename has no dots; install into its own real node_modules.
run_check install bun install --frozen-lockfile || exit 1
[ -d node_modules ] && [ ! -L node_modules ] || exit 1
run_check focused node scripts/run-tests.mjs --jobs 4 test:precise-word-timing test:alignment-lifecycle test:transcription-setup test:transcription-words test:transcription-words-assembly test:transcription-inline test:transcription-review test:transcription-cut-quality test:transcription-slice2 test:transcription-native test:saved-transcription-status test:recording-layers test:electron-security
run_check typecheck npm run typecheck
run_check build npm run build || exit 1
run_check utility node scripts/precise-word-timing/test-utility-lifecycle.mjs
run_check native npm run build:native || exit 1
run_check package npx --no-install electron-builder --mac --dir --publish never -c.mac.notarize=false -c.directories.output=.tw-alignment-review-package || exit 1
run_check security node scripts/verify-electron-security.cjs .tw-alignment-review-package/mac-arm64/TalkWeaver.app
run_check mac-package node scripts/verify-mac-package.mjs --require-signed .tw-alignment-review-package/mac-arm64/TalkWeaver.app
run_check package-content node scripts/precise-word-timing/verify-package-content.mjs .tw-alignment-review-package/mac-arm64/TalkWeaver.app
run_check unit node scripts/run-tests.mjs --tier unit --jobs 4
printf 'qualification stages failed: %s\n' "$failures"
exit "$failures"
