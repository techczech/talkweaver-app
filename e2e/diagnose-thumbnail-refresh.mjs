// Real-Electron harness for the thumbnail cache-busting fix.
// Bug: the thumbnail cache was keyed on content_hash, which ignores the layout/trigger — so
// changing {list}→{cards} or adding {numbered} kept the SAME key → stale preview. Fix: key on
// render_hash (layout + block model). This verifies render_hash changes on a trigger change while
// content_hash stays stable, AND that the live thumbnail map re-keys.
// Run after `npm run build`.
import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-thr-' + String(Date.now()) + '-'))
const vault = join(tempRoot, 'vault')
const ud = join(tempRoot, 'userData')
const td = join(vault, 'thr')
mkdirSync(td, { recursive: true }); mkdirSync(ud, { recursive: true })
const outlinePath = join(td, 'thr-outline.md')
writeFileSync(outlinePath, '---\ntitle: T\n---\n\n## S\n\n### Why agents?\n{list}\n\n- car\n- horse\n- boat\n')
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))

const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

const mk = (trig) => `---\ntitle: T\n---\n\n## S\n\n### Why agents?\n${trig}\n\n- car\n- horse\n- boat\n`
async function rowFor(content) {
  return page.evaluate(async ({ p, c }) => {
    const rows = await window.tw.talk.compile(p, c)
    if (!rows) return null
    const r = rows.find((x) => /Why agents/.test(x.title || '')) || null
    return r ? { layout: r.layout, content_hash: r.content_hash, render_hash: r.render_hash } : null
  }, { p: outlinePath, c: content })
}

try {
  const list = await rowFor(mk('{list}'))
  const cards = await rowFor(mk('{cards}'))
  const numbered = await rowFor(mk('{numbered}'))

  record('compile exposes render_hash on rows', !!(list && list.render_hash), `render_hash=${list && list.render_hash ? list.render_hash.slice(0, 14) : 'MISSING'}`)
  record('content_hash is stable across a trigger change (Library identity)', !!(list && cards && list.content_hash === cards.content_hash), `list=${list && (list.content_hash||'').slice(7,15)} cards=${cards && (cards.content_hash||'').slice(7,15)}`)
  record('render_hash CHANGES {list}→{cards} (busts thumbnail cache)', !!(list && cards && list.render_hash !== cards.render_hash), `list=${list && (list.render_hash||'').slice(7,15)} cards=${cards && (cards.render_hash||'').slice(7,15)}`)
  record('render_hash CHANGES {list}→{numbered} (same layout, different render)', !!(list && numbered && list.render_hash !== numbered.render_hash), `list=${list && (list.render_hash||'').slice(7,15)} numbered=${numbered && (numbered.render_hash||'').slice(7,15)}`)

  // The live thumbnail map must re-key when the trigger changes (keys ARE render_hashes).
  const keysList = await page.evaluate(async ({ p, c }) => Object.keys((await window.tw.talk.thumbnails(p, c)) || {}), { p: outlinePath, c: mk('{list}') })
  const keysCards = await page.evaluate(async ({ p, c }) => Object.keys((await window.tw.talk.thumbnails(p, c)) || {}), { p: outlinePath, c: mk('{cards}') })
  const changed = keysList.length > 0 && keysCards.length > 0 && keysList.join(',') !== keysCards.join(',')
  record('thumbnail map re-keys on trigger change (no stale hit)', changed, `listKeys=${keysList.length} cardsKeys=${keysCards.length} differ=${changed}`)
} catch (e) {
  record('thumbnail-refresh harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== THUMBNAIL-REFRESH SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
