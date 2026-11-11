#!/bin/bash
set -u
mkdir -p .tw-security-tmp evidence/security-hardening
export TMPDIR="$PWD/.tw-security-tmp"
trap 'rmdir .tw-security-scratch .tw-security-tmp 2>/dev/null || true' EXIT
failures=0
check() { "$@"; result=$?; echo "CHECK EXIT $result: $*"; if [ "$result" -ne 0 ]; then failures=$((failures+1)); fi; }
check node scripts/probe-packaged-security.cjs release/mac-arm64/TalkWeaver.app
check node scripts/probe-packaged-helpers.cjs release/mac-arm64/TalkWeaver.app
check env ELECTRON_RUN_AS_NODE=1 release/mac-arm64/TalkWeaver.app/Contents/MacOS/TalkWeaver --experimental-strip-types scripts/test-packaged-scratchpad.mjs
check node scripts/test-scratchpad-disk.mjs
check npm run smoke:packaged-wrangler
check node scripts/smoke-security-production.mjs release/mac-arm64/TalkWeaver.app
check npm run build:security-test
mkdir -p .tw-security-scratch
check node e2e/diagnose-insert-html-page-packaged.mjs "release-security-test/mac-arm64/TalkWeaver Security Test.app" .tw-security-scratch
check npm run test:unit
echo "QUALIFICATION: $failures failed checks"
exit "$failures"
