#!/usr/bin/env node
// test:qr-address-and-mind-map — two slide faults found by the release-candidate journey, measured in Chromium.
//
// 1. A QR code's address is always shown whole (Ocean look and its safe drawing; title slide, closing slide and a slide's
//    corner, on the rail in every section colour; on screen and on paper): its caption's text is the address character
//    for character (no "…"), nothing of it is clipped or outside the slide, nothing else on the slide lies over it, it
//    breaks only after a slash unless a part alone is wider than the caption, and past three lines it is at its floor.
// 2. A mind map fills its content area: a three-level map of a dozen nodes is drawn at least 70% of the content area's
//    height with labels at or above the type floor, on first show, after a resize, when drawn ahead for paper and then
//    visited, on paper and in the handout; a very wide and a very deep map are drawn whole inside their box.
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { writeDeckStyles } from './build-deck-styles.mjs'

const work = mkdtempSync(join(tmpdir(), 'tw-qr-mindmap-'))
const HARD_LIMIT_MS = 600_000
// TW_TEST_ONLY=qr or =maps runs one part (for diagnosis); the default runs both
const ONLY = process.env.TW_TEST_ONLY || ''
const QR_FLOOR_CQW = 1.2
const TYPE_FLOOR_AT_1600 = 31

const ADDRESSES = {
  short: 'https://handouts.fyi/k8wf',
  medium: 'https://walks.example.org/handouts/planning-a-river-walk',
  long: 'https://walks.example.org/h/abcdefghijklmnopqrstuvwxyzabcdefghijklmn',
  query: 'https://walks.example.org/handouts/map?route=river-meadows&season=spring_2027&lang=en-GB',
}
const shownOf = (url) => url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '')

function qrOutline(url, palette = '') {
  const out = ['---', 'title: Planning a river walk', 'subtitle: A guide for the volunteer walking group', 'author: Sample presenter',
    `handout_url: ${url}`, 'auto_thanks_slide: true', ...(palette ? [`palette: ${palette}`] : []), '---', '']
  // five sections: the section colours rotate (blue, amber, light, deep blue, light amber), each with a corner QR on the rail
  for (let i = 1; i <= 5; i += 1) {
    out.push(`## Part ${i}`, '', `### Where to find the map ${i}`, `{id=qr-${i}}`, '', '- The map is in the handout', '- Bring a printed copy', '', `[QR: ${url}]`, '')
  }
  return out.join('\n')
}

const MAPS = {
  'mm-dozen': ['- A good walk', '  - People', '    - Leader', '    - Back marker', '    - First aider', '  - Route', '    - Map', '    - Gates', '    - Stiles', '  - Kit', '    - Water', '    - Snacks'],
  'mm-wide': ['- The season', ...['Spring planting days', 'Summer river walks', 'Autumn harvest supper', 'Winter footpath repairs', 'Volunteer training evenings', 'Monthly committee meeting', 'Annual open garden weekend', 'Bird survey mornings', 'Litter picking on the banks', 'Hedge laying workshop', 'School visits in June', 'Christmas lantern walk'].map((label) => `  - ${label}`)],
  // revealed a branch per step: each step is fitted once its branches are laid out
  'mm-reveal': ['- A good walk', '  - People', '    - Leader', '    - Back marker', '    - First aider', '  - Route', '    - Map', '    - Gates', '    - Stiles', '  - Kit', '    - Water', '    - Snacks', '    - Torch'],
  'mm-deep': ['- Walk', '  - Route', '    - Meadows', '      - North gate', '        - Stile', '          - Footbridge', '            - Weir', '              - Mill'],
}
function mapOutline() {
  const out = ['---', 'title: Maps', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '', '## Maps', '', '### Before the maps', '{id=before}', '', '- A first slide', '']
  for (const [id, lines] of Object.entries(MAPS)) out.push(`### Map ${id}`, `{mindmap}${id === 'mm-reveal' ? '{reveal}' : ''}{id=${id}}`, '', ...lines, '')
  return out.join('\n')
}

async function compile(name, text) {
  const path = join(work, `${name}.md`)
  writeFileSync(path, text)
  const model = await prepareSource(path, text, name, statSync(path), undefined, { allowedAssetRoots: [dirname(path)] })
  const htmlPath = join(work, `${name}.html`)
  writeFileSync(htmlPath, String(model.fullHtml), 'utf8')
  return { model, htmlPath, path, text }
}

// In the page: every QR caption in `root` (a slide, or the whole document on paper) checked against its address.
function checkQrCaptions({ shown, floorCqw, onPaper }) {
  const problems = []
  const scope = onPaper ? document : document.querySelector('.slide.active')
  for (const figure of scope.querySelectorAll('figure.slide-qr, figure.tp-qr')) {
    const slide = figure.closest('.slide')
    const look = slide.dataset.look || ''
    if (!/^ocean(-safe)?$/.test(look)) continue
    const where = `${slide.dataset.id} (${figure.classList.contains('tp-qr') ? (figure.closest('.tp-closing') ? 'closing' : 'title') : 'corner'}, ${look}, lead ${slide.dataset.lead || '-'})`
    const caption = figure.querySelector('.qr-caption')
    if (!caption) { problems.push(`${where}: no caption`); continue }
    // the code itself is whole, inside the slide
    const code = figure.querySelector('.qr-code')?.getBoundingClientRect()
    const slideBox = slide.getBoundingClientRect()
    if (!code || !(code.width > 0) || code.left < slideBox.left - 1 || code.right > slideBox.right + 1 || code.top < slideBox.top - 1 || code.bottom > slideBox.bottom + 1) problems.push(`${where}: the code is not whole inside the slide`)
    const text = caption.textContent
    if (text !== shown) problems.push(`${where}: shows "${text}", not the address "${shown}"`)
    const own = caption.getBoundingClientRect()
    const range = document.createRange()
    range.selectNodeContents(caption)
    const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5)
    const stage = slide.getBoundingClientRect()
    if (rects.some((r) => r.left < stage.left - 1 || r.right > stage.right + 1 || r.top < stage.top - 1 || r.bottom > stage.bottom + 1)) problems.push(`${where}: part of the address is outside the slide`)
    if (caption.scrollWidth > caption.clientWidth + 1 || caption.scrollHeight > caption.clientHeight + 1) problems.push(`${where}: the address runs out of its caption (${caption.scrollWidth}x${caption.scrollHeight} in ${caption.clientWidth}x${caption.clientHeight})`)
    // clipped by a box above it
    for (let up = caption.parentElement; up && up !== slide.parentElement; up = up.parentElement) {
      const cs = getComputedStyle(up)
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue
      const box = up.getBoundingClientRect()
      if (rects.some((r) => r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1)) problems.push(`${where}: clipped by ${up.className || up.tagName}`)
    }
    // nothing else on the slide over the code or the address
    const area = [figure.querySelector('.qr-code')?.getBoundingClientRect(), own].filter(Boolean)
    const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT)
    for (let node; (node = walker.nextNode());) {
      const el = node.parentElement
      if (!node.data.trim() || figure.contains(el) || el.closest('.sr-only, .notes, script, style, .slide-head-quiet, [aria-hidden="true"]')) continue
      const ecs = getComputedStyle(el)
      if (ecs.visibility === 'hidden' || Number(ecs.opacity) === 0) continue
      range.selectNodeContents(node)
      for (const r of range.getClientRects()) {
        if (!(r.width > 0.5 && r.height > 0.5)) continue
        if (area.some((a) => Math.min(a.right, r.right) - Math.max(a.left, r.left) > 1 && Math.min(a.bottom, r.bottom) - Math.max(a.top, r.top) > 1)) {
          problems.push(`${where}: "${node.data.trim().slice(0, 20)}" lies over the QR code or its address`)
          break
        }
      }
    }
    // a part breaks inside itself only when it alone is wider than the caption
    for (const part of caption.querySelectorAll('.qr-part')) {
      range.selectNodeContents(part)
      const lines = []
      for (const r of range.getClientRects()) if (r.width > 0.5 && !lines.some((top) => Math.abs(top - r.top) < r.height / 2)) lines.push(r.top)
      if (lines.length < 2) continue
      // the part alone, as plain text on one line (a <wbr> breaks a line even under nowrap, so the part itself is not used)
      const copy = document.createElement('span')
      copy.textContent = part.textContent
      copy.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap'
      part.parentElement.appendChild(copy)
      const alone = copy.getBoundingClientRect().width
      copy.remove()
      if (alone <= own.width + 1) problems.push(`${where}: "${part.textContent}" breaks inside although it fits the caption alone`)
    }
    // past three lines, the caption is at its floor
    range.selectNodeContents(caption)
    const lines = []
    for (const r of range.getClientRects()) if (r.width > 0.5 && !lines.some((top) => Math.abs(top - r.top) < r.height / 2)) lines.push(r.top)
    const cqw = slide.offsetWidth / 100
    const size = parseFloat(getComputedStyle(caption).fontSize)
    if (lines.length > 3 && size > cqw * floorCqw * 1.02) problems.push(`${where}: ${lines.length} lines at ${(size / cqw).toFixed(2)}cqw, above the floor of ${floorCqw}cqw`)
  }
  return problems
}

// In the page: the map on slide `id` (the active one, or on paper the one in the document).
function measureMap(id) {
  const slide = document.querySelector(`.slide[data-id="${id}"]`)
  const host = slide?.querySelector('.mindmap-mm')
  const svg = host?.querySelector(':scope > svg')
  const g = svg?.querySelector(':scope > g')
  if (!g) return { missing: true }
  const content = slide.querySelector('.slide-content').getBoundingClientRect()
  const head = slide.querySelector('.slide-head:not(.sr-only)')?.getBoundingClientRect()
  const top = head && head.height > 0 && head.bottom > content.top && head.bottom < content.bottom ? head.bottom : content.top
  const drawn = g.getBoundingClientRect()
  const box = svg.getBoundingClientRect()
  const stage = slide.getBoundingClientRect()
  const scale = Number((g.getAttribute('transform') || '').match(/scale\(([\d.]+)/)?.[1] || 1)
  const canvasScale = stage.width / (slide.offsetWidth || 1)
  const labels = [...svg.querySelectorAll('foreignObject div')].filter((d) => d.textContent.trim())
  const smallest = Math.min(...labels.map((d) => parseFloat(getComputedStyle(d).fontSize) * scale * (1600 / (slide.offsetWidth || 1280))))
  return {
    heightShare: drawn.height / (content.bottom - top),
    widthShare: drawn.width / content.width,
    inside: drawn.left >= box.left - 1 && drawn.right <= box.right + 1 && drawn.top >= box.top - 1 && drawn.bottom <= box.bottom + 1
      && drawn.left >= stage.left - 1 && drawn.right <= stage.right + 1 && drawn.top >= stage.top - 1 && drawn.bottom <= stage.bottom + 1,
    smallest,
    canvasScale,
    labels: labels.length,
  }
}

const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }
const settle = (page, ms = 1800) => page.waitForTimeout(ms)
function mapProblems(where, id, m) {
  const out = []
  if (m.missing) return [`${where} ${id}: the map is not drawn`]
  if (!m.inside) out.push(`${where} ${id}: the map is not drawn whole inside its box and the slide`)
  if (id === 'mm-dozen') {
    if (!(m.heightShare >= 0.7)) out.push(`${where} ${id}: the map uses ${Math.round(m.heightShare * 100)}% of the content area's height (at least 70%)`)
    if (!(m.smallest >= TYPE_FLOOR_AT_1600 - 0.5)) out.push(`${where} ${id}: labels at ${m.smallest.toFixed(1)}px at 1600 wide, under the type floor ${TYPE_FLOOR_AT_1600}px`)
  }
  return out
}

const timer = setTimeout(() => { console.error(`test:qr-address-and-mind-map: over ${HARD_LIMIT_MS / 1000}s, stopped`); process.exit(2) }, HARD_LIMIT_MS)
const browser = await chromium.launch({ headless: true })
try {
  writeDeckStyles()
  // 1. QR addresses
  for (const [kind, url] of ONLY === 'maps' ? [] : Object.entries(ADDRESSES)) {
    for (const palette of ['', 'bold']) {
      const { htmlPath } = await compile(`qr-${kind}${palette ? `-${palette}` : ''}`, qrOutline(url, palette))
      // the presenting deck at two sizes, and the audience window (no control bar) at a plain 16:9
      for (const viewport of [{ width: 1600, height: 900 }, { width: 1280, height: 720 }, { width: 1600, height: 900, audience: true }]) {
        const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion: 'reduce' })
        try {
          await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' })
          if (viewport.audience) await page.evaluate(() => { document.body.classList.add('audience-mode'); dispatchEvent(new Event('resize')) })
          await page.evaluate(() => document.fonts?.ready)
          await settle(page, 400)
          const seen = new Set()
          for (let i = 0; i < 40; i += 1) {
            const id = await page.evaluate(() => document.querySelector('.slide.active')?.dataset.id)
            if (seen.has(id)) break
            seen.add(id)
            for (const p of await page.evaluate(checkQrCaptions, { shown: shownOf(url), floorCqw: QR_FLOOR_CQW, onPaper: false })) failures.push(`${kind}${palette ? ` ${palette}` : ''} @${viewport.width}${viewport.audience ? ' audience' : ''}: ${p}`)
            await page.keyboard.press('ArrowRight')
            await settle(page, 250)
          }
          check(seen.has('deck-title') && seen.has('deck-thanks') && seen.has('qr-5'), `${kind} @${viewport.width}: the title, closing and corner slides were reached (${[...seen].join(', ')})`)
          if (viewport.width === 1600 && !viewport.audience) {
            // paper: the print pass prepares, and the page is laid out under the print rules
            await page.evaluate(() => dispatchEvent(new Event('beforeprint')))
            await page.emulateMedia({ media: 'print' })
            await settle(page, 600)
            const paper = await page.evaluate(checkQrCaptions, { shown: shownOf(url), floorCqw: QR_FLOOR_CQW, onPaper: true })
            for (const p of paper) failures.push(`${kind}${palette ? ` ${palette}` : ''} on paper: ${p}`)
            const counted = await page.evaluate(() => [...document.querySelectorAll('figure.slide-qr, figure.tp-qr')].filter((f) => f.getBoundingClientRect().height > 0).length)
            check(counted >= 7, `${kind} on paper: the title, closing and five corner codes are laid out (${counted})`)
            await page.emulateMedia({ media: 'screen' })
            await page.evaluate(() => dispatchEvent(new Event('afterprint')))
          }
        } finally {
          await page.close()
        }
      }
    }
  }

  // 2. mind maps
  if (ONLY !== 'qr') {
  const maps = await compile('maps', mapOutline())
  // first show, at two sizes
  for (const viewport of [{ width: 1600, height: 900 }, { width: 1280, height: 720 }]) {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce' })
    try {
      await page.goto(pathToFileURL(maps.htmlPath).href, { waitUntil: 'load' })
      await page.evaluate(() => document.fonts?.ready)
      for (const id of Object.keys(MAPS)) {
        await page.evaluate((target) => { location.hash = target }, id)
        await settle(page)
        for (const p of mapProblems(`first show @${viewport.width}`, id, await page.evaluate(measureMap, id))) failures.push(p)
        if (id !== 'mm-reveal') continue
        for (let step = 1; step <= 3; step += 1) {
          await page.keyboard.press('ArrowRight')
          await settle(page)
          for (const p of mapProblems(`reveal step ${step} @${viewport.width}`, id, await page.evaluate(measureMap, id))) failures.push(p)
        }
      }
      // after a resize
      await page.setViewportSize({ width: 1000, height: 562 })
      await settle(page)
      for (const p of mapProblems(`after a resize from ${viewport.width} to 1000`, 'mm-wide', await page.evaluate(measureMap, 'mm-wide'))) failures.push(p)
    } finally {
      await page.close()
    }
  }
  // drawn ahead for paper, on paper, then visited
  {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' })
    try {
      await page.goto(pathToFileURL(maps.htmlPath).href + '#before', { waitUntil: 'load' })
      await page.evaluate(() => document.fonts?.ready)
      // the deck draws its maps ahead of time, one slide at a time while idle (predrawDiagrams)
      const ahead = await page.waitForFunction(() => [...document.querySelectorAll('.mindmap-mm')].every((host) => host.dataset.mmDone), null, { timeout: 15000 }).then(() => true, () => false)
      check(ahead, 'the maps are drawn ahead of time within 15 s')
      await settle(page, 600)
      await page.evaluate(() => dispatchEvent(new Event('beforeprint')))
      await page.emulateMedia({ media: 'print' })
      await settle(page)
      for (const id of Object.keys(MAPS)) for (const p of mapProblems('on paper', id, await page.evaluate(measureMap, id))) failures.push(p)
      await page.emulateMedia({ media: 'screen' })
      await page.evaluate(() => dispatchEvent(new Event('afterprint')))
      await settle(page, 400)
      for (const id of Object.keys(MAPS)) {
        await page.evaluate((target) => { location.hash = target }, id)
        await settle(page)
        for (const p of mapProblems('drawn ahead, then visited', id, await page.evaluate(measureMap, id))) failures.push(p)
      }
    } finally {
      await page.close()
    }
  }
  // the handout
  {
    const deck = await buildDeckHtmlFromModel(maps.model)
    const html = buildShareHtml({ title: 'Maps', slug: 'maps', includeNotes: false, license: null, slides: extractSlides(deck), styles: extractStyles(deck) })
    const handoutPath = join(work, 'maps-handout.html')
    writeFileSync(handoutPath, html)
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, reducedMotion: 'reduce' })
    try {
      await page.goto(pathToFileURL(handoutPath).href, { waitUntil: 'load' })
      await page.evaluate(() => document.fonts?.ready)
      await settle(page, 400)
      for (let i = 0; i < 10; i += 1) {
        const id = await page.evaluate(() => document.querySelector('.stage > .slide.active')?.dataset.id)
        if (id && MAPS[id]) {
          await settle(page)
          for (const p of mapProblems('handout', id, await page.evaluate(measureMap, id))) failures.push(p)
        }
        await page.keyboard.press('ArrowRight')
        await settle(page, 200)
      }
    } finally {
      await page.close()
    }
  }
  }
} finally {
  clearTimeout(timer)
  await browser.close()
  rmSync(work, { recursive: true, force: true })
}
if (failures.length) {
  console.error(`test:qr-address-and-mind-map: ${failures.length} failure(s)\n  ${failures.slice(0, 50).join('\n  ')}`)
  process.exit(1)
}
console.log('test:qr-address-and-mind-map: QR addresses shown whole on the title, closing and corner slides in every section colour, on screen and on paper; mind maps fill their area on first show, after a resize, drawn ahead and visited, on paper and in the handout')
