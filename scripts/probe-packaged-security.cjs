'use strict'
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync, writeFileSync, existsSync } = require('node:fs')
const { join, resolve } = require('node:path')
const app = resolve(process.argv[2])
const exe = join(app, 'Contents/MacOS/TalkWeaver')
// All files stay in this repository, and are removed even on failure.
const scratch = mkdtempSync(join(__dirname, '../.tw-security-probe-'))
try {
  const marker = join(scratch, 'injected')
  const preload = join(scratch, 'preload.cjs')
  writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'injected')`)
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: `--require ${preload}` }
  const result = spawnSync(exe, ['--inspect=0', '-e', 'console.log("RUN_AS_NODE_REMAINS"); console.log("INSPECTOR="+require("node:inspector").url())'], { env, encoding: 'utf8', timeout: 15000 })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /RUN_AS_NODE_REMAINS/)
  assert.equal(existsSync(marker), false, 'NODE_OPTIONS preload must never run')
  console.log('PASS NODE_OPTIONS preload ignored in run-as-node mode')
  assert.match(result.stderr, /Debugger listening/)
  assert.doesNotMatch(result.stdout, /INSPECTOR=undefined/)
  assert.equal(existsSync(marker), false, 'NODE_OPTIONS preload must never run')
  console.log('PASS NODE_OPTIONS ignored; CONFIRMED OPEN: RunAsNode executes -e and --inspect opens an inspector')
} finally { rmSync(scratch, { recursive: true, force: true }) }
