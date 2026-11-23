// Compare generated outputs with hashes recorded from the previous main-process route.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url))
const reference = new URL('./fixtures/build-artifacts.json', import.meta.url)
const record = process.argv.includes('--record')
await ensureFreshBuild(repo)
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'tw-build-artifacts-')))
let app
try {
  const userData = join(scratch, 'userData')
  const vault = join(scratch, 'vault')
  await mkdir(userData)
  await cp(join(repo, 'resources/example-vault'), vault, { recursive: true })
  await writeFile(join(userData, 'config.json'), JSON.stringify({
    vaultRoot: vault,
    timerWarnAtMinutes: 7,
    timerUrgentAtMinutes: 2
  }))
  app = await electron.launch({
    args: ['.', '--use-mock-keychain', `--user-data-dir=${userData}`],
    cwd: repo,
    env: { ...process.env, TW_E2E: '1', HOME: scratch, CFFIXED_USER_HOME: scratch, TW_E2E_HOME: scratch }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(w => w.isVisible())), false)

  const hashes = {}
  for (const folder of (await readdir(vault, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!folder.isDirectory() || folder.name.startsWith('_') || folder.name.startsWith('.')) continue
    const path = join(vault, folder.name, `${folder.name}-outline.md`)
    const text = await readFile(path, 'utf8')
    const replies = await page.evaluate(async ([path, text]) => {
      const { build, buildVariants, exportHandout } = window.tw.talk
      return [await build(path, text), await buildVariants(path, text), await exportHandout(path, text)]
    }, [path, text])
    for (const reply of replies) assert.equal(reply.success, true, reply.error)
    const [single, variants, handout] = replies
    assert.deepEqual(variants.outPaths.map(path => basename(path)), [
      `${folder.name}-full.html`, `${folder.name}-share-notes.html`, `${folder.name}-share-no-notes.html`,
      `${folder.name}-projections.jsonl`
    ])
    for (const file of [single.outPath, ...variants.outPaths, handout.path]) {
      const bytes = await readFile(file)
      assert.ok(bytes.length > 0)
      hashes[basename(file)] = createHash('sha256').update(bytes).digest('hex')
    }
  }
  if (record) {
    console.log(JSON.stringify(hashes, null, 2))
  } else {
    const { sha256 } = JSON.parse(await readFile(reference, 'utf8'))
    assert.deepEqual(hashes, sha256)
    console.log(`PASS: ${Object.keys(hashes).length} generated files match the main-process build and export bytes`)
  }
} finally {
  try {
    await app?.close()
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
