#!/bin/bash
# Own builds only; every app window in the fixture harness is hidden.
set -eu
mkdir -p .tw-security-tmp evidence/security-hardening
export TMPDIR="$PWD/.tw-security-tmp"
trap 'rmdir .tw-security-scratch .tw-security-tmp 2>/dev/null || true' EXIT
npm run test:electron-security
npm run typecheck
npm run build:native
npm run build
npx electron-builder --mac --dir --publish never -c.mac.notarize=false
node scripts/verify-electron-security.cjs release/mac-arm64/TalkWeaver.app
/usr/bin/codesign -d --entitlements :- release/mac-arm64/TalkWeaver.app > evidence/security-hardening/after-entitlements.plist 2> evidence/security-hardening/after-signature.log
npx --no-install @electron/fuses read --app release/mac-arm64/TalkWeaver.app
node scripts/verify-mac-package.mjs --require-signed release/mac-arm64/TalkWeaver.app
node scripts/probe-packaged-security.cjs release/mac-arm64/TalkWeaver.app
node scripts/probe-packaged-helpers.cjs release/mac-arm64/TalkWeaver.app
ELECTRON_RUN_AS_NODE=1 release/mac-arm64/TalkWeaver.app/Contents/MacOS/TalkWeaver --experimental-strip-types scripts/test-packaged-scratchpad.mjs
node scripts/test-scratchpad-disk.mjs
npm run smoke:packaged-wrangler
node scripts/smoke-security-production.mjs release/mac-arm64/TalkWeaver.app
npm run build:security-test
mkdir -p .tw-security-scratch
node e2e/diagnose-insert-html-page-packaged.mjs "release-security-test/mac-arm64/TalkWeaver Security Test.app" .tw-security-scratch

npm run test:unit
