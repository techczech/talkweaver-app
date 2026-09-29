// Real-Electron host gate for the statement options (ADR-0028 §10; ticket 02, Dominik 29 Sep).
// HOST-RUN ONLY, one Electron run at a time: node e2e/diagnose-statement-options.mjs
//
// Ticket 02 split the one five-way "Statement treatment" into separate choices. This drives the
// app's Inspector and reads the Inspector's live slide preview:
//   1. The Statement section offers five small segmented controls — Sidebar (With sidebar · No
//      sidebar), Background (Halo · Full · None), Alignment (Aligned · Centred), Bar (None · Left ·
//      Top · Bottom), Sidebar colour (Section · the palette) — and no Claim style row.
//   2. The older one-word option on the slide lights its mapped values; the first click rewrites
//      it as per-dimension tokens without changing the look.
//   3. Every value of every control, clicked in the Inspector, changes ONLY its own dimension of
//      the preview (and of the lit buttons); type size, line height, measure and line breaks stay.
//   4. The combinations: Halo + Top bar, Full + Bottom bar, Centred + sidebar, a sidebar colour
//      (rail and halo together), and a titled statement with No sidebar (title on top).
//   5. The text-size step still scales the statement (XL = 3.9/3.2 of M); no lone last word at the
//      Inspector's real preview size in three window sizes; {stmt-list} keeps Claim style.
// TW_STATEMENT_OUTLINE=<path to a COPY of layout-showcase-outline.md> runs it on the real talk (the
// copy is copied again into a throwaway vault); TW_SHOTS_DIR=<dir> saves a screenshot per state.
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { dirname, join } from 'path'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

// The slides from layout-showcase, 3b2vn as on the preview.10 check (the older {statement=centred}
// and an authored background), plus a titled statement and a {claim=bar} statement.
const FIXTURE = `---
title: TalkWeaver Layout Showcase
author: Dominik Lukeš
defaults: { icons: on }
outline_version: 2
---

# TalkWeaver Layout Showcase

## Statements
{id=n2gv5}{accent=cobalt}

### A single strong claim
{statement}{id=rairt}

The fastest way to lose an audience is a slide that says everything at once.

### Statement beside a list
{stmt-list}{claim=plain}{id=4wkv0}

Is the time you save worth the time you spend reviewing?

- Yes for repetitive, well-specified work
- Break-even on one-off scripts
- A clear win when you'd have planned anyway

### This is an important statement slide
{id=3b2vn}{statement}{font-body=xl}{bg=vermilion}{statement=centred}


### This is an important claim slide
{id=clbar}{statement}{claim=bar}{bg=emerald}


### A plain list, with icons
{list}{id=5s8u7}

- Plan the talk before opening the editor
- Draft in markdown, let layouts do the design
`
const realTalk = Boolean(process.env.TW_STATEMENT_OUTLINE)
const source = realTalk ? readFileSync(process.env.TW_STATEMENT_OUTLINE, 'utf8') : FIXTURE
const shotsDir = process.env.TW_SHOTS_DIR || ''
if (shotsDir) mkdirSync(shotsDir, { recursive: true })

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-statement-e2e-'))
const vault = join(tempRoot, 'vault')
const ud = join(tempRoot, 'userData')
mkdirSync(ud, { recursive: true })
const dir = join(vault, 'layout-showcase')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'layout-showcase-outline.md'), source)
// The real talk's pictures, so its other slides render (they are copied, never linked).
const assets = realTalk && join(dirname(process.env.TW_STATEMENT_OUTLINE), 'assets')
if (assets && existsSync(assets)) cpSync(assets, join(dir, 'assets'), { recursive: true })
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))
await ensureFreshBuild(process.cwd())
const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: process.cwd(), env: { ...process.env, TW_E2E: '1' } })
const page = await app.firstWindow()
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 150)))
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(2500)
let failures = 0
const rec = (name, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

const CLEAR = 'rgba(0, 0, 0, 0)'
const EMERALD_TINT = 'rgb(228, 243, 238)'
const setWindow = async (width, height) => {
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [width, height])
  await page.waitForTimeout(1200)
}
await setWindow(1512, 945)
await page.locator('.tl-row').first().dblclick()
await page.waitForTimeout(3000)
await page.keyboard.press('Meta+p')
await page.waitForTimeout(1500)

const inspectorTitle = async () => (await page.locator('.tw-inspector-title').textContent() ?? '').trim()
const goTo = async (title) => {
  for (const direction of ['Previous slide', 'Next slide']) {
    for (let step = 0; step < 120 && await inspectorTitle() !== title; step += 1) {
      const button = page.locator(`.tw-inspector-nav button[aria-label="${direction}"]`)
      if (await button.isDisabled()) break
      await button.click()
      await page.waitForTimeout(200)
    }
  }
  await page.waitForTimeout(1500)
  return await inspectorTitle() === title
}
// The slide's authored Trigger line as the editor holds it (the file follows on autosave).
const triggerLine = async (id) => page.evaluate((slideId) => {
  const text = [...document.querySelectorAll('.cm-line')].map((line) => line.textContent ?? '')
  return text.find((line) => line.includes(`{id=${slideId}}`))?.trim() ?? ''
}, id)
const G = { sidebar: 'Statement sidebar', bg: 'Statement background', align: 'Statement alignment', bar: 'Statement bar', colour: 'Sidebar colour' }
const groupButtons = (label) => page.locator(`.tw-inspector-options [role="group"][aria-label="${label}"] button`)
const buttonLabels = async (label) => (await groupButtons(label).allTextContents()).map((text) => text.replace(/deck$/, '').trim())
const litLabel = async (label) => (await page.locator(`.tw-inspector-options [role="group"][aria-label="${label}"] button[aria-pressed="true"]`).allTextContents())
  .map((text) => text.replace(/deck$/, '').trim()).join(',')
const litAll = async () => Object.fromEntries(await Promise.all(Object.entries(G).map(async ([dim, label]) => [dim, await litLabel(label)])))
const choose = async (label, value) => {
  const button = groupButtons(label).filter({ hasText: new RegExp(`^${value}(deck)?$`) }).first()
  // A missing option is a failed check, not a stalled run (so an old build shows every failure).
  if (await button.count() === 0) { rec(`${label} offers ${value}`, false, 'no such button'); return false }
  await button.click()
  await page.waitForTimeout(2600)
  return true
}
// The Inspector's live preview: the active slide's statement paragraph and the slide round it.
const preview = async () => page.frameLocator('.tw-inspector-stage iframe').locator('body').evaluate((body) => {
  const slide = body.querySelector('.slide.active')
  const content = slide?.querySelector(':scope > .slide-content')
  const p = content?.querySelector(':scope > p:not(.kicker):not(.slide-source), .stmt > p')
  if (!p) return { error: 'no statement paragraph in the preview' }
  const rows = []
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
  for (let node; (node = walker.nextNode());) {
    for (let i = 0; i < node.data.length; i++) {
      const range = document.createRange()
      range.setStart(node, i)
      range.setEnd(node, i + 1)
      const rect = range.getClientRects()[0]
      if (!rect || !rect.height) continue
      const mid = rect.top + rect.height / 2
      const row = rows.find((candidate) => Math.abs(candidate.mid - mid) < rect.height / 3)
      if (row) row.text += node.data[i]
      else rows.push({ mid, text: node.data[i] })
    }
  }
  const cs = getComputedStyle(p)
  const ss = getComputedStyle(slide)
  const stage = slide.parentElement
  const k = stage.getBoundingClientRect().width / stage.offsetWidth
  const sr = slide.getBoundingClientRect()
  const pr = p.getBoundingClientRect()
  const kept = p.getAttribute('style')
  p.style.setProperty('width', '100000px', 'important')
  const measure = parseFloat(getComputedStyle(p).width)
  if (kept == null) p.removeAttribute('style'); else p.setAttribute('style', kept)
  const head = content.querySelector(':scope > .slide-head:not(.slide-head-quiet)')
  const column = slide.dataset.titleLayout === 'left'
    ? (() => { const ccs = getComputedStyle(content); const cr = content.getBoundingClientRect(); return { left: (cr.left - sr.left) / k + parseFloat(ccs.gridTemplateColumns.split(' ')[0]) + parseFloat(ccs.columnGap), right: (cr.right - sr.left) / k - parseFloat(ccs.paddingRight) } })()
    : null
  return {
    id: slide.dataset.id,
    className: content.className,
    titleLayout: slide.dataset.titleLayout,
    fontSize: parseFloat(cs.fontSize),
    lineHeight: cs.lineHeight,
    measure,
    lines: rows.sort((a, b) => a.mid - b.mid).map((row) => row.text.replace(/ /g, ' ').trim()).filter(Boolean),
    panel: cs.backgroundColor,
    bars: { left: parseFloat(cs.borderLeftWidth) || 0, top: parseFloat(cs.borderTopWidth) || 0, bottom: parseFloat(cs.borderBottomWidth) || 0 },
    barColour: cs.borderLeftWidth !== '0px' ? cs.borderLeftColor : cs.borderTopWidth !== '0px' ? cs.borderTopColor : cs.borderBottomColor,
    textAlign: cs.textAlign,
    slideBg: ss.backgroundColor,
    rail: ss.backgroundImage.match(/rgba?\([^)]*\)/)?.[0] ?? '',
    tint: ss.getPropertyValue('--tint').trim(),
    headText: head?.textContent.replace(/\u00a0/g, ' ').trim() ?? '',
    headBottom: head ? (head.getBoundingClientRect().bottom - sr.top) / k : null,
    box: { left: (pr.left - sr.left) / k, right: (pr.right - sr.left) / k, top: (pr.top - sr.top) / k }, column
  }
}).catch((error) => ({ error: String(error).slice(0, 160) }))
const lastLineWords = (shot) => (shot.lines?.at(-1) ?? '').split(/\s+/).filter(Boolean).length
const shoot = async (name) => {
  if (!shotsDir) return
  // Bring the live preview back into view (a click lower in the options scrolls it away).
  await page.evaluate(() => document.querySelector('.tw-inspector-stage')?.scrollIntoView({ block: 'start' }))
  await page.waitForTimeout(200)
  await page.locator('.tw-inspector').screenshot({ path: join(shotsDir, `${name}.png`) }).catch(() => {})
}
// The look a preview shows, one value per dimension (valid with no authored {bg=…}).
const dimsOf = (shot) => ({
  sidebar: shot.titleLayout === 'left' ? 'With sidebar' : 'No sidebar',
  bg: shot.panel !== CLEAR ? 'Halo' : shot.slideBg !== CLEAR ? 'Full' : 'None',
  align: shot.textAlign === 'center' ? 'Centred' : 'Aligned',
  bar: shot.bars.left ? 'Left' : shot.bars.top ? 'Top' : shot.bars.bottom ? 'Bottom' : 'None',
  tint: shot.tint
})

const ROWS = {
  sidebar: ['With sidebar', 'No sidebar'],
  bg: ['Halo', 'Full', 'None'],
  align: ['Aligned', 'Centred'],
  bar: ['None', 'Left', 'Top', 'Bottom'],
  colour: ['Section', 'Cobalt', 'Emerald', 'Vermilion', 'Forest']
}

// ── 3b2vn: the title-as-statement slide ─────────────────────────────────────────────────────────
const SPECIMEN = 'This is an important statement slide'
rec('Inspector reaches 3b2vn', await goTo(SPECIMEN), await inspectorTitle())
for (const [dim, label] of Object.entries(G)) {
  rec(`3b2vn offers ${label}: ${ROWS[dim].join(' · ')}`, JSON.stringify(await buttonLabels(label)) === JSON.stringify(ROWS[dim]), JSON.stringify(await buttonLabels(label)))
}
rec('3b2vn no longer offers the one five-way Statement treatment row', await groupButtons('Statement treatment').count() === 0)
rec('3b2vn does not offer the older Claim style row', await groupButtons('Claim style').count() === 0)
{
  const start = await litAll()
  const want = { sidebar: 'No sidebar', bg: 'Halo', align: realTalk ? 'Aligned' : 'Centred', bar: 'None', colour: 'Section' }
  rec(`his line lights ${JSON.stringify(want)}`, JSON.stringify(start) === JSON.stringify(want), `${JSON.stringify(start)} on ${await triggerLine('3b2vn')}`)
}
const xl = await preview()
rec('3b2vn preview readable', !xl.error, xl.error)
await shoot('3b2vn-01-his-line')

// The first click on an older option rewrites it as separate tokens and keeps the look.
if (!realTalk) {
  await choose(G.bar, 'None')
  const line = await triggerLine('3b2vn')
  rec('a click rewrites {statement=centred} as {statement-align=centred}', !/statement=centred/.test(line) && /\{statement\}/.test(line) && /statement-align=centred/.test(line), line)
  const after = await preview()
  rec('…and the preview is unchanged', JSON.stringify(after) === JSON.stringify(xl), JSON.stringify([after.className, xl.className]))
  await choose('Background', 'Auto')
  rec('Background Auto removes {bg=vermilion}', !(await triggerLine('3b2vn')).includes('bg='), await triggerLine('3b2vn'))
}
// The text-size step (preview.10): XL is the ladder's 3.9/3.2 of M.
const xlShot = await preview()
await choose('Body size', 'M')
rec('Body size M removes {font-body=xl}', !(await triggerLine('3b2vn')).includes('font-body='), await triggerLine('3b2vn'))
let prev = await preview()
rec('font-body=xl sets the statement at the ladder ratio to M', Math.abs(xlShot.fontSize - prev.fontSize * 3.9 / 3.2) <= 0.6 && xlShot.fontSize - prev.fontSize >= 8,
  `XL ${xlShot.fontSize}px, M ${prev.fontSize}px`)
const sectionTint = prev.tint
let state = dimsOf(prev)
rec('the starting look reads from the preview', !prev.error && state.bg === 'Halo', JSON.stringify(state))
await shoot('3b2vn-02-start-m')

// 3. Every value of every control changes only its own dimension — in the lit buttons and in the
//    preview. Sidebar colour's own dimension is the tint.
const SWEEP = [
  ['bg', 'Full'], ['bg', 'None'], ['bg', 'Halo'],
  ['align', state.align === 'Centred' ? 'Aligned' : 'Centred'], ['align', state.align],
  ['bar', 'Left'], ['bar', 'Top'], ['bar', 'Bottom'], ['bar', 'None'],
  ['sidebar', 'With sidebar'], ['sidebar', 'No sidebar'],
  ['colour', 'Emerald'], ['colour', 'Section']
]
const TINT = { Section: sectionTint, Emerald: '#e4f3ee', Cobalt: '#e8eefc', Vermilion: '#fcece3', Forest: '#e4f3ee' }
let litBefore = await litAll()
for (const [dim, value] of SWEEP) {
  await choose(G[dim], value)
  const shot = await preview()
  const line = await triggerLine('3b2vn')
  const tag = `3b2vn ${G[dim]} → ${value}`
  rec(`${tag}: preview readable`, !shot.error, shot.error)
  if (shot.error) continue
  const expected = { ...state, ...(dim === 'colour' ? { tint: TINT[value] } : { [dim]: value }) }
  rec(`${tag}: the preview changes only its own dimension`, JSON.stringify(dimsOf(shot)) === JSON.stringify(expected), `${JSON.stringify(dimsOf(shot))} want ${JSON.stringify(expected)}`)
  const lit = await litAll()
  rec(`${tag}: only its own row's lit button changes`, JSON.stringify(lit) === JSON.stringify({ ...litBefore, [dim]: value }), JSON.stringify(lit))
  rec(`${tag}: the line carries per-dimension tokens only`, !/\{(statement=|claim=)/.test(line), line)
  if (dim !== 'sidebar' && dim !== 'colour' && state.sidebar === 'No sidebar') {
    rec(`${tag}: type, line height, measure and breaks unchanged`, Math.abs(shot.fontSize - prev.fontSize) <= 0.05 && shot.lineHeight === prev.lineHeight
      && Math.abs(shot.measure - prev.measure) <= 1 && JSON.stringify(shot.lines) === JSON.stringify(prev.lines),
    `${shot.fontSize}px ${shot.measure}px ${JSON.stringify(shot.lines)} vs ${prev.fontSize}px ${prev.measure}px ${JSON.stringify(prev.lines)}`)
  }
  if (dim === 'bar' && value !== 'None') rec(`${tag}: the bar is the section accent, .22em`, Math.abs(shot.bars[value.toLowerCase()] - 0.22 * shot.fontSize) <= 1, `${JSON.stringify(shot.bars)} at ${shot.fontSize}px`)
  if (dim === 'sidebar' && value === 'With sidebar') {
    rec(`${tag}: the rail is painted in the slide's colour, empty`, shot.rail !== '' && shot.headText === '', `${shot.rail} "${shot.headText}"`)
    rec(`${tag}: the statement sits in the content column`, Boolean(shot.column) && shot.box.left >= shot.column.left - 1, `${shot.box.left} vs column ${shot.column?.left}`)
  }
  rec(`${tag}: no lone last word`, lastLineWords(shot) >= 2, JSON.stringify(shot.lines))
  await shoot(`3b2vn-${dim}-${value.toLowerCase().replace(/\s+/g, '-')}`)
  state = expected
  prev = shot
  litBefore = lit
}

// 4. Combinations.
const combo = async (name, steps, verify) => {
  for (const [dim, value] of steps) await choose(G[dim], value)
  const shot = await preview()
  rec(`3b2vn ${name}: preview readable`, !shot.error, shot.error)
  if (!shot.error) verify(shot)
  rec(`3b2vn ${name}: no lone last word`, lastLineWords(shot) >= 2, JSON.stringify(shot.lines))
  await shoot(`3b2vn-combo-${name}`)
  return shot
}
await combo('halo-top', [['bg', 'Halo'], ['bar', 'Top'], ['align', 'Aligned'], ['sidebar', 'No sidebar']], (shot) => {
  rec('Halo + Top bar: the panel with the bar above, clear of the text', shot.panel === TINT_RGB(sectionTint) && shot.bars.top > 0 && shot.bars.left === 0, `${shot.panel} ${JSON.stringify(shot.bars)}`)
})
await combo('full-bottom', [['bg', 'Full'], ['bar', 'Bottom']], (shot) => {
  rec('Full + Bottom bar: the slide in the colour, no panel, the bar below', shot.slideBg === TINT_RGB(sectionTint) && shot.panel === CLEAR && shot.bars.bottom > 0, `${shot.slideBg} ${shot.panel} ${JSON.stringify(shot.bars)}`)
  rec('Full + Bottom bar: the bar is the accent, not the fill', shot.barColour !== shot.slideBg, shot.barColour)
})
await combo('centred-sidebar', [['bg', 'Halo'], ['bar', 'None'], ['sidebar', 'With sidebar'], ['align', 'Centred']], (shot) => {
  const centre = (shot.box.left + shot.box.right) / 2
  const column = shot.column ? (shot.column.left + shot.column.right) / 2 : NaN
  rec('Centred + sidebar: centred lines in the content column beside the rail', shot.textAlign === 'center' && shot.titleLayout === 'left' && Math.abs(centre - column) <= 3,
    `${shot.textAlign} ${shot.titleLayout} box centre ${centre.toFixed(0)} column centre ${column.toFixed(0)}`)
})
await combo('sidebar-colour', [['colour', 'Emerald']], (shot) => {
  rec('Sidebar colour Emerald: the rail and the halo change together', shot.rail === EMERALD_TINT && shot.panel === EMERALD_TINT, `rail ${shot.rail} halo ${shot.panel}`)
})
await combo('section-colour', [['colour', 'Section']], (shot) => {
  rec('Sidebar colour Section: back to the section colour', shot.rail === TINT_RGB(sectionTint) && shot.panel === TINT_RGB(sectionTint), `rail ${shot.rail} halo ${shot.panel}`)
})
await choose(G.align, 'Aligned')
await choose(G.sidebar, 'No sidebar')

// 5. No lone last word at the Inspector's real preview size, in three window sizes.
for (const [width, height] of [[1280, 800], [1728, 1117], [2560, 1440]]) {
  await setWindow(width, height)
  for (const [bg, bar] of [['None', 'Left'], ['Halo', 'None']]) {
    await choose(G.bg, bg)
    await choose(G.bar, bar)
    const shot = await preview()
    rec(`3b2vn ${bg} + ${bar} bar at a ${width}x${height} window: last two words together`, lastLineWords(shot) >= 2, JSON.stringify(shot.lines))
  }
  await shoot(`3b2vn-window-${width}x${height}`)
}
await setWindow(1512, 945)

// ── rairt: a statement beside a title ───────────────────────────────────────────────────────────
rec('Inspector reaches rairt', await goTo('A single strong claim'), await inspectorTitle())
{
  const start = await litAll()
  rec('rairt lights With sidebar (the title is in the rail)', start.sidebar === 'With sidebar', JSON.stringify(start))
  const titled = await preview()
  rec('rairt: the title is in the rail', titled.titleLayout === 'left' && titled.headText.includes('A single strong claim'), `${titled.titleLayout} "${titled.headText}"`)
  await shoot('rairt-01-with-sidebar')
  await choose(G.sidebar, 'No sidebar')
  const top = await preview()
  rec('rairt No sidebar: the title goes to the top, the statement runs full width below it',
    top.titleLayout === 'top' && top.headBottom != null && top.headBottom <= top.box.top && top.rail === '' && Math.abs(top.box.left - (1280 - top.box.right)) <= 3,
    `${top.titleLayout} head ${top.headBottom} box ${JSON.stringify(top.box)} rail ${top.rail}`)
  rec('rairt No sidebar: only the sidebar changed', dimsOf(top).bg === dimsOf(titled).bg && dimsOf(top).bar === dimsOf(titled).bar && dimsOf(top).align === dimsOf(titled).align)
  await shoot('rairt-02-no-sidebar')
  await choose(G.sidebar, 'With sidebar')
  await choose(G.align, 'Centred')
  const centred = await preview()
  const centre = (centred.box.left + centred.box.right) / 2
  rec('rairt Centred beside the title: centred in the content column',
    centred.textAlign === 'center' && centred.column && Math.abs(centre - (centred.column.left + centred.column.right) / 2) <= 3, `${centred.textAlign} ${centre}`)
  await shoot('rairt-03-centred')
  await choose(G.colour, 'Emerald')
  const colour = await preview()
  rec('rairt Sidebar colour Emerald: rail and halo change together', colour.rail === EMERALD_TINT && colour.panel === EMERALD_TINT, `rail ${colour.rail} halo ${colour.panel}`)
  await shoot('rairt-04-emerald')
  await choose(G.bar, 'Left')
  const bar = await preview()
  rec('rairt: the bar follows the sidebar colour', bar.barColour === 'rgb(10, 122, 92)', bar.barColour)
  await shoot('rairt-05-emerald-left-bar')
}

// ── A statement set to Bar through the old Claim style row ──────────────────────────────────────
if (!realTalk) {
  rec('Inspector reaches the {claim=bar} statement', await goTo('This is an important claim slide'), await inspectorTitle())
  const start = await litAll()
  rec('{claim=bar} lights Background None + Bar Left', start.bg === 'None' && start.bar === 'Left', JSON.stringify(start))
  const before = await preview()
  await choose(G.bar, 'Top')
  const line = await triggerLine('clbar')
  rec('Bar Top rewrites {claim=bar}: no colour kept, the bar moves', !line.includes('claim=') && line.includes('{statement-bg=none}') && line.includes('{statement-bar=top}'), line)
  const after = await preview()
  rec('…the preview: no panel, the authored colour on the slide, the bar above', after.panel === CLEAR && after.slideBg === EMERALD_TINT && after.bars.top > 0 && after.bars.left === 0,
    `${after.panel} ${after.slideBg} ${JSON.stringify(after.bars)} (before ${JSON.stringify(before.bars)})`)
  await shoot('clbar-top')
}

// ── 4wkv0: statement beside a list ──────────────────────────────────────────────────────────────
rec('Inspector reaches 4wkv0', await goTo('Statement beside a list'), await inspectorTitle())
rec('stmt-list does not offer the statement choices', await groupButtons(G.bg).count() === 0 && await groupButtons(G.sidebar).count() === 0)
rec('stmt-list offers Claim style for its statement column', await groupButtons('Claim style').count() === 3)
{
  await choose('Claim style', 'Plain')
  const plain = await preview()
  rec('stmt-list {claim=plain}: the statement column has no bar', !plain.error && plain.bars?.left === 0, `${plain.bars?.left}px ${plain.error ?? ''}`)
  await choose('Claim style', 'Bar')
  rec('Claim style Bar writes {claim=bar}', (await triggerLine('4wkv0')).includes('{claim=bar}'), await triggerLine('4wkv0'))
  const bar = await preview()
  rec('stmt-list {claim=bar}: the statement column draws the accent bar', bar.bars?.left > 0, `${bar.bars?.left}px`)
}

await app.close()
if (failures) {
  console.log(`\n=== statement options: ${failures} FAILED ===`)
  process.exit(1)
}
console.log('\n=== statement options: all checks passed ===')

function TINT_RGB(hex) {
  const value = String(hex).replace('#', '')
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16))
  return `rgb(${r}, ${g}, ${b})`
}
