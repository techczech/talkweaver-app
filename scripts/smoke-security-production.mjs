// Negative startup checks only. Never attach a debugger to production or touch an installed app.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
const bundle = resolve(process.argv[2])
const root = mkdtempSync(join(resolve('.'), '.tw-security-runtime-'))
try {
  const injected = join(root, 'injected'), preload = join(root, 'preload.cjs')
  writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(injected)}, 'injected')`)
  const env = { ...process.env, TW_E2E: '1', NODE_OPTIONS: `--require ${preload}` }
  delete env.ELECTRON_RUN_AS_NODE
  const exe = join(bundle, 'Contents/MacOS/TalkWeaver')
  const base = [`--user-data-dir=${join(root, 'profile')}`, '--use-mock-keychain']
  // This CLI opens no windows and reads only the synthetic profile.
  const clean = spawnSync(exe, ['settings', 'list', ...base], { env, encoding: 'utf8', timeout: 30000 })
  assert.equal(clean.status, 0, clean.stderr)
  assert.equal(existsSync(injected), false, 'NODE_OPTIONS preload must not run')
  console.log('PASS production NODE_OPTIONS ignored; settings CLI exits normally')
  for (const flag of ['--inspect=0', '--inspect-brk=0', '--inspect-port=0', '--remote-debugging-port=0', '--remote-debugging-pipe']) {
    const result = spawnSync(exe, [...base, flag], { env, encoding: 'utf8', timeout: 15000 })
    assert.equal(result.status, 1, `${flag}: ${result.stderr}`)
    assert.match(result.stderr, /TalkWeaver refuses debugging switches in production/)
    assert.doesNotMatch(result.stderr, /Debugger listening|DevTools listening/)
    assert.equal(existsSync(injected), false)
    console.log(`PASS production refuses ${flag} immediately`)
  }
} finally { rmSync(root, { recursive: true, force: true }) }
