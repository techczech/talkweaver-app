#!/bin/bash
set -u
mkdir -p .tw-security-tmp evidence/security-hardening
export TMPDIR="$PWD/.tw-security-tmp"
trap 'rmdir .tw-security-tmp 2>/dev/null || true' EXIT
failures=0
check() { "$@"; result=$?; echo "CHECK EXIT $result: $*"; if [ "$result" -ne 0 ]; then failures=$((failures+1)); fi; }
check node scripts/smoke-security-production.mjs release/mac-arm64/TalkWeaver.app
check node scripts/probe-security-test-flavour.mjs "release-security-test/mac-arm64/TalkWeaver Security Test.app"
check node scripts/verify-mac-package.mjs --require-signed release/mac-arm64/TalkWeaver.app
node scripts/verify-electron-security.cjs "release-security-test/mac-arm64/TalkWeaver Security Test.app"
result=$?
if [ "$result" -eq 1 ]; then echo 'PASS production gate rejects unpublished inspector-enabled flavour'; else echo "FAIL test flavour gate exit $result"; failures=$((failures+1)); fi
check npm run test:electron-security
check npm run test:ffmpeg-source-bundle
echo "RECHECK: $failures failed checks"
exit "$failures"
