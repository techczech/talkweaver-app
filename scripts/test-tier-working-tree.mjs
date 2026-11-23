import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'tw-tier-working-tree-'))
try {
  const repo = join(root, 'repo')
  const temp = join(root, 'temp')
  const scratchLog = join(root, 'child-temp.jsonl')
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  mkdirSync(temp)
  writeFileSync(join(temp, 'unrelated'), 'keep')
  copyFileSync(new URL('./run-tests.mjs', import.meta.url), join(repo, 'scripts', 'run-tests.mjs'))
  const put = (path, text) => writeFileSync(join(repo, path), text)
  put('package.json', JSON.stringify({
    name: 'working-tree-test',
    scripts: {
      test: 'npm run test:fixture && npm run test:release-fixture && npm run test:extended-fixture',
      'test:fixture': 'node fixture.mjs',
      'test:release-fixture': 'node fixture.mjs',
      'test:extended-fixture': 'node fixture.mjs',
      'build:gallery-native': 'node build-gallery.mjs'
    }
  }))
  put('scripts/test-tiers.json', JSON.stringify({
    unit: ['test:fixture'], dom: [], e2e: ['test:release-fixture', 'test:extended-fixture'],
    e2eRelease: ['test:release-fixture'],
    requiresNativeGallery: ['test:fixture']
  }))
  put('.gitignore', 'native/vault-gallery\n')
  put('build-gallery.mjs', `
    import { mkdirSync, writeFileSync } from 'node:fs'
    mkdirSync('native', { recursive: true })
    writeFileSync('native/vault-gallery', '', { mode: 0o755 })
    console.log('fixture built native Gallery')
  `)
  put('tracked.txt', 'original\n')
  put('fixture.mjs', `
    import { accessSync, appendFileSync, constants, mkdirSync, writeFileSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    if (process.platform === 'darwin' && process.env.npm_lifecycle_event === 'test:fixture') {
      accessSync('native/vault-gallery', constants.X_OK)
    }
    if (process.env.TW_FIXTURE_ACTION === 'write') {
      writeFileSync('tracked.txt', 'test edit\\n')
      writeFileSync('new file.txt', 'test output\\n')
    }
    if (['temp', 'fail', 'timeout'].includes(process.env.TW_FIXTURE_ACTION)) {
      appendFileSync(process.env.TW_FIXTURE_SCRATCH_LOG, JSON.stringify([tmpdir(), process.env.TMPDIR, process.env.TMP, process.env.TEMP]) + '\\n')
      mkdirSync(join(tmpdir(), 'tw-tier-leftover'))
      if (process.env.TW_FIXTURE_ACTION === 'fail') process.exitCode = 1
      if (process.env.TW_FIXTURE_ACTION === 'timeout') await new Promise(done => setTimeout(done, 7000))
    }
  `)
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  git('init', '-q')
  git('add', '.')
  git('-c', 'user.name=TalkWeaver Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture')
  const run = (action, ...flags) => spawnSync(process.execPath, ['scripts/run-tests.mjs', '--tier', 'unit', ...flags], {
    cwd: repo,
    env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp, TW_FIXTURE_ACTION: action, TW_FIXTURE_SCRATCH_LOG: scratchLog },
    encoding: 'utf8',
  })

  for (const uncomplicated of [run('none', '--check'), run('none', '--tier', 'e2e-release')]) {
    assert.equal(uncomplicated.status, 0, uncomplicated.stdout + uncomplicated.stderr)
    assert.doesNotMatch(uncomplicated.stdout, /fixture built native Gallery/)
  }
  const clean = run('none')
  assert.equal(clean.status, 0, clean.stdout + clean.stderr)
  if (process.platform === 'darwin') assert.match(clean.stdout, /fixture built native Gallery/)
  else assert.doesNotMatch(clean.stdout, /fixture built native Gallery/)
  for (const [action, code, flags] of [
    ['temp', 0, ['--jobs', '2', 'test:fixture']],
    ['fail', 1, []],
    ['timeout', 1, ['--timeout', '3']],
  ]) {
    writeFileSync(scratchLog, '')
    const result = run(action, ...flags)
    assert.equal(result.status, code, result.stdout + result.stderr)
    assert.doesNotMatch(result.stdout, /fixture built native Gallery/)
    if (action === 'timeout') assert.match(result.stdout, /killed after 3s timeout/)
    const paths = readFileSync(scratchLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(new Set(paths.map(([dir]) => dir)).size, action === 'temp' ? 2 : 1,
      'each invocation needs its own directory, including concurrent duplicate scripts')
    for (const [dir, ...variables] of paths) {
      assert.deepEqual(variables, [dir, dir, dir])
      assert.equal(join(dir, '..', '..'), realpathSync(temp))
    }
    assert.deepEqual(readdirSync(temp), ['unrelated'])
    assert.equal(readFileSync(join(temp, 'unrelated'), 'utf8'), 'keep')
  }

  // The porcelain status remains " M" for this user's dirty file even after the tier changes its bytes.
  put('tracked.txt', 'user edit\n')
  const dirty = run('write')
  assert.equal(dirty.status, 1, dirty.stdout + dirty.stderr)
  assert.match(dirty.stdout + dirty.stderr, /tracked\.txt/)
  assert.match(dirty.stdout + dirty.stderr, /new file\.txt/)

  rmSync(join(repo, 'new file.txt'))
  put('tracked.txt', 'user edit\n')
  const allowed = run('write', '--allow-dirty-tree')
  assert.equal(allowed.status, 0, allowed.stderr)
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log('Tier runner checks repository changes and removes per-script scratch on pass, failure and timeout')
