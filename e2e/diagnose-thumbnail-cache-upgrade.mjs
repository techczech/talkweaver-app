import assert from 'node:assert/strict'
import { createAppScratch, launchApp } from './lib/launch-app.mjs'
import { mkdirSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Upgrade profiles may contain hundreds of thousands of old thumbnail revisions.
// Opening one deck must not enumerate or copy unrelated decks into the new cache.
await using appScratch = createAppScratch()
const root = appScratch.root
const ud = join(root, 'userData'), vault = join(root, 'vault'), deck = join(vault, 'selected')
const prior = join(ud, 'thumb-cache-v8-prior', 'unrelated-deck')
mkdirSync(prior, { recursive: true }); mkdirSync(deck, { recursive: true })
const count = Number(process.env.TW_TEST_CACHE_ENTRIES || 500)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64')
for (let i = 0; i < count; i++) writeFileSync(join(prior, `${i}.png`), png)
const source = `---
outline_version: 2
title: Selected deck
auto_title_slide: false
auto_thanks_slide: false
---

### Opening
{id=opening}

Ready.
`
const outlinePath = join(deck, 'selected-outline.md')
writeFileSync(outlinePath, source)
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }))
const executablePath = process.env.TW_TEST_APP_EXECUTABLE
const app = (await launchApp({
  scratch: appScratch,
  userData: ud,
  executablePath,
  env: { ...process.env, TW_REC_TEST: '1' },
})).app
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const first = await page.evaluate(async ({outlinePath,source}) => {
    const started = performance.now()
    const thumbs = await window.tw.talk.thumbnails(outlinePath, source)
    return { elapsedMs: performance.now() - started, thumbs }
  }, {outlinePath,source})
  assert.ok(Object.keys(first.thumbs).length > 0, 'selected deck receives usable thumbnails')
  const newRoots = readdirSync(ud).filter(name => name.startsWith('thumb-cache-v8-') && name !== 'thumb-cache-v8-prior')
  const copied = newRoots.flatMap(name => {
    const dir = join(ud, name, 'unrelated-deck')
    return existsSync(dir) ? readdirSync(dir) : []
  })
  assert.equal(copied.length, 0, 'opening a deck must not copy unrelated prior-cache files')
  assert.equal(readdirSync(prior).length, count, 'old cache remains untouched')
  // Talk thumbnails live per vault: <namespace>/@vaults/<vault id>/<slug> (thumb-cache-dirs.ts).
  const talkDirs = newRoots.flatMap(name => { const v = join(ud,name,'@vaults'); return existsSync(v) ? readdirSync(v).map(id => join(v,id,'selected')) : [] })
  const files = talkDirs.flatMap(dir => existsSync(dir) ? readdirSync(dir).filter(f=>f.endsWith('.png')).map(f=>join(dir,f)) : [])
  const before = files.map(f=>statSync(f,{bigint:true}).mtimeNs)
  const second = await page.evaluate(async ({outlinePath,source}) => window.tw.talk.thumbnails(outlinePath, source), {outlinePath,source})
  assert.deepEqual(second, first.thumbs, 'same-version thumbnails remain reusable')
  assert.deepEqual(files.map(f=>statSync(f,{bigint:true}).mtimeNs), before, 'cache hits do not rewrite PNGs')
  const windows = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().map(w => ({visible:w.isVisible(),alive:!w.isDestroyed()})))
  assert.ok(windows.every(w => !w.visible && w.alive))
  console.log('PASS cache upgrade: no unrelated migration, current thumbnails reused, old cache preserved', { count, elapsedMs:first.elapsedMs })
} finally {
  await appScratch.closeApp(app)
}
