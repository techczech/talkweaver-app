import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const localPython = '.font-venv/bin/python'
const python = existsSync(localPython) ? resolve(localPython) : process.platform === 'win32' ? 'python' : 'python3'
function run(directory) {
  const result = spawnSync(python, ['scripts/test-slide-font-coverage.py'], {
    env: { ...process.env, ...(directory ? { TW_FONT_TEST_ROOT: directory } : {}) },
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  return result
}

const coverage = run()
process.stdout.write(coverage.stdout)
// The Python test uses 77 only when the fontTools package cannot be found.
if (coverage.status === 77 && coverage.stdout.startsWith('TEST NOT RUN: ')) process.exit(0)
assert.equal(coverage.status, 0, coverage.stderr)

const directory = mkdtempSync(resolve('.tw-font-coverage-'))
try {
  cpSync('compiler/assets/fonts', directory, { recursive: true })
  rmSync(join(directory, 'geist-latin-ext-wght-normal.woff2'))
  const mutation = run(directory)
  assert.equal(mutation.status, 1, mutation.stderr)
  assert.match(mutation.stderr, /FileNotFoundError[^\n]*geist-latin-ext-wght-normal\.woff2/)
  console.log('Coverage mutation: missing extended font fails as required')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
