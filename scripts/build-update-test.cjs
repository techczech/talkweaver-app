'use strict'
// Builds the unpublished update-test flavour at one or more versions from the same source (ADR-0044):
//   node scripts/build-update-test.cjs 0.45.0-alpha.90 0.45.0-alpha.91
// → release-update-test/<version>/mac-arm64/TalkWeaver Update Test.app, each signed with this Mac's
// Developer ID identity, hardened runtime, not notarised. Only the version differs between them.
require('./security-test-credentials.cjs').assertNoNotaryCredentials()
const { spawnSync } = require('node:child_process')
const versions = process.argv.slice(2)
if (!versions.length || !versions.every((v) => /^\d+\.\d+\.\d+-alpha\.\d+$/.test(v))) {
  console.error('usage: node scripts/build-update-test.cjs <X.Y.Z-alpha.N> [<X.Y.Z-alpha.M> …]')
  process.exit(2)
}
const run = (args) => {
  const result = spawnSync('npx', args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
run(['--no-install', 'electron-vite', 'build', '--config', 'electron.vite.update-test.config.ts'])
for (const version of versions) {
  run(['--no-install', 'electron-builder', '--mac', '--dir', '--publish', 'never', '--config', 'build/electron-builder.update-test.cjs',
    '-c.mac.notarize=false', `-c.extraMetadata.version=${version}`, `-c.directories.output=release-update-test/${version}`])
}
