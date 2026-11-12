// Audit how a folder of real talks looks: compile every outline with an older compiler (the "before", e.g. a
// checkout of 0.43) and with this checkout (the "after", default look unless the talk names a palette), walk every
// slide through every reveal step in Chromium at 1600x900, and record per state:
//   clipped elements (as lib/ocean-clip-walk.mjs), text under AA against the colour painted behind it, text under
//   the 30px floor (sources, captions and footers: 24px), the empty share of the content band, elements drawn over
//   text, icons the author did not name (drawn icons minus `{icon=…}` tokens), and a screenshot of each slide.
// Then group by (trigger combination, title layout, body content kind) and write report.md, combos.json and a
// contact sheet per combination pairing before and after, worst first.
//
// Read-only on the talks. Everything goes to --out (keep it outside any committed folder: the talks' text and
// pictures must not enter the repository).
//
//   node scripts/audit-talks-look.mjs --talks <folder> --before <older checkout> [--after <checkout>] --out <dir> [--jobs 3]
//        [--match <regex on the outline path>] [--limit <n talks>] [--report-only] [--redo-after] [--no-sheets]
//
// Each talk's outputs are named by talkSlug (path tail plus a hash of the whole relative path). The report opens with
// every failed or missing measurement; the run exits 3 when the audit is incomplete and 2 when no outline is selected.
import { mkdirSync, readFileSync, writeFileSync, statSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve, basename } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
import { readabilityProbe, walkSlides } from './lib/slide-readability.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback }
const TALKS = resolve(arg('talks', ''))
const BEFORE = arg('before') ? resolve(arg('before')) : ''
// --after <checkout>: the compiler for the after side (default: this checkout). A frozen copy keeps a long run
// consistent while this checkout changes.
const AFTER = arg('after') ? resolve(arg('after')) : repo
const OUT = resolve(arg('out', join(repo, '.audit-local/talks')))
const JOBS = Number(arg('jobs', 3))
const MATCH = arg('match') ? new RegExp(arg('match')) : null
const LIMIT = Number(arg('limit', 0))
const REPORT_ONLY = process.argv.includes('--report-only')
// --redo-after: keep the recorded before side and walk the after side again (after a change on this branch)
const REDO_AFTER = process.argv.includes('--redo-after')
const SKIP_DIRS = new Set(['_SLIDE-VERSIONS', 'cache', 'z-old-powerpoint-imports', 'node_modules', '.git'])

/** A talk's identity in the output: the tail of its relative path, readable, plus a hash of the whole relative path,
 *  so two outlines whose paths share their last characters never share a deck, shot or record path. */
export function talkSlug(relPath) {
  const tail = relPath.replace(/-outline\.md$/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(-80)
  return `${tail}-${createHash('sha1').update(relPath).digest('hex').slice(0, 8)}`
}

function outlines(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) out.push(...outlines(join(dir, entry.name))) }
    else if (entry.name.endsWith('-outline.md')) out.push(join(dir, entry.name))
  }
  return out.sort()
}

/** The layout tokens a slide's source names on its trigger lines (ids, icons and notes left out). */
export function triggerCombination(source) {
  const tokens = []
  for (const line of String(source || '').split('\n').slice(1, 6)) {
    if (!/^\s*(\{[^}]*\}\s*)+$/.test(line)) continue
    for (const [, token] of line.matchAll(/\{([^}]*)\}/g)) {
      const t = token.trim()
      if (/^(id|icon|notes|note|time|duration|remind|tags?)\b/i.test(t)) continue
      tokens.push(`{${t.replace(/\s+model="[^"]*"/, '')}}`)
    }
  }
  return tokens.join('') || '(none)'
}

async function compile(root, outlinePath, slug) {
  const { prepareSource } = await import(pathToFileURL(join(root, 'compiler/scripts/lib/08-source-adapters.mjs')).href)
  let text = readFileSync(outlinePath, 'utf8')
  try {
    const { resolveImageRefs } = await import(pathToFileURL(join(repo, 'src/main/image-refs.ts')).href)
    text = resolveImageRefs(text, TALKS, outlinePath)
  } catch { /* pooled picture ids stay as written */ }
  const model = await prepareSource(outlinePath, text, slug, statSync(outlinePath), undefined, { allowedAssetRoots: [dirname(outlinePath), TALKS] })
  return model
}

// In-page: what is clipped, what is drawn over text, and what the body holds.
function stateProbe() {
  const slide = document.querySelector('.stage > .slide.active')
  const stage = slide.getBoundingClientRect()
  const tol = 1.5
  const visible = (e) => { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const keyOf = (e) => `${e.tagName.toLowerCase()}|${(e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48) || [...e.classList].slice(0, 2).join('.')}`
  const clips = []
  const textBoxes = []
  const painted = []
  for (const e of slide.querySelectorAll('*')) {
    if (e.closest('.notes, .sr-only, iframe, svg') && e.tagName.toLowerCase() !== 'svg') continue
    if (!visible(e)) continue
    const r = e.getBoundingClientRect()
    const cs = getComputedStyle(e)
    const outside = r.left < stage.left - tol || r.top < stage.top - tol || r.right > stage.right + tol || r.bottom > stage.bottom + tol
    const hides = (['hidden', 'clip'].includes(cs.overflowX) && e.scrollWidth > e.clientWidth + tol) || (['hidden', 'clip'].includes(cs.overflowY) && e.scrollHeight > e.clientHeight + tol)
    if (outside || hides) clips.push(keyOf(e))
    const ownText = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
    if (ownText) textBoxes.push([e, r])
    else if (!e.querySelector('*') || ['HR', 'IMG', 'svg'].includes(e.tagName)) {
      const fill = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderBottomWidth) > 0 || e.tagName === 'HR' || e.tagName === 'IMG'
      if (fill) painted.push([e, r])
    }
  }
  const overlaps = []
  for (const [t, tr] of textBoxes) {
    for (const [p, pr] of painted) {
      if (p.contains(t) || t.contains(p)) continue
      const ix = Math.min(tr.right, pr.right) - Math.max(tr.left, pr.left)
      const iy = Math.min(tr.bottom, pr.bottom) - Math.max(tr.top, pr.top)
      if (ix > 2 && iy > 2) { overlaps.push(`${keyOf(t)} × ${p.tagName.toLowerCase()}.${[...p.classList].slice(0, 2).join('.')}`); break }
    }
  }
  const content = slide.querySelector('.slide-content')
  const kinds = new Set()
  for (const child of content?.children || []) {
    if (child.matches('.slide-head, .notes, script, style')) continue
    if (child.matches('blockquote') || child.querySelector(':scope > blockquote')) kinds.add('quote')
    else if (child.matches('figure, img, picture, video, .image-grid, .media') || (child.querySelector('img, video') && !child.textContent.trim())) kinds.add('picture')
    else if (child.matches('ul, ol, .feature-list, .icon-row')) kinds.add('list')
    else if (child.matches('table, .table-wrap')) kinds.add('table')
    else if (child.matches('pre, .slide-code, .sim, .trace')) kinds.add('code')
    else if (child.querySelector('iframe') || child.matches('iframe, .embed, .live-page')) kinds.add('embed')
    else if (child.matches('p, .content-p')) kinds.add('text')
    else kinds.add(child.tagName.toLowerCase() === 'div' ? (child.className.split(' ')[0] || 'block') : child.tagName.toLowerCase())
  }
  const icons = slide.querySelectorAll('.fl-icon svg, .fl-icon img, .ir-icon svg, .ir-icon img, .vs-ico svg, .vs-head-ico svg, .card-icon svg').length
  const brand = slide.querySelectorAll('[data-brand]').length
  return { clips: clips.sort(), overlaps: overlaps.slice(0, 20), body: [...kinds].sort().join('+') || 'empty', icons, brand }
}

async function auditDeck(htmlPath, slides, shotsDir) {
  mkdirSync(shotsDir, { recursive: true })
  const states = []
  // Every state is shot; when a slide is left, only its first, middle and last states' shots are kept (a {focus}
  // slide's first state is all dimmed, so the sheets need the later ones too).
  let open = []
  const settle = () => {
    if (open.length > 3) {
      const keep = new Set([0, Math.floor((open.length - 1) / 2), open.length - 1])
      open.forEach((record, i) => { if (!keep.has(i)) { try { rmSync(join(shotsDir, record.shot)) } catch { /* already gone */ } delete record.shot } })
    }
    open = []
  }
  await walkSlides(htmlPath, async (page, state) => {
    let probe
    let read
    try {
      read = await page.evaluate(readabilityProbe, { floorPx: 30, smallFloorPx: 24 })
      probe = await page.evaluate(stateProbe)
    } catch (error) { states.push({ at: state.at, id: state.id, error: String(error).slice(0, 200) }); return }
    const meta = slides.get(state.id) || {}
    const authoredIcons = (String(meta.source || '').match(/\{icon=/g) || []).length
    const record = {
      at: state.at, id: state.id, step: state.step, index: state.index,
      combo: meta.combo || '(none)', layout: read.layout, titleLayout: read.titleLayout, mode: read.mode, body: probe.body,
      ground: read.ground,
      clips: probe.clips, contrast: read.contrast.filter((r) => !r.overImage), overImage: read.contrast.filter((r) => r.overImage).length,
      unresolved: read.unresolved || [],
      floor: read.floor, emptyShare: read.emptyShare, emptyBand: read.emptyBand, overlaps: probe.overlaps,
      autoIcons: Math.max(0, probe.icons - authoredIcons), brandIcons: probe.brand,
    }
    if (open.length && open[0].id !== state.id) settle()
    record.shot = `${String(state.index + 1).padStart(3, '0')}-${state.id.replace(/[^a-z0-9]+/gi, '-')}-s${state.step}.jpg`
    await page.screenshot({ path: join(shotsDir, record.shot), type: 'jpeg', quality: 70 })
    open.push(record)
    states.push(record)
  }, { settleMs: 120 })
  settle()
  return states
}

async function auditTalk(outlinePath) {
  const talk = relative(TALKS, outlinePath)
  const slug = talkSlug(talk)
  const recordPath = join(OUT, 'records', `${slug}.json`)
  let cached = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : null
  // a record made from another source (an older identity scheme, a moved talk) is never reused
  if (cached && (cached.talk !== talk || cached.slug !== slug)) cached = null
  // a side that failed is measured again
  if (cached && cached.sides?.before?.error) cached = null
  if (cached && !REDO_AFTER && !cached.sides?.after?.error) return cached
  const result = cached || { talk, slug, sides: {} }
  for (const [side, root] of [['before', BEFORE], ['after', AFTER]]) {
    if (!root || (cached && side === 'before')) continue
    try {
      const model = await compile(root, outlinePath, basename(slug))
      const html = join(OUT, 'decks', `${slug}-${side}.html`)
      mkdirSync(dirname(html), { recursive: true })
      writeFileSync(html, String(model.fullHtml))
      const slides = new Map((model.slides || []).map((s) => [s.id, { combo: triggerCombination(s.sourceMarkdown), source: String(s.sourceMarkdown || '') }]))
      result.sides[side] = { states: await auditDeck(html, slides, join(OUT, 'shots', slug, side)) }
    } catch (error) {
      result.sides[side] = { error: String(error?.stack || error).slice(0, 600), states: [] }
    }
  }
  mkdirSync(dirname(recordPath), { recursive: true })
  writeFileSync(recordPath, JSON.stringify(result))
  return result
}

// ---------------------------------------------------------------------------------------------------------------
const FAULTS = ['clipping', 'contrast', 'unresolved', 'floor', 'empty', 'overlap', 'autoIcons']
function faultsOf(state) {
  return {
    clipping: state.clips?.length ? 1 : 0,
    contrast: state.contrast?.length ? 1 : 0,
    unresolved: state.unresolved?.length ? 1 : 0,
    floor: state.floor?.length ? 1 : 0,
    // single-idea slides (title, divider, statement, quote) leave space around one idea by design
    empty: (state.emptyBand ?? state.emptyShare) > 0.35 && !['section-title', 'title', 'statement', 'quote', 'closing'].includes(state.layout) ? 1 : 0,
    overlap: state.overlaps?.length ? 1 : 0,
    autoIcons: state.autoIcons ? 1 : 0,
  }
}

async function contactSheets(combos) {
  const sheetDir = join(OUT, 'sheets')
  mkdirSync(sheetDir, { recursive: true })
  const browser = await chromium.launch({ headless: true })
  const broken = []
  try {
    const page = await browser.newPage({ viewport: { width: 1960, height: 1000 } })
    for (const [n, combo] of combos.entries()) {
      // a real file beside the shots, with relative image paths (a page set from about:blank cannot load file: images)
      const cell = (slug, side, name) => (name && existsSync(join(OUT, 'shots', slug, side, name))
        ? `<figure><img src="../shots/${encodeURIComponent(slug)}/${side}/${encodeURIComponent(name)}"><figcaption>${side} · ${name.replace(/^.*-s(\d+)\.jpg$/, 'step $1')}</figcaption></figure>`
        : '<figure><div class="none">not captured</div></figure>')
      const rows = combo.examples.slice(0, 5).map((ex) => {
        const pad = (list) => [...list, null, null, null].slice(0, 3)
        return `<div class="row"><div class="cap">${ex.slug.slice(-60)}<br>${ex.id} · ${ex.faults.join(', ') || 'no faults'}</div>${pad(ex.beforeShots).map((name) => cell(ex.slug, 'before', name)).join('')}<div class="gap"></div>${pad(ex.afterShots).map((name) => cell(ex.slug, 'after', name)).join('')}</div>`
      }).join('')
      const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;font:13px system-ui;background:#555;color:#fff}h1{font-size:17px;margin:8px}.row{display:flex;gap:6px;margin:8px;align-items:flex-start}.cap{width:150px;font-size:12px}figure{margin:0}img,.none{display:block;width:288px;height:162px;background:#222;object-fit:contain}figcaption{font-size:11px}.gap{width:14px}</style><h1>${n + 1}. ${combo.key.replace(/</g, '&lt;')} · ${combo.slides} slides · faults after: ${FAULTS.map((f) => `${f} ${combo.after[f]}`).join(', ')}</h1><div style="margin:0 8px 0 166px">0.43: first, middle, last state | now: first, middle, last state</div>${rows}`
      const file = join(sheetDir, `${String(n + 1).padStart(3, '0')}.html`)
      writeFileSync(file, html)
      await page.goto(pathToFileURL(file).href, { waitUntil: 'load' })
      const bad = await page.evaluate(async () => {
        const imgs = [...document.images]
        await Promise.all(imgs.map((img) => img.decode().catch(() => {})))
        return imgs.filter((img) => !img.naturalWidth).map((img) => img.getAttribute('src'))
      })
      if (bad.length) broken.push(`${file}: ${bad.slice(0, 3).join(', ')}`)
      await page.screenshot({ path: join(sheetDir, `${String(n + 1).padStart(3, '0')}.png`), fullPage: true })
    }
  } finally { await browser.close() }
  if (broken.length) throw new Error(`contact sheets have images that did not load:\n${broken.slice(0, 10).join('\n')}`)
}

/** What keeps the audit from being complete: talks with no record, sides that failed to compile or walk, states
 *  that failed to measure, and sides with no states at all. */
function incompleteness(records, missing) {
  const lines = missing.map((talk) => `no record: \`${talk}\``)
  for (const rec of records) {
    // a file named like an outline that compiles to no slides on either side is not a talk (listed apart)
    if (isNotATalk(rec)) continue
    for (const side of ['before', 'after']) {
      const s = rec.sides?.[side]
      if (!s) { lines.push(`\`${rec.talk}\` ${side}: not measured`); continue }
      if (s.error) { lines.push(`\`${rec.talk}\` ${side}: failed: ${s.error.split('\n')[0].slice(0, 160)}`); continue }
      if (!s.states.length) lines.push(`\`${rec.talk}\` ${side}: no slide states`)
      const failed = s.states.filter((st) => st.error)
      if (failed.length) lines.push(`\`${rec.talk}\` ${side}: ${failed.length} states failed to measure (first: ${failed[0].at}: ${failed[0].error.slice(0, 120)})`)
    }
  }
  return lines
}

function isNotATalk(rec) {
  return ['before', 'after'].every((side) => rec.sides?.[side] && !rec.sides[side].error && rec.sides[side].states.length === 0)
}

async function report(records, missing = []) {
  const combos = new Map()
  const totals = { before: Object.fromEntries(FAULTS.map((f) => [f, 0])), after: Object.fromEntries(FAULTS.map((f) => [f, 0])) }
  let slideCount = 0
  let stateCount = 0
  for (const rec of records) {
    for (const side of ['before', 'after']) {
      for (const st of rec.sides[side]?.states || []) {
        if (st.error) continue
        const f = faultsOf(st)
        for (const k of FAULTS) totals[side][k] += f[k]
        if (side === 'after') stateCount += 1
      }
    }
    const before = new Map((rec.sides.before?.states || []).map((s) => [s.at, s]))
    for (const st of rec.sides.after?.states || []) {
      if (st.error) continue
      const key = `${st.combo} · title ${st.titleLayout || '-'} · ${st.body}`
      if (!combos.has(key)) combos.set(key, { key, combo: st.combo, titleLayout: st.titleLayout, body: st.body, slides: 0, talks: new Set(), states: 0, after: Object.fromEntries(FAULTS.map((f) => [f, 0])), before: Object.fromEntries(FAULTS.map((f) => [f, 0])), examples: [] })
      const c = combos.get(key)
      c.states += 1
      c.talks.add(rec.slug)
      const fa = faultsOf(st)
      const fb = before.get(st.at) ? faultsOf(before.get(st.at)) : null
      for (const k of FAULTS) { c.after[k] += fa[k]; if (fb) c.before[k] += fb[k] }
      if (st.step === 0) {
        c.slides += 1
        slideCount += 1
        const shotsOf = (list) => list.filter((s) => s.id === st.id && s.shot).map((s) => s.shot)
        c.examples.push({ slug: rec.slug, id: st.id, afterShots: shotsOf(rec.sides.after?.states || []), beforeShots: shotsOf(rec.sides.before?.states || []), faults: FAULTS.filter((k) => fa[k]), weight: FAULTS.reduce((sum, k) => sum + fa[k], 0) })
      }
    }
  }
  for (const c of combos.values()) {
    c.examples.sort((a, b) => b.weight - a.weight)
    c.talks = c.talks.size
    c.faultStates = FAULTS.reduce((sum, k) => sum + c.after[k], 0)
  }
  const list = [...combos.values()].sort((a, b) => b.faultStates - a.faultStates || b.slides - a.slides)
  const byUse = [...combos.values()].sort((a, b) => b.slides - a.slides)
  writeFileSync(join(OUT, 'combos.json'), JSON.stringify({ totals, slideCount, stateCount, talks: records.length, combos: list }, null, 1))
  const incomplete = incompleteness(records, missing)
  const lines = ['# Look audit of real talks', '',
    ...(incomplete.length ? ['## INCOMPLETE: failed or missing measurements', '', ...incomplete.map((l) => `- ${l}`), ''] : ['Complete: every talk measured on both sides, every state measured.', '']),
    ...records.filter(isNotATalk).map((rec) => `Not a talk (no slides on either side), left out: \`${rec.talk}\``),
    `Talks: ${records.length - records.filter(isNotATalk).length}. Slides: ${slideCount}. Slide states (every reveal step): ${stateCount}.`,
    `Before: ${BEFORE || '(none)'}. After: ${AFTER}.`, '',
    '## Fault states, before and after', '', '| Fault | Before | After |', '|---|---|---|',
    ...FAULTS.map((k) => `| ${k} | ${totals.before[k]} | ${totals.after[k]} |`), '',
    '## Combinations by use (slides)', '', '| Combination | Title | Body | Slides | Talks | Fault states after (clip/contrast/unresolved/floor/empty/overlap/auto icons) | Example |', '|---|---|---|---|---|---|---|',
    ...byUse.map((c) => `| \`${c.combo}\` | ${c.titleLayout || '-'} | ${c.body} | ${c.slides} | ${c.talks} | ${FAULTS.map((k) => c.after[k]).join(' / ')} | ${c.examples[0]?.slug.slice(-40)} ${c.examples[0]?.id} |`), '',
    '## Worst first (contact sheets in sheets/, same order)', '',
    ...list.map((c, i) => `${i + 1}. \`${c.key}\`: ${c.faultStates} fault states over ${c.slides} slides (${FAULTS.filter((k) => c.after[k]).map((k) => `${k} ${c.after[k]}`).join(', ') || 'none'})`)]
  // Every state that fails a fault kind now and passed it before, per kind (the acceptance list)
  const newly = Object.fromEntries(FAULTS.map((k) => [k, []]))
  const newlyPassing = Object.fromEntries(FAULTS.map((k) => [k, 0]))
  for (const rec of records) {
    const before = new Map((rec.sides.before?.states || []).filter((st) => !st.error).map((st) => [st.at, st]))
    for (const st of rec.sides.after?.states || []) {
      if (st.error || !before.has(st.at)) continue
      const fa = faultsOf(st)
      const fb = faultsOf(before.get(st.at))
      for (const k of FAULTS) {
        if (fa[k] && !fb[k]) newly[k].push(`\`${rec.slug.slice(-40)}\` · ${st.id} · step ${st.step} · \`${st.combo.slice(0, 60)}\` · ${st.layout}${st.titleLayout ? ` (title ${st.titleLayout})` : ''}`)
        if (fb[k] && !fa[k]) newlyPassing[k] += 1
      }
    }
  }
  lines.push('', '## Newly failing against the before side, per fault kind', '',
    '| Fault | Newly failing | Newly passing |', '|---|---|---|', ...FAULTS.map((k) => `| ${k} | ${newly[k].length} | ${newlyPassing[k]} |`), '')
  for (const k of FAULTS) {
    if (!newly[k].length) continue
    lines.push(`### ${k} (${newly[k].length})`, '', ...newly[k].map((line) => `- ${line}`), '')
  }
  writeFileSync(join(OUT, 'report.md'), lines.join('\n') + '\n')
  return incomplete.length === 0
  if (!process.argv.includes('--no-sheets')) await contactSheets(list)
  if (incomplete.length) console.error(`audit INCOMPLETE (${incomplete.length}):\n${incomplete.slice(0, 20).join('\n')}`)
  console.log(`audit: ${records.length} talks, ${slideCount} slides, ${stateCount} states; after: ${FAULTS.map((k) => `${k} ${totals.after[k]}`).join(', ')}; before: ${FAULTS.map((k) => `${k} ${totals.before[k]}`).join(', ')}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!TALKS || !existsSync(TALKS)) { console.error('--talks <folder> is required'); process.exit(2) }
  let paths = outlines(TALKS)
  if (MATCH) paths = paths.filter((p) => MATCH.test(p))
  if (LIMIT) paths = paths.slice(0, LIMIT)
  if (!paths.length) { console.error(`no outlines (*-outline.md) selected under ${TALKS}`); process.exit(2) }
  mkdirSync(OUT, { recursive: true })
  const records = []
  const missing = []
  if (!REPORT_ONLY) {
    let next = 0
    await Promise.all(Array.from({ length: Math.max(1, JOBS) }, async () => {
      while (next < paths.length) {
        const path = paths[next++]
        const started = Date.now()
        const rec = await auditTalk(path)
        records.push(rec)
        console.log(`[${records.length}/${paths.length}] ${rec.slug} (${Math.round((Date.now() - started) / 1000)}s)${Object.entries(rec.sides).filter(([, s]) => s.error).map(([k]) => ` ${k} failed`).join('')}`)
      }
    }))
  } else {
    for (const path of paths) {
      const talk = relative(TALKS, path)
      const file = join(OUT, 'records', `${talkSlug(talk)}.json`)
      const rec = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
      if (rec && rec.talk === talk) records.push(rec)
      else missing.push(talk)
    }
  }
  const complete = await report(records, missing)
  if (!complete) process.exit(3)
}
