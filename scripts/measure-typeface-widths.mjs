// How much wider or narrower each bundled slide face sets its lines than Trebuchet MS, the face the Ocean look used
// in 0.44.0. Each outline is compiled twice with this checkout: once with `font: trebuchet` (the reference) and once
// with the face under test. Every slide is shown in both; for every visible element with text of its own, the natural
// one-line width of that text in the element's own computed style (family, weight, size, tracking, case, features) is
// measured and divided by its font size, so fitted sizes do not enter the ratio. Elements are paired by their path in
// the slide. Ratios are reported per role (display: headings and titles; numbers: numeric runs; text: the rest),
// weighted by characters, with the widest element.
//
//   node scripts/measure-typeface-widths.mjs [--faces inter,serif,geist] [--json out.json] [outline ...]
//
// Defaults: the layout sampler and the neutral fixtures in scripts/fixtures/ocean-look/. Read-only; writes only --json.
import { readFileSync, writeFileSync, statSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const argv = process.argv.slice(2)
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv.splice(i, 2)[1] : fallback }
const faces = opt('faces', 'inter,serif,geist').split(',')
const jsonOut = opt('json', '')
const outlines = argv.length ? argv : ['docs/layout-sampler-outline.md', ...['ten-kinds', 'edge-cases', 'review-cases', 'talk-combinations', 'statement-combinations'].map((n) => `scripts/fixtures/ocean-look/${n}-outline.md`)]
const HARD_TIMEOUT_MS = Number(opt('timeout-ms', 600000))
const timer = setTimeout(() => { console.error(`measure-typeface-widths: timed out after ${HARD_TIMEOUT_MS} ms`); process.exit(124) }, HARD_TIMEOUT_MS)

export function withFace(text, face) {
  const line = `font: ${face}\n`
  if (!/^---\r?\n/.test(text)) return `---\n${line}---\n${text}`
  return text.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (_, fm) => `---\n${line}${fm.replace(/^(?:font|typeface):.*(?:\r?\n|$)/gm, '')}\n---`)
}

// In-page: every visible element with text of its own on the active slide, measured as one unbroken line.
function measureActive() {
  const slide = document.querySelector('.stage > .slide.active')
  if (!slide) return []
  const probe = document.createElement('span')
  probe.style.cssText = 'position:absolute;left:-99999px;top:0;white-space:pre;visibility:hidden;'
  document.body.appendChild(probe)
  const pathOf = (e) => { const p = []; while (e && e !== slide) { p.push([...e.parentElement.children].indexOf(e)); e = e.parentElement } return p.reverse().join('/') }
  const out = []
  for (const el of slide.querySelectorAll('.slide-content *')) {
    if (el.closest('.notes, .sr-only, .qf-sr, svg, iframe, script, style, pre, code, .sim')) continue
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').replace(/\s+/g, ' ').trim()
    if (own.length < 3) continue
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    const size = parseFloat(cs.fontSize)
    if (!(size > 0)) continue
    for (const prop of ['fontFamily', 'fontWeight', 'fontStyle', 'fontSize', 'letterSpacing', 'wordSpacing', 'textTransform', 'fontFeatureSettings', 'fontVariantNumeric', 'fontStretch', 'fontSizeAdjust']) probe.style[prop] = cs[prop]
    probe.textContent = own
    const role = el.closest('h1, h2, h3, .slide-title, .tp-title, .tp-subtitle') ? 'display' : (/\d/.test(own) && /^[\s\d.,:;%+\-–—/×x$€£()#]+$/.test(own) ? 'numbers' : 'text')
    out.push({ path: pathOf(el), chars: own.length, em: probe.getBoundingClientRect().width / size, role, size })
  }
  probe.remove()
  return out
}

async function compileTo(dir, outline, face) {
  const path = resolve(outline)
  const text = withFace(readFileSync(path, 'utf8'), face)
  const model = await prepareSource(path, text, `widths-${face}`, statSync(path), undefined, { allowedAssetRoots: [dirname(path), resolve('docs'), resolve('e2e/fixtures'), resolve('scripts/fixtures')] })
  const file = join(dir, `${face}-${outline.replace(/[^a-z0-9]+/gi, '-')}.html`)
  writeFileSync(file, String(model.fullHtml))
  return file
}

async function slidesOf(page, file) {
  await page.goto(pathToFileURL(file).href, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  return page.locator('.stage > .slide').evaluateAll((slides) => slides.map((s) => s.dataset.id).filter(Boolean))
}

async function show(page, id) {
  await page.evaluate((target) => { location.hash = target }, id)
  await page.waitForFunction((target) => document.querySelector('.stage > .slide.active')?.dataset.id === target, id, { timeout: 5000 }).catch(() => {})
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(60)
}

export function summarise(pairs) {
  const roles = {}
  for (const p of pairs) {
    const r = (roles[p.role] ??= { chars: 0, face: 0, ref: 0, worst: null, elements: 0 })
    r.chars += p.chars; r.face += p.face; r.ref += p.ref; r.elements += 1
    const ratio = p.face / p.ref
    if (p.chars >= 8 && (!r.worst || ratio > r.worst.ratio)) r.worst = { ratio: +ratio.toFixed(4), where: p.where }
  }
  const all = pairs.reduce((a, p) => ({ face: a.face + p.face, ref: a.ref + p.ref, chars: a.chars + p.chars }), { face: 0, ref: 0, chars: 0 })
  // Text set at 40px and above (statement, carousel and large list lines): the size band where a face's tracking,
  // inherited as a fixed length, or a layout's own letter-spacing would leave the face uncompensated.
  const large = pairs.filter((p) => p.role === 'text' && p.size >= 40).reduce((a, p) => ({ face: a.face + p.face, ref: a.ref + p.ref, chars: a.chars + p.chars }), { face: 0, ref: 0, chars: 0 })
  return {
    all: { ratio: +(all.face / all.ref).toFixed(4), chars: all.chars },
    textLarge: { ratio: large.ref ? +(large.face / large.ref).toFixed(4) : null, chars: large.chars },
    ...Object.fromEntries(Object.entries(roles).map(([k, r]) => [k, { ratio: +(r.face / r.ref).toFixed(4), worst: r.worst, elements: r.elements, chars: r.chars,
      // the uniform tracking (em) that would make this role's total width equal to the reference's
      trackingToMatch: +(-(r.face - r.ref) / r.chars).toFixed(4) }])),
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'tw-widths-'))
const browser = await chromium.launch({ headless: true })
const result = {}
try {
  const ref = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' })
  const cur = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' })
  const refByOutline = {}
  for (const outline of outlines) {
    const refFile = await compileTo(scratch, outline, 'trebuchet')
    const ids = await slidesOf(ref, refFile)
    const measured = {}
    for (const id of ids) { await show(ref, id); measured[id] = await ref.evaluate(measureActive) }
    refByOutline[outline] = measured
  }
  for (const face of faces) {
    const pairs = []
    for (const outline of outlines) {
      const file = await compileTo(scratch, outline, face)
      const ids = await slidesOf(cur, file)
      for (const id of ids) {
        const base = refByOutline[outline][id]
        if (!base) continue
        await show(cur, id)
        const byPath = new Map(base.map((m) => [m.path, m]))
        for (const m of await cur.evaluate(measureActive)) {
          const b = byPath.get(m.path)
          if (!b || b.chars !== m.chars || !(b.em > 0)) continue
          pairs.push({ role: m.role, chars: m.chars, face: m.em, ref: b.em, size: m.size, where: `${outline.split('/').pop()}#${id}:${m.path}` })
        }
      }
    }
    result[face] = summarise(pairs)
    console.log(face, JSON.stringify(result[face]))
  }
} finally {
  await browser.close()
  rmSync(scratch, { recursive: true, force: true })
  clearTimeout(timer)
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ outlines, result }, null, 2))
