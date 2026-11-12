#!/bin/sh
# Local directory packages only. Never a release archive, installation or publication.
set -eu
npm run build:native
npm run build
node scripts/precise-word-timing/smoke-utility.mjs en
node scripts/precise-word-timing/smoke-utility.mjs cs
npx --no-install electron-builder --mac --dir --publish never -c.mac.notarize=false -c.directories.output=.tw-alignment-package
node scripts/precise-word-timing/verify-package-content.mjs .tw-alignment-package/mac-arm64/TalkWeaver.app
node scripts/precise-word-timing/record-package-evidence.mjs .tw-alignment-package/mac-arm64/TalkWeaver.app
node scripts/smoke-security-production.mjs .tw-alignment-package/mac-arm64/TalkWeaver.app
npm run build:security-test
TW_ALIGNMENT_TEST_EXECUTABLE="$PWD/release-security-test/mac-arm64/TalkWeaver Security Test.app/Contents/MacOS/TalkWeaver Security Test" node e2e/diagnose-precise-word-timing.mjs
