// Preset parity (ticket 02): the five older statement options — and {claim=…}, a deck claim_style: bar,
// {titletop}, {notitle}, {title=side} — compiled by a BASELINE compiler (e.g. preview.11, bbe9b8c) and by
// this tree's, rendered in the deck runtime at 1280x720, compared slide by slide: computed metrics
// and PNG bytes (the corner fullscreen control masked).
// Usage: git archive <ref> compiler | tar -x -C <dir>; ln -s "$PWD/node_modules" <dir>/node_modules
//        node scripts/diagnose-statement-preset-parity.mjs <dir>/compiler/scripts/lib <out-dir>
import { writeFileSync, statSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
const [oldLib, outDir] = process.argv.slice(2)
const newLib = new URL('../compiler/scripts/lib', import.meta.url).pathname
const TEXT = { short: 'Agents need a place to keep their work.', long: 'Most of what we call prompting is really just explaining the task properly: who it is for, what good looks like, what to leave out, and where to find the material. It is the same briefing you would give a colleague.' }
const PRESETS = { default: '{statement}', explicitdefault: '{statement=default}', centred: '{statement=centred}', tint: '{statement=tint}', bar: '{statement=bar}', full: '{statement=full}', poster: '{statement=poster}', claimbar: '{statement}{claim=bar}', claimplain: '{statement}{claim=plain}', both: '{statement}{statement=centred}' }
const lines = ['---', 'title: parity', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '', '## Statements', '{accent=cobalt}', '']
for (const [name, tok] of Object.entries(PRESETS)) for (const len of ['short', 'long']) for (const bg of ['', 'vermilion']) for (const size of ['', 'xl']) {
  const extra = `${bg ? `{bg=${bg}}` : ''}${size ? `{font-body=${size}}` : ''}`
  const tag = `${name}-${len}-${bg || 'none'}-${size || 'm'}`
  lines.push(`### ${TEXT[len]}`, `{id=u-${tag}}${tok}${extra}`, '')
  lines.push('### Where to start', `{id=t-${tag}}${tok}${extra}`, '', TEXT[len], '')
}
for (const [name, tok] of Object.entries(PRESETS)) {
  lines.push('### Where to start', `{id=tt-${name}}${tok}{titletop}`, '', TEXT.short, '')
  lines.push('### Where to start', `{id=nt-${name}}${tok}{notitle}`, '', TEXT.short, '')
  lines.push(`### ${TEXT.short}`, `{id=side-${name}}${tok}{title=side}`, '')
}
lines.push('### Next', '{id=after}', '', '- a', '')
const src = lines.join('\n')
const deckBar = src.replace('auto_thanks_slide: false', 'auto_thanks_slide: false\nclaim_style: bar')
mkdirSync(outDir, { recursive: true })
const compile = async (lib, source, name) => {
  const { prepareSource } = await import(lib + '/08-source-adapters.mjs?' + name)
  const p = join(outDir, `${name}-outline.md`); writeFileSync(p, source)
  const m = await prepareSource(p, source, name, statSync(p))
  const f = join(outDir, `${name}.html`); writeFileSync(f, String(m.fullHtml))
  return { file: f, warnings: m.warnings, html: String(m.fullHtml) }
}
const builds = {
  old: await compile(oldLib, src, 'old'), new: await compile(newLib, src, 'new'),
  oldBar: await compile(oldLib, deckBar, 'oldbar'), newBar: await compile(newLib, deckBar, 'newbar')
}
console.log('warnings old', builds.old.warnings, 'new', builds.new.warnings)
const ids = [...builds.old.html.matchAll(/<section class="slide[^"]*" data-id="([^"]+)"/g)].map((x) => x[1]).filter((x) => /^(u|t|tt|nt|side)-/.test(x))
const browser = await chromium.launch()
const read = async (file) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  await page.goto('file://' + file + '?audience=1'); await page.evaluate(() => document.fonts?.ready)
  const out = {}
  for (const id of ids) {
    await page.evaluate(() => { location.hash = 'after' }); await page.waitForFunction(() => document.querySelector('.stage > .slide.active')?.dataset.id === 'after')
    await page.evaluate((t) => { location.hash = t }, id)
    await page.waitForFunction((t) => { const s = document.querySelector('.stage > .slide.active'); return s?.dataset.id === t && s.querySelector(':scope > .slide-content')?.dataset.statementFit }, id, { timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(250)
    const png = await page.screenshot({ mask: [page.locator('#fullscreenBtn')], animations: 'disabled' })
    const m = await page.evaluate(() => {
      const slide = document.querySelector('.stage > .slide.active'); const content = slide.querySelector(':scope > .slide-content')
      const ss = getComputedStyle(slide)
      return { tl: slide.dataset.titleLayout, slideBg: ss.backgroundColor, slideImg: ss.backgroundImage, ps: [...content.querySelectorAll(':scope > p')].map((p) => { const cs = getComputedStyle(p); const b = p.getBoundingClientRect(); return [Math.round(b.left * 10), Math.round(b.top * 10), Math.round(b.width * 10), Math.round(b.height * 10), cs.fontSize, cs.backgroundColor, cs.borderLeftWidth, cs.borderTopWidth, cs.borderBottomWidth, cs.textAlign, cs.textWrap, cs.padding, p.innerHTML].join('|') }) }
    })
    out[id] = { m, png }
  }
  await page.close(); return out
}
let diffs = 0, same = 0
for (const [a, b] of [['old', 'new'], ['oldBar', 'newBar']]) {
  const A = await read(builds[a].file), B = await read(builds[b].file)
  for (const id of ids) {
    const mSame = JSON.stringify(A[id].m) === JSON.stringify(B[id].m)
    const pSame = Buffer.compare(A[id].png, B[id].png) === 0
    if (mSame && pSame) { same++; continue }
    diffs++
    console.log(`DIFF ${a}/${b} ${id}: metrics ${mSame ? 'same' : 'DIFFER'}, pixels ${pSame ? 'same' : 'DIFFER'}`)
    if (!mSame) console.log('  old', JSON.stringify(A[id].m).slice(0, 400), '\n  new', JSON.stringify(B[id].m).slice(0, 400))
    writeFileSync(join(outDir, `${a}-${id}.png`), A[id].png); writeFileSync(join(outDir, `${b}-${id}.png`), B[id].png)
  }
}
await browser.close()
console.log(`PARITY: ${same} slides identical (metrics + PNG bytes), ${diffs} differ, of ${ids.length * 2}`)
if (diffs) process.exit(1)
