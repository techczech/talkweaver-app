// Audit how a folder of real talks looks: compile every outline with an older compiler (the "before", e.g. a
// checkout of 0.43) and with this checkout (the "after", default look unless the talk names a palette), walk every
// slide through every reveal step in Chromium at 1600x900, and record per state:
//   clipped elements (as lib/ocean-clip-walk.mjs), text under AA against the colour painted behind it, text under
//   the 30px floor (sources, captions and footers: 24px), the empty share of the content band, elements drawn over
//   text, icons the author did not name (drawn icons minus `{icon=…}` tokens), and a screenshot of each slide.
// Then compare the two sides state by state and run by run (lib/audit-compare.mjs: newly failing, worsened, unmatched,
// improved, unchanged, and carousel cards Next never shows), group by (trigger combination, title layout, body content
// kind) and write report.md, comparison.json, combos.json and contact sheets: one per combination pairing before and
// after (first, middle and last state), worst first, and changes-*.png pairing the before and after shot of every
// newly failing, worsened or unmatched state.
//
// Read-only on the talks. Everything goes to --out (keep it outside any committed folder: the talks' text and
// pictures must not enter the repository).
//
//   node scripts/audit-talks-look.mjs --talks <folder> --before <older checkout> [--after <checkout>] --out <dir> [--jobs 3]
//        [--max-steps-per-slide 1000] [--max-presses 4000] [--typing-timeout-ms 30000]
//        [--match <regex on the outline path>] [--limit <n talks>] [--report-only] [--redo-after] [--no-sheets]
//
// Contact sheets are made by default. --no-sheets skips them: it saves one more Chromium pass over every sheet (a few
// minutes on a large library); the measurements, report and comparison are the same. A sheet whose pictures fail to
// load is reported in report.md and on stderr; it never stops the audit or changes its exit code.
//
// Each talk's outputs are named by talkSlug (path tail plus a hash of the whole relative path). The report opens with
// every failed or missing measurement; the run exits 3 when the audit is incomplete (a tool limit: a cap, a forced
// escape, a typing timeout, a missed step or beat, a failed measurement) and 2 when no outline is selected. A carousel
// card Next never shows is a fault of the deck, compared as its own class, not a tool limit; its directly shown states
// are diagnostics outside the gate.
//
// Limits of the comparison: clipping and overlap are compared by presence and key, so worse geometry of an element that
// already fails (it clips further) is not quantified; and changes below the tolerances (contrast 0.1:1, type 0.5px,
// empty band 5 points) can add up over several releases without being reported.
import { mkdirSync, readFileSync, writeFileSync, statSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, basename } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
import { readabilityProbe, walkSlides } from './lib/slide-readability.mjs'
import { FAULTS, faultsOf, compareTalk, gateOf, CONTRAST_TOLERANCE, FLOOR_TOLERANCE_PX, EMPTY_TOLERANCE } from './lib/audit-compare.mjs'

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
  return { id: slide.dataset.id, clips: clips.sort(), overlaps: overlaps.slice(0, 20), body: [...kinds].sort().join('+') || 'empty', icons, brand }
}

async function auditDeck(htmlPath, slides, shotsDir) {
  mkdirSync(shotsDir, { recursive: true })
  const states = []
  // Every state is shot and kept: the change sheets pair the before and after shot of any state that changed.
  const coverage = await walkSlides(htmlPath, async (page, state) => {
    let probe
    let read
    try {
      read = await page.evaluate(readabilityProbe, { floorPx: 30, smallFloorPx: 24 })
      probe = await page.evaluate(stateProbe)
      if (!read || read.id !== state.id || probe.id !== state.id) throw new Error('active slide changed during measurement')
    } catch (error) { states.push({ at: state.at, id: state.id, error: String(error).slice(0, 200) }); return }
    const meta = slides.get(state.id) || {}
    const authoredIcons = (String(meta.source || '').match(/\{icon=/g) || []).length
    const record = {
      at: state.at, id: state.id, step: state.step, index: state.index, visual: state.visual, ident: state.ident, direct: Boolean(state.direct), card: state.card,
      combo: meta.combo || '(none)', layout: read.layout, titleLayout: read.titleLayout, mode: read.mode, body: probe.body,
      ground: read.ground,
      clips: probe.clips, contrast: read.contrast.filter((r) => !r.overImage), overImage: read.contrast.filter((r) => r.overImage).length,
      unresolved: read.unresolved || [], exclusions: read.exclusions,
      floor: read.floor, emptyShare: read.emptyShare, emptyBand: read.emptyBand, overlaps: probe.overlaps,
      autoIcons: Math.max(0, probe.icons - authoredIcons), brandIcons: probe.brand,
    }
    record.shot = `${String(state.index + 1).padStart(3, '0')}-${state.id.replace(/[^a-z0-9]+/gi, '-')}${state.direct ? `-card${state.card}` : ''}-s${state.step}.jpg`
    try {
      await page.screenshot({ path: join(shotsDir, record.shot), type: 'jpeg', quality: 70 })
      const capturedId = await page.evaluate(() => document.querySelector('.stage > .slide.active')?.dataset.id)
      if (capturedId !== state.id) throw new Error('active slide changed during capture')
    } catch (error) {
      states.push({ at: state.at, id: state.id, index: state.index, error: String(error).slice(0, 200) })
      return
    }
    states.push(record)
  }, { settleMs: 120, maxStepsPerSlide: Number(arg('max-steps-per-slide', 1000)), maxPresses: Number(arg('max-presses', 4000)), typingTimeoutMs: Number(arg('typing-timeout-ms', 30000)) })
  const compiledIds = [...slides.keys()]
  for (const id of compiledIds) if (!coverage.expectedIds.includes(id)) coverage.issues.push(`compiled slide absent from DOM: ${id}`)
  for (const id of coverage.expectedIds) if (!slides.has(id)) coverage.issues.push(`DOM slide absent from compiled model: ${id}`)
  coverage.complete = coverage.issues.length === 0
  coverage.compiledIds = compiledIds
  return { states, coverage }
}

// Version of the record layout: records of another version are measured again.
const RECORD_FORMAT = 3

async function auditTalk(outlinePath) {
  const talk = relative(TALKS, outlinePath)
  const slug = talkSlug(talk)
  const recordPath = join(OUT, 'records', `${slug}.json`)
  let cached = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : null
  // a record made from another source (an older identity scheme, a moved talk) is never reused
  if (cached && (cached.talk !== talk || cached.slug !== slug)) cached = null
  // a side that failed is measured again
  if (cached && cached.sides?.before?.error) cached = null
  // --redo-after keeps its recorded before side, including legacy data (reported incomplete, never certified).
  // Without it, a record from an older version of this audit (no run keys, visual signatures or skipped cards) is
  // measured again.
  if (cached && !REDO_AFTER && (cached.format !== RECORD_FORMAT || !cached.sides?.before?.coverage || !cached.sides?.after?.coverage)) cached = null
  if (cached && !REDO_AFTER && !cached.sides?.after?.error) return cached
  const result = cached || { talk, slug, sides: {} }
  result.format = RECORD_FORMAT
  for (const [side, root] of [['before', BEFORE], ['after', AFTER]]) {
    if (!root || (cached && side === 'before')) continue
    try {
      const model = await compile(root, outlinePath, basename(slug))
      const html = join(OUT, 'decks', `${slug}-${side}.html`)
      mkdirSync(dirname(html), { recursive: true })
      writeFileSync(html, String(model.fullHtml))
      const slides = new Map((model.slides || []).map((s) => [s.id, { combo: triggerCombination(s.sourceMarkdown), source: String(s.sourceMarkdown || '') }]))
      result.sides[side] = await auditDeck(html, slides, join(OUT, 'shots', slug, side))
    } catch (error) {
      result.sides[side] = { error: String(error?.stack || error).slice(0, 600), states: [] }
    }
  }
  mkdirSync(dirname(recordPath), { recursive: true })
  writeFileSync(recordPath, JSON.stringify(result))
  return result
}

// ---------------------------------------------------------------------------------------------------------------
// Renders one sheet page per entry; a picture that does not decode is listed, never thrown, so a sheet problem can
// neither crash the audit nor change its exit code. Returns the list of problems.
async function renderSheets(pages) {
  const sheetDir = join(OUT, 'sheets')
  mkdirSync(sheetDir, { recursive: true })
  const problems = []
  let browser
  try {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1960, height: 1000 } })
    for (const { name, html } of pages) {
      try {
        const file = join(sheetDir, `${name}.html`)
        writeFileSync(file, html)
        await page.goto(pathToFileURL(file).href, { waitUntil: 'load', timeout: 60000 })
        const bad = await page.evaluate(async () => {
          const failures = []
          // Decode one at a time (a burst of full-size decodes can fail transiently); retry after a paint.
          for (const img of [...document.images]) {
            let decoded = false
            for (let attempt = 0; attempt < 3 && !decoded; attempt += 1) {
              try { await img.decode(); decoded = Boolean(img.naturalWidth && img.naturalHeight) }
              catch { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))) }
            }
            if (!decoded) failures.push(img.getAttribute('src'))
          }
          return failures.filter(Boolean)
        })
        if (bad.length) problems.push(`${name}: ${bad.length} pictures did not load (first: ${bad[0]})`)
        await page.screenshot({ path: join(sheetDir, `${name}.png`), fullPage: true, timeout: 60000 })
      } catch (error) {
        problems.push(`${name}: ${String(error).split('\n')[0].slice(0, 200)}`)
      }
    }
  } catch (error) {
    problems.push(`contact sheets: ${String(error).split('\n')[0].slice(0, 200)}`)
  } finally {
    await browser?.close().catch(() => {})
  }
  return problems
}

const SHEET_STYLE = '<style>body{margin:0;font:13px system-ui;background:#555;color:#fff}h1{font-size:17px;margin:8px}.row{display:flex;gap:6px;margin:8px;align-items:flex-start}.cap{width:150px;font-size:12px;overflow-wrap:anywhere}figure{margin:0}img,.none{display:block;width:288px;height:162px;background:#222;object-fit:contain}.wide img,.wide .none{width:640px;height:360px}figcaption{font-size:11px}.gap{width:14px}</style>'
const esc = (text) => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
function shotCell(slug, side, name, label) {
  return name && existsSync(join(OUT, 'shots', slug, side, name))
    ? `<figure><img src="../shots/${encodeURIComponent(slug)}/${side}/${encodeURIComponent(name)}"><figcaption>${esc(label)}</figcaption></figure>`
    : `<figure><div class="none">${esc(label)}: not captured</div></figure>`
}

/** Per combination: first, middle and last state of up to five slides, before and after. */
function comboSheets(combos) {
  return combos.map((combo, n) => {
    const rows = combo.examples.slice(0, 5).map((ex) => {
      const pick = (list) => { const l = list.length; return l <= 3 ? [...list, null, null, null].slice(0, 3) : [list[0], list[Math.floor((l - 1) / 2)], list[l - 1]] }
      const cells = (side, list) => pick(list).map((name) => shotCell(ex.slug, side, name, `${side} · ${name ? name.replace(/^.*-s(\d+)\.jpg$/, 'step $1') : '-'}`)).join('')
      return `<div class="row"><div class="cap">${esc(ex.slug.slice(-60))}<br>${esc(ex.id)} · ${ex.faults.join(', ') || 'no faults'}</div>${cells('before', ex.beforeShots)}<div class="gap"></div>${cells('after', ex.afterShots)}</div>`
    }).join('')
    return { name: String(n + 1).padStart(3, '0'), html: `<!doctype html><meta charset="utf-8">${SHEET_STYLE}<h1>${n + 1}. ${esc(combo.key)} · ${combo.slides} slides · faults after: ${FAULTS.map((f) => `${f} ${combo.after[f]}`).join(', ')}</h1><div style="margin:0 8px 0 166px">before: first, middle, last state | after: first, middle, last state</div>${rows}` }
  })
}

/** The before and after shot of every newly failing, worsened and unmatched state, eight to a sheet. */
function changeSheets(changes) {
  const pages = []
  for (let i = 0; i < changes.length; i += 8) {
    const rows = changes.slice(i, i + 8).map((c, j) => `<div class="row wide"><div class="cap">${i + j + 1}. ${esc(c.outcome)} · ${esc(c.class)}<br>${esc(c.slug.slice(-60))}<br>slide ${c.slide} · ${esc(c.at)}<br>${esc(c.why.join('; ').slice(0, 300))}</div>${shotCell(c.slug, 'before', c.beforeShot, `before · ${c.beforeAt || 'no matching state'}`)}<div class="gap"></div>${shotCell(c.slug, 'after', c.afterShot, `after · ${c.at}`)}</div>`).join('')
    pages.push({ name: `changes-${String(i / 8 + 1).padStart(3, '0')}`, html: `<!doctype html><meta charset="utf-8">${SHEET_STYLE}<h1>Newly failing, worsened and unmatched states ${i + 1}-${Math.min(changes.length, i + 8)} of ${changes.length}</h1>${rows}` })
  }
  return pages
}

/** What keeps the audit from being complete: talks with no record, sides that failed to compile or walk, states
 *  that failed to measure, sides with no states at all, and walks cut short by a tool limit. */
function incompleteness(records, missing) {
  const lines = missing.map((talk) => `no record: \`${talk}\``)
  for (const rec of records) {
    // a file named like an outline that compiles to no slides on either side is not a talk (listed apart)
    if (isNotATalk(rec)) continue
    for (const side of ['before', 'after']) {
      const s = rec.sides?.[side]
      if (!s) { lines.push(`\`${rec.talk}\` ${side}: not measured`); continue }
      if (s.error) { lines.push(`\`${rec.talk}\` ${side}: failed: ${s.error.split('\n')[0].slice(0, 160)}`); continue }
      if (!s.coverage?.complete) lines.push(`\`${rec.talk}\` ${side}: incomplete coverage: ${(s.coverage?.issues || ['legacy record without coverage']).join('; ')}`)
      if (!s.states.length) lines.push(`\`${rec.talk}\` ${side}: no slide states`)
      const failed = s.states.filter((st) => st.error)
      if (failed.length) lines.push(`\`${rec.talk}\` ${side}: ${failed.length} states failed to measure (first: ${failed[0].at}: ${failed[0].error.slice(0, 120)})`)
    }
  }
  return lines
}

function isNotATalk(rec) {
  return ['before', 'after'].every((side) => rec.sides?.[side] && !rec.sides[side].error && rec.sides[side].coverage?.complete && rec.sides[side].coverage.compiledIds?.length === 0 && rec.sides[side].states.length === 0)
}

const EXCLUSIONS = [
  ['codeLanguageFloor', 'Code-language badge floor', 'Generated badge, not running text; contrast still measured'],
  ['qrCaptionFloor', 'QR address caption floor', 'Generated address label under a QR code the audience scans, shown large when the code is expanded; contrast still measured'],
  ['outsideSlidePaint', 'Outside-slide/control paint', 'Slide-asset measurement; does not certify audience-window chrome coverage'],
  ['zeroOpacity', 'Zero-opacity ancestor', 'Not painted in this state; later reveal states must be measured'],
  ['visuallyHidden', 'Visually hidden text', 'Screen-reader text clipped to nothing (1px box, clip-path inset(50%), clip rect); not painted'],
  ['mediaControl', 'Media control', 'The deck\'s enlarge control on a video, not slide text'],
]
const OUTCOMES = ['newly', 'worsened', 'unmatched', 'improved', 'unchanged']
const OUTCOME_LABEL = { newly: 'Newly failing', worsened: 'Worsened', unmatched: 'Unmatched', improved: 'Improved', unchanged: 'Unchanged (failing on both)' }

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
      if (st.step === 0 && !st.direct) {
        c.slides += 1
        slideCount += 1
        const shotsOf = (list) => list.filter((s) => s.id === st.id && !s.direct && s.shot).map((s) => s.shot)
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

  // ---- before against after, state by state and run by run (lib/audit-compare.mjs)
  const counts = Object.fromEntries(FAULTS.map((k) => [k, Object.fromEntries(OUTCOMES.map((o) => [o, 0]))]))
  const skipped = { newly: 0, unchanged: 0, improved: 0 }
  const changes = []
  const skippedCases = []
  const direct = Object.fromEntries(FAULTS.map((k) => [k, Object.fromEntries(OUTCOMES.map((o) => [o, 0]))]))
  let unmatchedStates = 0, cleanUnmatched = 0, gone = 0, gate = 0
  const stepCountChanged = []
  for (const rec of records) {
    if (!rec.sides?.before || !rec.sides?.after || rec.sides.before.error || rec.sides.after.error) continue
    const r = compareTalk(rec.sides.before, rec.sides.after)
    for (const k of FAULTS) for (const o of OUTCOMES) { counts[k][o] += r.counts[k][o]; direct[k][o] += r.directCounts[k][o] }
    for (const o of Object.keys(skipped)) skipped[o] += r.skippedCards[o]
    unmatchedStates += r.unmatchedStates
    cleanUnmatched += r.cleanUnmatched
    gone += r.gone
    gate += gateOf(r)
    stepCountChanged.push(...r.stepCountChanged.map((id) => `\`${rec.slug.slice(-40)}\` · ${id}`))
    for (const c of r.cases) {
      changes.push({ talk: rec.talk, slug: rec.slug, class: c.class, outcome: c.outcome, at: c.after.at, slide: c.after.index + 1, combo: c.after.combo, layout: c.after.layout, beforeAt: c.before?.at || null, why: c.why, afterShot: c.after.shot, beforeShot: c.before?.shot })
    }
    for (const c of r.skippedCards.cases) skippedCases.push({ talk: rec.talk, slug: rec.slug, ...c })
  }
  writeFileSync(join(OUT, 'comparison.json'), JSON.stringify({ tolerances: { contrast: CONTRAST_TOLERANCE, floorPx: FLOOR_TOLERANCE_PX, emptyBand: EMPTY_TOLERANCE }, counts, direct, skippedCards: skipped, unmatchedStates, cleanUnmatched, gone, stepCountChanged, gate, changes, skippedCases }, null, 1))

  // ---- contact sheets (before the report, so their problems are in it)
  const gated = changes.filter((c) => ['newly', 'worsened', 'unmatched'].includes(c.outcome))
  let sheetProblems = []
  const sheets = !process.argv.includes('--no-sheets')
  if (sheets) sheetProblems = await renderSheets([...comboSheets(list), ...changeSheets(gated)])

  const incomplete = incompleteness(records, missing)
  const excluded = Object.fromEntries(['before', 'after'].map(side => [side, Object.fromEntries(EXCLUSIONS.map(([k]) => [k, 0]))]))
  for (const rec of records) for (const side of ['before', 'after']) for (const st of rec.sides[side]?.states || []) for (const [k] of EXCLUSIONS) if (st.exclusions?.[k]) excluded[side][k] += 1
  const lines = ['# Look audit of real talks', '',
    ...(incomplete.length ? ['## INCOMPLETE: failed or missing measurements', '', ...incomplete.map((l) => `- ${l}`), ''] : ['Complete: every talk measured on both sides, every settled Next/reveal state measured.', '']),
    ...records.filter(isNotATalk).map((rec) => `Not a talk (no slides on either side), left out: \`${rec.talk}\``),
    `Talks: ${records.length - records.filter(isNotATalk).length}. Slides: ${slideCount}. Slide states (every reveal step, and every card Next never shows): ${stateCount}.`,
    `Before: ${BEFORE || '(none)'}. After: ${AFTER}.`, '',
    'Readiness: fonts and simulated typing settle before measurement. Animation frames are not sampled. Typing waits at most the configured --typing-timeout-ms (default 30000); a timeout makes coverage incomplete. Expected beats and steps come from the deck runtime (its beat list and slideSteps().max) where the deck has it.', '',
    '## Before against after, per fault class', '',
    `Gate: ${gate} (states newly failing, worsened or unmatched with a fault, counted once per class, plus cards Next newly never shows). Tolerances: contrast ${CONTRAST_TOLERANCE}:1, type ${FLOOR_TOLERANCE_PX}px, empty band ${Math.round(EMPTY_TOLERANCE * 100)} points.`, '',
    `| Fault | ${OUTCOMES.map((o) => OUTCOME_LABEL[o]).join(' | ')} |`, `|---|${OUTCOMES.map(() => '---:').join('|')}|`,
    ...FAULTS.map((k) => `| ${k} | ${OUTCOMES.map((o) => counts[k][o]).join(' | ')} |`),
    `| Next never shows this card or slide | ${skipped.newly} | - | - | ${skipped.improved} | ${skipped.unchanged} |`, '',
    `After states with no before state: ${unmatchedStates} (${cleanUnmatched} with no fault). Before states with no after state: ${gone}. Slides whose number of Next states changed (paired by what the audience sees): ${stepCountChanged.length}.`, '',
    `Directly shown states (cards or slides Next never shows; outside the gate): ${FAULTS.map((k) => `${k} ${OUTCOMES.map((o) => `${o} ${direct[k][o]}`).join(' ')}`).filter((line) => /[1-9]/.test(line)).join('; ') || 'no faults'}.`, '',
    'Limits: clipping and overlap are compared by presence and key, so worse geometry of an element that already fails is not quantified; changes below the tolerances can add up over several releases without being reported.', '',
    '## Exclusions (states affected, not runs)', '',
    '| Exclusion | Before | After | Reason |', '|---|---|---|---|',
    ...EXCLUSIONS.map(([k, label, why]) => `| ${label} | ${excluded.before[k]} | ${excluded.after[k]} | ${why} |`), '',
    '## Contact sheets', '',
    ...(!sheets ? ['Not made (--no-sheets).'] : sheetProblems.length ? [`${sheetProblems.length} sheet problems (sheets still written):`, ...sheetProblems.slice(0, 40).map((l) => `- ${l}`)] : [`Written to sheets/: ${list.length} combination sheets, ${Math.ceil(gated.length / 8)} change sheets (changes-*.png). Every picture loaded.`]), '',
    '## Fault states, before and after', '', '| Fault | Before | After |', '|---|---|---|',
    ...FAULTS.map((k) => `| ${k} | ${totals.before[k]} | ${totals.after[k]} |`), '',
    '## Combinations by use (slides)', '', '| Combination | Title | Body | Slides | Talks | Fault states after (clip/contrast/unresolved/floor/empty/overlap/auto icons) | Example |', '|---|---|---|---|---|---|---|',
    ...byUse.map((c) => `| \`${c.combo}\` | ${c.titleLayout || '-'} | ${c.body} | ${c.slides} | ${c.talks} | ${FAULTS.map((k) => c.after[k]).join(' / ')} | ${c.examples[0]?.slug.slice(-40)} ${c.examples[0]?.id} |`), '',
    '## Worst first (contact sheets in sheets/, same order)', '',
    ...list.map((c, i) => `${i + 1}. \`${c.key}\`: ${c.faultStates} fault states over ${c.slides} slides (${FAULTS.filter((k) => c.after[k]).map((k) => `${k} ${c.after[k]}`).join(', ') || 'none'})`), '']
  for (const o of ['newly', 'worsened', 'unmatched']) {
    for (const k of FAULTS) {
      const these = changes.filter((c) => c.outcome === o && c.class === k)
      if (!these.length) continue
      lines.push(`### ${OUTCOME_LABEL[o]}: ${k} (${these.length})`, '', ...these.map((c) => `- \`${c.slug.slice(-40)}\` · slide ${c.slide} · ${c.at}${c.beforeAt && c.beforeAt !== c.at ? ` (before ${c.beforeAt})` : ''} · ${c.layout} · ${c.why.join('; ').slice(0, 200)}`), '')
    }
  }
  if (skippedCases.length) lines.push('### Next never shows this card or slide', '', ...skippedCases.map((c) => `- ${c.outcome}: \`${c.slug.slice(-40)}\` · ${c.id} · ${c.card == null ? `the whole slide (not in the beat list${c.measured === false ? '; the deck would not show it by address either, so it is not measured' : ''})` : `card ${c.card + 1} of ${c.cards}`}`), '')
  if (stepCountChanged.length) lines.push('### Slides whose number of Next states changed', '', ...stepCountChanged.map((l) => `- ${l}`), '')
  const cases = records.flatMap(rec => (rec.sides.after?.states || []).filter(st => !st.error).map(st => ({ path: rec.talk, slide: st.index + 1, step: st.step, at: st.at, classes: FAULTS.filter(k => faultsOf(st)[k]) })).filter(st => st.classes.length))
  writeFileSync(join(OUT, 'cases.json'), JSON.stringify(cases, null, 2))
  writeFileSync(join(OUT, 'report.md'), lines.join('\n') + '\n')
  if (sheetProblems.length) console.error(`contact sheets: ${sheetProblems.length} problems (see report.md):\n${sheetProblems.slice(0, 5).join('\n')}`)
  if (incomplete.length) console.error(`audit INCOMPLETE (${incomplete.length}):\n${incomplete.slice(0, 20).join('\n')}`)
  console.log(`audit: ${records.length} talks, ${slideCount} slides, ${stateCount} states; gate ${gate}; ${FAULTS.map((k) => `${k} newly ${counts[k].newly} worsened ${counts[k].worsened} unmatched ${counts[k].unmatched} improved ${counts[k].improved}`).join('; ')}; Next never shows a card: newly ${skipped.newly}, unchanged ${skipped.unchanged}, improved ${skipped.improved}`)
  return incomplete.length === 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!Number.isFinite(JOBS)) { console.error('--jobs must be finite'); process.exit(2) }
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
  const recordedTalks = new Set(records.map(rec => rec.talk))
  for (const path of paths) {
    const talk = relative(TALKS, path)
    if (!recordedTalks.has(talk) && !missing.includes(talk)) missing.push(talk)
  }
  const complete = await report(records, missing)
  if (!complete) process.exit(3)
}
