'use strict'
require('./security-test-credentials.cjs').assertNoNotaryCredentials()
const { spawnSync } = require('node:child_process')
for (const args of [ ['--no-install', 'electron-vite', 'build', '--config', 'electron.vite.security-test.config.ts'], ['--no-install', 'electron-builder', '--mac', '--dir', '--publish', 'never', '--config', 'build/electron-builder.security-test.cjs', '-c.mac.notarize=false'] ]) {
  const result = spawnSync('npx', args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
