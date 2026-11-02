// Real Settings CLI output over a deliberately backpressured pipe; fresh synthetic profile only.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyState } from '@app-patterns/settings'
import { schema } from '../src/shared/settings-schema.ts'
import { runTalkWeaverSettings } from '../src/main/settings-cli.ts'
const require = createRequire(import.meta.url)
const dir = mkdtempSync(join(tmpdir(), 'tw-settings-cli-output-'))
try {
  const state = emptyState(schema.app)
  const value = (i) => `https://fixture.example/${'x'.repeat(1000)}/${i}`
  state.settings['publishing.customDomain'] = value(299)
  state.changes = Array.from({ length: 300 }, (_, n) => {
    const i = 299 - n
    return { id: `fixture-change-${i}`, at: 1700000000000 + i, key: 'publishing.customDomain', from: value(i - 1), to: value(i), who: { kind: 'agent', name: 'pipe-test' } }
  })
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(state))
  const args = ['changes', '--json', '--limit', '300']
  let expected = ''
  const code = await runTalkWeaverSettings(args, { dir, version: '0.41.0', io: { stdout: (s) => { expected += s }, stderr: (s) => assert.fail(s) } })
  assert.equal(code, 0, expected)
  assert.equal(JSON.parse(expected).changes.length, 300, 'fixture survives the real Settings loader')
  assert.ok(Buffer.byteLength(expected) > 500_000, 'fixture exceeds pipe and stream buffers')
  const env = { ...process.env, TW_E2E: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), ['.', 'settings', ...args, `--user-data-dir=${dir}`], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
  const stdout = [], stderr = []
  // Hold the read end until the CLI has queued its large response and attempted to exit.
  child.stdout.pause()
  const resume = setTimeout(() => child.stdout.resume(), 1000)
  const deadline = setTimeout(() => child.kill('SIGKILL'), 20_000)
  child.stdout.on('data', (s) => stdout.push(s))
  child.stderr.on('data', (s) => stderr.push(s))
  try {
    const result = await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (exitCode, signal) => resolve({ exitCode, signal }))
    })
    assert.equal(result.exitCode, 0, Buffer.concat(stderr).toString())
    const actual = Buffer.concat(stdout)
    assert.equal(actual.length, Buffer.byteLength(expected), 'piped CLI response must arrive in full before exit')
    assert.equal(actual.toString(), expected, 'all 300 entries and the final JSON newline arrive byte for byte')
    console.log(`PASS Settings CLI pipe: ${actual.length} bytes, all 300 changes and final newline received, exit 0`)
  } finally { clearTimeout(resume); clearTimeout(deadline) }
} finally { rmSync(dir, { recursive: true, force: true }) }
