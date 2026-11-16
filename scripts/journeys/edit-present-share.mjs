// Journey, first half: steps 1 to 3 and 7 (open and edit, present, print, share), driven as a presenter would
// through the checkout's own build. Fresh user data, temporary vault, the neutral talk in talk.mjs.
//   node scripts/journeys/edit-present-share.mjs   (evidence: artefacts/journey/edit-present-share/)
// TW_STEPS=1,2 runs only those steps when the script is run by hand (a diagnostic: the missing checks then fail
// the ledger). The runner never passes TW_STEPS, so a gate run always runs 1,2,3,7.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { launch, launchChromium, closeApp, runFolders, ledger, shooter, size, pause, hardLimit, winCall, capturePage, writeJson, commit, REPO } from './lib.mjs'
import { makeVault, TITLE, SECTION_OVERRIDES, SLIDE_IDS, EXPECTED_SLIDES, EXPECTED_PRINT_PAGES, CAROUSEL_CARDS, DECK, expectedSteps } from './talk.mjs'
import { statusBarMeasured, statusBarKnownCollapse } from './could-not-allowed.mjs'
import { openTalkByTitle } from '../../e2e/lib/talklist.mjs'

hardLimit(Number(process.env.TW_LIMIT_MS || 540000), 'edit-present-share')
const { out, state, userData } = runFolders('edit-present-share')
const { vault, outlinePath } = makeVault(state)
mkdirSync(userData, { recursive: true })
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, recordingDiscardMs: 800, theme: 'light' }))
const { record, harness } = ledger(out, 'edit-present-share')
const shot = shooter(out)
const rel = (p) => p.replace(REPO + '/', '')
// A step that throws is a harness FAIL; the checks it did not reach are then missing, which also fails the stage.
const step = async (name, fn) => { try { await fn() } catch (e) { harness(`${name}: ${String(e?.stack || e).slice(0, 900)}`) } }
const GUIDE = join(out, '..', 'guide'); mkdirSync(GUIDE, { recursive: true })
// A printed page carries only the talk's own words: every word on it must come from the outline (title, talk
// details, slides, notes), from the deck's own drawing (the chat window's fixed chrome, the closing slide, the
// interactive page's stand-in) or be a number. Anything else (a presenter notice, a control's name) is reported.
const DRAWING_WORDS = 'new chat recent ask anything model reasoning trip ideas reply to sam vat question weekly menu interactive page runs when this slide is presented thank you of'.split(' ')
const wordsOf = (t) => (String(t).normalize('NFKC').toLowerCase().match(/[\p{L}][\p{L}'’]*/gu) || [])
async function auditPdf(file, route) {
  const own = new Set([...wordsOf(readFileSync(outlinePath, 'utf8')), ...DRAWING_WORDS])
  const pages = Number(execFileSync('pdfinfo', [file], { encoding: 'utf8' }).match(/Pages:\s+(\d+)/)[1])
  const foreign = []
  let videoPage = 0
  for (let n = 1; n <= pages; n++) {
    const t = execFileSync('pdftotext', ['-raw', '-f', String(n), '-l', String(n), file, '-'], { encoding: 'utf8' })
    const odd = [...new Set(wordsOf(t).filter((w) => !own.has(w) && !own.has(w.replace(/['’]s$/, ''))))]
    if (odd.length) foreign.push({ page: n, words: odd.slice(0, 20) })
    if (!videoPage && /short clip from the last walk/i.test(t.replace(/\s+/g, ' '))) videoPage = n
  }
  const flat = (n) => execFileSync('pdftotext', ['-raw', '-f', String(n), '-l', String(n), file, '-'], { encoding: 'utf8' }).replace(/\s+/g, '')
  const addr = 'walks.example.org/handouts/planning-a-river-walk-for-volunteers'
  record(`print.${route}.qr-address`, flat(1).includes(addr) && flat(pages).includes(addr), `title page ${flat(1).includes(addr)}, closing page ${flat(pages).includes(addr)}`, rel(file))
  record(`print.${route}.own-text`, pages > 0 && foreign.length === 0, foreign.length ? JSON.stringify(foreign.slice(0, 6)) : `${pages} pages clean`, rel(file), { pages, foreign })
  // The video page: its picture prints (not a blank page). Measured below the title band.
  let ink = null
  if (videoPage) {
    const png = join(out, `${basename(file, '.pdf')}-video-page`)
    execFileSync('pdftoppm', ['-r', '40', '-png', '-f', String(videoPage), '-l', String(videoPage), '-singlefile', file, png])
    const sharp = (await import('sharp')).default
    const { data, info } = await sharp(png + '.png').removeAlpha().raw().toBuffer({ resolveWithObject: true })
    let dark = 0, total = 0
    for (let y = Math.round(info.height * 0.15); y < Math.round(info.height * 0.85); y++) for (let x = Math.round(info.width * 0.05); x < Math.round(info.width * 0.95); x++) { const i = (y * info.width + x) * 3; total++; if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) dark++ }
    ink = dark / total
    record(`print.${route}.video-page`, ink > 0.08, `page ${videoPage}: ${(ink * 100).toFixed(1)}% of the slide area inked`, rel(png + '.png'), { videoPage, ink })
  } else record(`print.${route}.video-page`, false, 'no page with the video slide\'s title')
  return { foreign, videoPage, ink, pages }
}
const only = (process.env.TW_STEPS || '1,2,3,7').split(',')
console.log('commit', commit(), 'state', state)

// ── In-page probes ───────────────────────────────────────────────────────────────────────────────
// The active slide as a deck page shows it: id, hash, carousel card and dots, how many step units are
// hidden, and text faults (a word split over two lines, words of different blocks overlapping).
const PROBE = () => {
  const slide = document.querySelector('.slide.active')
  if (!slide) return { id: null }
  const vis = (el) => { const c = getComputedStyle(el); return c.visibility !== 'hidden' && c.display !== 'none' && Number(c.opacity) > 0.05 }
  const all = [...slide.querySelectorAll('*')]
  const hiddenUnits = all.filter((el) => el.matches('li, .step, [data-step], .card, .reveal-unit') && !vis(el)).length
  const gallery = slide.querySelector('.card-gallery, .gallery')
  const cards = [...slide.querySelectorAll('.card')]
  const activeCard = cards.findIndex((c) => c.classList.contains('active-card'))
  const dots = [...slide.querySelectorAll('.gallery-dot')]
  const activeDot = dots.findIndex((d) => d.classList.contains('active'))
  // Words: one Range per word in every visible text node.
  const words = []
  const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT)
  const sr = slide.getBoundingClientRect()
  while (walker.nextNode()) {
    const node = walker.currentNode
    const el = node.parentElement
    if (!el || !node.data.trim() || !vis(el) || el.closest('.notes, .speaker-notes, script, style, .sr-only, .visually-hidden')) continue
    const re = /[\p{L}\p{N}][\p{L}\p{N}'’]*/gu
    let m
    while ((m = re.exec(node.data))) {
      const r = document.createRange(); r.setStart(node, m.index); r.setEnd(node, m.index + m[0].length)
      const rects = [...r.getClientRects()].filter((x) => x.width > 0.5 && x.height > 0.5)
      if (!rects.length) continue
      words.push({ w: m[0], el, rects, block: el.closest('li, p, h1, h2, h3, h4, figcaption, td, th, .label, [class*=label], div') })
    }
  }
  const broken = words.filter((x) => x.rects.length > 1 && Math.abs(x.rects[0].top - x.rects[1].top) > 2).map((x) => x.w)
  const overlaps = []
  for (let i = 0; i < words.length; i++) for (let j = i + 1; j < words.length; j++) {
    const a = words[i], b = words[j]
    if (a.block === b.block) continue
    const ra = a.rects[0], rb = b.rects[0]
    const ix = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), iy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
    if (ix > 2 && iy > 2 && ix * iy > 0.25 * Math.min(ra.width * ra.height, rb.width * rb.height)) overlaps.push(`${a.w}×${b.w}`)
    if (overlaps.length > 20) break
  }
  const clipped = (x) => { for (let a = x.el.parentElement; a && a !== slide; a = a.parentElement) { const o = getComputedStyle(a); if (/(hidden|auto|scroll|clip)/.test(o.overflow + o.overflowY)) { const ar = a.getBoundingClientRect(); const r = x.rects[0]; if (r.bottom <= ar.top + 1 || r.top >= ar.bottom - 1 || r.right <= ar.left + 1 || r.left >= ar.right - 1) return true } } return false }
  const outside = words.filter((x) => !clipped(x) && x.rects.some((r) => r.right > sr.right + 1 || r.bottom > sr.bottom + 1 || r.left < sr.left - 1 || r.top < sr.top - 1)).map((x) => x.w)
  const timer = document.querySelector('.section-timer-float')
  return {
    id: slide.dataset.id, hash: location.hash, layout: slide.dataset.layout, hiddenUnits, lead: slide.dataset.lead || null, section: slide.dataset.section || null, role: slide.dataset.role || null,
    // The step state as the deck keeps it: each step element's data-mode-state, first letter (hidden, current,
    // soft, full), in order; with the carousel's active card this is the same in every window showing the deck.
    modes: [...slide.querySelectorAll('[data-mode-state]')].map((e) => ({ hidden: 'h', current: 'c', soft: 's', full: 'f', fuzzy: 'z' })[e.dataset.modeState] || '?').join(''),
    words: words.length,
    // The step state as drawn: every element's class and data-state inside the slide (focus stops change
    // emphasis, not visibility), reduced to a short checksum.
    stepSig: (() => { let h = 0; for (const el of all) { const t = String(el.className?.baseVal ?? el.className) + '|' + (el.dataset?.state || '') + '|' + getComputedStyle(el).opacity; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0 } return h })(),
    cards: cards.length, activeCard, dots: dots.length, activeDot, gallery: !!gallery,
    broken: [...new Set(broken)].slice(0, 20), overlaps: overlaps.slice(0, 20), outside: [...new Set(outside)].slice(0, 20),
    timer: timer ? { text: timer.textContent.trim(), visible: vis(timer) && timer.getBoundingClientRect().width > 0 } : null,
    text: slide.innerText.replace(/\s+/g, ' ').slice(0, 160),
  }
}

let app, main
try {
  ;({ app, main } = await launch(userData))
  const errors = []
  main.on('pageerror', (e) => errors.push('main: ' + e.message))
  await size(main)
  await pause(2500)

  // ── 1. Open and edit ───────────────────────────────────────────────────────────────────────────
  if (only.includes('1')) await step('1 open-edit', async () => {
    const s0 = await shot(main, 'start-empty-profile')
    const body0 = await main.locator('body').innerText()
    record('open.lists-talk', body0.includes(TITLE) && body0.includes('Winter walks'), body0.slice(0, 200).replace(/\s+/g, ' '), s0)
    await openTalkByTitle(main, TITLE)
    await pause(2500)
    const s1 = await shot(main, 'talk-open')
    const editorText = await main.locator('.cm-content').first().innerText().catch(() => '')
    record('open.editor', editorText.includes('Every walk starts with') && editorText.includes('From first idea to the walk itself'), `editor shows ${editorText.length} characters; head: ${editorText.slice(0, 80).replace(/\s+/g, ' ')}`, s1)
    // Inspector preview: the stage counter "N / M" follows Next, one slide per press.
    const counter = () => main.evaluate(() => { const t = document.body.innerText.match(/(\d+)\s*\/\s*(\d+)/); return t ? { n: Number(t[1]), of: Number(t[2]) } : null })
    const c0 = await counter()
    const nextBtn = main.getByRole('button', { name: 'Next slide', exact: true }).first()
    for (let i = 0; i < 3; i++) { await nextBtn.click(); await pause(500) }
    const c1 = await counter()
    const s2 = await shot(main, 'inspector-preview-slide4')
    record('open.preview-steps', !!c0 && !!c1 && c0.of === EXPECTED_SLIDES && c1.of === EXPECTED_SLIDES && c1.n === c0.n + 3, `${JSON.stringify(c0)} → ${JSON.stringify(c1)}; the deck has ${EXPECTED_SLIDES} slides`, s2, { c0, c1 })
    // Grid view: one cell per slide; scrolled into view, each cell draws its picture (cells off screen wait).
    await main.getByTestId('grid-toggle').click(); await pause(1500)
    const s3 = await shot(main, 'grid-view')
    const cellIndexes = await main.evaluate(() => [...new Set([...document.querySelectorAll('.grid-cell[data-slide-index]')].map((c) => c.dataset.slideIndex))])
    const unpictured = []
    for (const idx of cellIndexes) {
      let ok = false
      for (let i = 0; i < 20 && !ok; i++) {
        ok = await main.evaluate((idx) => { const c = document.querySelector(`.grid-cell[data-slide-index="${idx}"]`); if (!c) return false; c.scrollIntoView({ block: 'center' }); return [...c.querySelectorAll('img, canvas, iframe')].some((m) => (m.tagName !== 'IMG' || (m.complete && m.naturalWidth > 0)) && m.getBoundingClientRect().width > 20) }, idx)
        if (!ok) await pause(250)
      }
      if (!ok) unpictured.push(idx)
    }
    const grid = { cells: cellIndexes.length, unpictured }
    record('open.grid', grid.cells === EXPECTED_SLIDES && unpictured.length === 0, `${grid.cells} cells (${EXPECTED_SLIDES} slides in the deck); without a picture after 5 s in view: ${unpictured.join(',') || 'none'}`, s3, grid)
    await main.getByTestId('slides-toggle').click(); await pause(800)
    // The Slide Browser (⌘S): the other talk's slides, with no help from the harness.
    await main.locator('.cm-content').first().click(); await pause(300)
    await main.keyboard.press('Meta+s'); await pause(2500)
    const lt = await main.locator('.lt-browser-root').count()
    let cards = 0
    for (let i = 0; i < 30 && !cards; i++) { cards = await main.locator('.lt-card:not(.skeleton)').count(); if (!cards) await pause(500) }
    const head = (await main.locator('.lt-browser-root').innerText().catch(() => '')).replace(/\s+/g, ' ')
    const stated = Number(head.match(/(\d+) slides/)?.[1] ?? NaN)
    const s4 = await shot(main, 'slide-browser')
    // Winter walks: its title slide, two section dividers and two slides.
    record('open.slide-browser', lt === 1 && cards === 5 && stated === 5, `browser=${lt} cards=${cards} stated=${stated}; head: ${head.slice(0, 80)}`, s4, { lt, cards, stated })
    await main.keyboard.press('Escape'); await pause(500)
    if (await main.locator('.lt-browser-root').count()) { await main.keyboard.press('Escape'); await pause(500) }
    // Edit a line in the Plain editor: it must reach the disk and the preview.
    const line = main.locator('.cm-line', { hasText: 'Every walk starts with' }).first()
    await line.scrollIntoViewIfNeeded(); await line.click(); await pause(400)
    await main.keyboard.press('End')
    await main.keyboard.type(' Bring a flask of tea.', { delay: 25 })
    let disk = false, inPreview = false
    for (let i = 0; i < 30 && !(disk && inPreview); i++) {
      disk = readFileSync(outlinePath, 'utf8').includes('Bring a flask of tea.')
      if (!inPreview) for (const f of main.frames()) { try { if (await f.evaluate(() => document.body?.innerText.includes('Bring a flask of tea'))) inPreview = true } catch {} }
      if (!(disk && inPreview)) await pause(500)
    }
    const s5 = await shot(main, 'edited-line-preview')
    record('open.edit-saved-and-previewed', disk && inPreview, `saved to disk=${disk}; in the preview=${inPreview}${disk && inPreview ? '' : ` (${[!disk && 'not saved to disk', !inPreview && 'not in the preview'].filter(Boolean).join(', ')} after 15 s)`}`, s5, { disk, inPreview })
    // The Talk tab: its fields hold the talk's title, subtitle and author (field values, visible on screen;
    // the editor's own "Talk details" line repeats the words, so page text proves nothing).
    const fieldValues = () => main.evaluate(() => [...document.querySelectorAll('input, textarea')].filter((i) => i.getBoundingClientRect().width > 0 && i.offsetParent !== null).map((i) => i.value))
    const valuesBefore = await fieldValues()
    await main.locator('.rc-tab-btn', { hasText: 'Talk' }).first().click(); await pause(1200)
    const talkTab = await main.locator('body').innerText()
    const valuesAfter = await fieldValues()
    const s6 = await shot(main, 'talk-tab')
    const wants = [TITLE, 'A guide for the volunteer walking group', 'Sample presenter']
    const shows = wants.filter((t) => valuesAfter.includes(t) && !valuesBefore.includes(t))
    record('open.talk-tab', shows.length === wants.length, `fields that appeared with the tab holding the talk's values: ${shows.join(', ') || 'none'}`, s6, { shows })
    writeFileSync(join(out, 'talk-tab.txt'), talkTab)
    // For the guide: the Talk tab at its Section colours control.
    const sc = main.getByText('Section colours', { exact: true }).first()
    const scVisible = (await sc.count()) > 0 && await sc.isVisible().catch(() => false)
    if (scVisible) {
      await sc.evaluate((el) => el.scrollIntoView({ block: 'start' })); await pause(800)
      await main.screenshot({ path: join(GUIDE, 'talk-tab-section-colours.png') })
    }
    record('open.section-colours-control', scVisible, scVisible ? 'guide picture taken' : 'no visible "Section colours" label in the Talk tab', scVisible ? rel(join(GUIDE, 'talk-tab-section-colours.png')) : '')
    await main.locator('.rc-tab-btn', { hasText: 'Inspector' }).first().click(); await pause(500)
  })

  // ── 2. Present ─────────────────────────────────────────────────────────────────────────────────
  let presenter, audience
  if (only.includes('2') || only.includes('3')) await step('2 present', async () => {
    if (!(await main.locator('.cm-content').count())) { await openTalkByTitle(main, TITLE); await pause(1500) }
    const known = new Set(app.windows())
    await main.locator('[data-command="present-presenter"]').first().click()
    const newWin = async (ms) => { for (let i = 0; i < ms / 250; i++) { const w = app.windows().find((x) => !known.has(x) && !x.isClosed()); if (w) return w; await pause(250) } return null }
    presenter = await newWin(30000)
    if (presenter) record('present.presenter-opens', true, 'opened from the action bar')
    else {
      const s = await shot(main, 'presenter-did-not-open')
      record('present.presenter-opens', false, 'no window within 30 s; ' + (await main.locator('body').innerText()).slice(-300).replace(/\s+/g, ' '), s)
      await main.locator('button.toolbar-btn', { hasText: 'Present' }).first().click(); await pause(800)
      await shot(main, 'present-menu')
      writeFileSync(join(out, 'present-menu.txt'), await main.locator('body').innerText())
      const item = main.getByRole('menuitem').filter({ hasText: /Presenter/ }).first()
      if (await item.count()) await item.click(); else await main.keyboard.press('Escape')
      presenter = await newWin(40000)
    }
    if (!presenter) throw new Error('no presenter window from the action bar or the Present menu')
    presenter.on('pageerror', (e) => errors.push('presenter: ' + e.message))
    await presenter.waitForLoadState('domcontentloaded')
    await presenter.waitForSelector('#currentPreview iframe', { timeout: 30000 })
    if (await presenter.locator('#twResume:not([hidden])').count().catch(() => 0)) await presenter.locator('#twResumeNo').click().catch(() => {})
    known.add(presenter)
    // "Presenter view" is "Open presenter and audience": the audience window may already be open.
    const audienceWin = async (ms) => { for (let i = 0; i < ms / 250; i++) { const w = app.windows().find((x) => !x.isClosed() && x.url().includes('audience=1')); if (w) return w; await pause(250) } return null }
    audience = await audienceWin(8000)
    let how = 'opened with the presenter'
    if (!audience) { await presenter.keyboard.press('F5'); audience = await audienceWin(10000); how = 'opened by F5 in the presenter' }
    record('present.audience-opens', !!audience, audience ? how : 'no audience window with the presenter or after F5')
    if (!audience) throw new Error('no audience window')
    audience.on('pageerror', (e) => errors.push('audience: ' + e.message))
    await audience.waitForLoadState('domcontentloaded')
    await winCall(app, 'presenter=1', 'w.setBounds({ x: 0, y: 0, width: 1440, height: 900 }); w.showInactive(); return w.getBounds()')
    await winCall(app, 'audience=1', 'w.setBounds({ x: 60, y: 60, width: 1280, height: 720 }); w.showInactive(); return w.getBounds()')
    await pause(2500)
    // For the guide: the idle presenter at 1440×900 with the capture choice showing (no notice yet).
    await size(presenter, 1440, 900); await pause(1000)
    const capVisible = await presenter.locator('#twrec-capture').isVisible().catch(() => false)
    await presenter.screenshot({ path: join(GUIDE, 'presenter-idle-1440.png') })
    const barBox = await presenter.evaluate(() => { const m = document.querySelector('#twrec-module'); let el = m; while (el && el.parentElement && el.getBoundingClientRect().width < innerWidth * 0.9) el = el.parentElement; const r = (el || m)?.getBoundingClientRect(); return r ? { x: 0, y: 0, width: innerWidth, height: Math.ceil(r.bottom + 6) } : null })
    if (barBox) await presenter.screenshot({ path: join(GUIDE, 'presenter-idle-bar-1440.png'), clip: barBox })
    record('present.idle-capture-choice', capVisible, `capture choice visible=${capVisible}; bar ${JSON.stringify(barBox)}`, rel(join(GUIDE, 'presenter-idle-bar-1440.png')))
    await shot(presenter, 'presenter-open')
  })
  if (only.includes('2') && presenter) await step('2 present', async () => {
    const auDir = join(out, 'audience'); mkdirSync(auDir, { recursive: true })
    const prevFrame = async () => (await presenter.$('#currentPreview iframe'))?.contentFrame()
    // The trail a presenter should walk: every slide of the deck in order, and on each slide every step the
    // outline gives it (talk.mjs: STEP_SLIDES and the carousel's cards). A state is slide id, step signature,
    // active card.
    const deck = await audience.evaluate(() => [...document.querySelectorAll('.slide')].map((s) => ({ id: s.dataset.id, cards: s.querySelectorAll('.card').length, gallery: !!s.querySelector('.card-gallery, .gallery') })))
    const keyOf = (x) => `${x.id}|${x.modes ?? ''}|${x.activeCard ?? -1}`
    const expectedTrail = deck.flatMap((d) => d.id === 'carousel' ? Array.from({ length: CAROUSEL_CARDS }, (_, k) => `carousel||${k}`) : (expectedSteps(d.id) || ['']).map((m) => `${d.id}|${m}|-1`))
    const visited = []
    const states = []
    const mismatches = []
    const legibility = []
    const seen = new Set()
    const probeBoth = async (label, i) => {
      const a = await audience.evaluate(PROBE)
      const pf = await prevFrame()
      const p = pf ? await pf.evaluate(PROBE).catch((e) => ({ err: String(e) })) : { err: 'no preview frame' }
      const ph = await presenter.evaluate(() => location.hash)
      states.push({ dir: label, i, presenterHash: ph, audience: a, preview: { id: p.id, modes: p.modes, hiddenUnits: p.hiddenUnits, activeCard: p.activeCard, activeDot: p.activeDot, err: p.err } })
      if (p.err || keyOf(p) !== keyOf(a)) {
        mismatches.push({ dir: label, i, audience: keyOf(a), presenterPreview: p.err || keyOf(p) })
        // Evidence: both windows as drawn, for the first few differences.
        if (mismatches.length <= 6) { const tag = `mismatch-${label}-${i}-${a.id}`; await capturePage(app, 'audience=1', join(auDir, `${tag}-audience.png`)); await capturePage(app, 'presenter=1', join(auDir, `${tag}-presenter.png`)) }
      }
      if (!a.words || a.broken?.length || a.overlaps?.length || a.outside?.length) legibility.push({ id: a.id, step: i, words: a.words, broken: a.broken, overlaps: a.overlaps, outside: a.outside })
      if (label === 'forward' && !seen.has(keyOf(a))) {
        seen.add(keyOf(a))
        const n = String(states.length).padStart(3, '0')
        await capturePage(app, 'audience=1', join(auDir, `${n}-${a.id}-m${a.modes || '0'}-c${a.activeCard}.png`))
        if (!visited.includes(a.id)) { visited.push(a.id); await presenter.screenshot({ path: join(auDir, `${n}-${a.id}-presenter.png`) }).catch(() => {}) }
      }
      return a
    }
    // After a press, wait (bounded) for the state the trail expects: the audience on it, the presenter's preview
    // showing the same, no finite animation running in the active slide in either window, and the audience slide's
    // layout unchanged for 300 ms (a mind map lays itself out by script). Past the end of the trail: the same,
    // without an expected state. A state not reached in 4 s is probed as it is (and the checks say so).
    const KEY_PROBE = () => { const s = document.querySelector('.slide.active'); if (!s) return { key: null, moving: false }; const cards = [...s.querySelectorAll('.card')]; return { key: `${s.dataset.id}|${[...s.querySelectorAll('[data-mode-state]')].map((e) => ({ hidden: 'h', current: 'c', soft: 's', full: 'f', fuzzy: 'z' })[e.dataset.modeState] || '?').join('')}|${cards.findIndex((c) => c.classList.contains('active-card'))}`, moving: s.getAnimations({ subtree: true }).some((a) => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming?.().endTime)), geo: (() => { let h = 0; for (const el of s.querySelectorAll('*')) { const r = el.getBoundingClientRect(); for (const v of [r.x, r.y, r.width, r.height]) h = (h * 31 + Math.round(v)) | 0 } return h })() } }
    const settle = async (want) => {
      const t0 = Date.now()
      let last = null, since = Date.now()
      while (Date.now() - t0 < 4000) {
        const a = await audience.evaluate(KEY_PROBE).catch(() => ({ key: null }))
        const pf = await prevFrame()
        const p = pf ? await pf.evaluate(KEY_PROBE).catch(() => ({ key: null })) : { key: null }
        const both = `${a.key}/${p.key}/${a.geo}`
        if (both !== last) { last = both; since = Date.now() }
        const still = !a.moving && !p.moving && a.key !== null && a.key === p.key && Date.now() - since >= 300
        if (still && (want === undefined || a.key === want)) return true
        await pause(60)
      }
      return false
    }
    // Walk until the state stops changing (three presses with no change at the end of the deck).
    const walk = async (key, label, max, want) => {
      await settle(want[0])
      const trail = [keyOf(await probeBoth(label, 0))]
      let same = 0
      for (let i = 1; i <= max && same < 3; i++) {
        await presenter.keyboard.press(key)
        await settle(want[i])
        const k = keyOf(await probeBoth(label, i))
        if (k === trail.at(-1)) same++; else same = 0
        trail.push(k)
      }
      while (trail.length > 1 && trail.at(-1) === trail.at(-2)) trail.pop()
      return trail
    }
    const firstDiff = (got, want) => { const i = got.findIndex((g, j) => g !== want[j]); const at = i < 0 ? Math.min(got.length, want.length) : i; return `${got.length} states walked, ${want.length} expected; first difference at ${at}: got ${got[at] ?? '(end)'}, expected ${want[at] ?? '(end)'}` }
    const fwd = await walk('ArrowRight', 'forward', 140, expectedTrail)
    const back = await walk('ArrowLeft', 'back', 140, [...expectedTrail].reverse())
    writeJson(join(out, 'present-states.json'), { expectedTrail, forward: fwd, back, states, mismatches, legibility, errors })
    const deckOk = deck.length === EXPECTED_SLIDES && SLIDE_IDS.every((id) => deck.some((d) => d.id === id))
    record('present.walk-forward', deckOk && JSON.stringify(fwd) === JSON.stringify(expectedTrail), `deck ${deck.length} slides; ${JSON.stringify(fwd) === JSON.stringify(expectedTrail) ? `${fwd.length} states in order` : firstDiff(fwd, expectedTrail)}`, rel(auDir), { deckSlides: deck.length, walked: fwd.length, expected: expectedTrail.length })
    const backWant = [...expectedTrail].reverse()
    record('present.walk-back', deckOk && JSON.stringify(back) === JSON.stringify(backWant), JSON.stringify(back) === JSON.stringify(backWant) ? `${back.length} states in reverse order, back at ${back.at(-1)}` : firstDiff(back, backWant), '', { walked: back.length, expected: backWant.length })
    record('present.audience-matches-presenter', states.length >= 2 * expectedTrail.length && mismatches.length === 0, mismatches.length ? `${mismatches.length} differences; first ${JSON.stringify(mismatches.slice(0, 4))}` : `${states.length} states compared (slide, step signature, card)`, rel(join(out, 'present-states.json')), { compared: states.length, mismatches: mismatches.length })
    // Carousel: cards and dots.
    const car = states.filter((s) => s.dir === 'forward' && s.audience.id === 'carousel').map((s) => s.audience)
    const cardsSeen = [...new Set(car.map((s) => s.activeCard))].filter((x) => x >= 0).sort()
    const dotsFollow = car.length > 0 && car.every((s) => s.dots === CAROUSEL_CARDS && s.activeDot === s.activeCard)
    record('present.carousel', car.length > 0 && car[0].cards === CAROUSEL_CARDS && cardsSeen.length === CAROUSEL_CARDS && dotsFollow, `cards=${car[0]?.cards} dots=${car[0]?.dots} active cards seen=${cardsSeen.join(',')} dots follow=${dotsFollow}`)
    // Legibility of the loop and the step slide (and every other slide), at every state walked.
    const legLoopSteps = legibility.filter((l) => ['loop', 'steps'].includes(l.id))
    const loopStepStates = states.filter((s) => ['loop', 'steps'].includes(s.audience.id)).length
    record('present.legible-loop-steps', loopStepStates > 0 && legLoopSteps.length === 0, legLoopSteps.length ? JSON.stringify(legLoopSteps.slice(0, 3)) : `clean at ${loopStepStates} states`)
    const legOther = legibility.filter((l) => !['loop', 'steps'].includes(l.id))
    record('present.legible-other', states.length > 0 && legOther.length === 0, legOther.length ? JSON.stringify([...new Map(legOther.map((l) => [l.id, l])).values()].slice(0, 6)) : `clean at ${states.length - loopStepStates} states`)
    // Timer: the first section carries {timer=4m}{timer-audience}.
    const sec1 = deck.length > 1 ? (await audience.evaluate(() => document.querySelectorAll('.slide')[1]?.dataset.section || null)) : null
    const inSec1 = states.filter((s) => sec1 && s.audience.section === sec1)
    const timerMissing = inSec1.filter((s) => !s.audience.timer?.visible).map((s) => `${s.audience.id}@${s.dir}${s.i}`)
    record('present.timer-in-section', inSec1.length > 0 && timerMissing.length === 0, `${inSec1.length} states in section ${sec1}; no timer on ${timerMissing.slice(0, 6).join(', ') || 'none'}`, '', { states: inSec1.length, missing: timerMissing.length })
    const leak = states.filter((s) => s.audience.timer?.visible && s.audience.section !== sec1).map((s) => s.audience.id)
    record('present.timer-not-outside', !!sec1 && leak.length === 0, leak.length ? `shown on ${[...new Set(leak)].join(',')}` : 'not shown outside the first section')
    record('present.no-page-errors', errors.length === 0, errors.slice(0, 5).join(' | '))
    // Section colours: one lead per section, rotating, with the two overrides. Every slide must carry its lead.
    const leads = {}
    const noLead = states.filter((s) => s.audience.section && !s.audience.lead).map((s) => s.audience.id)
    for (const st of states) if (st.audience.section && st.audience.lead) (leads[st.audience.section] ||= new Set()).add(st.audience.lead)
    // Sections in the order they are shown (their ids are generated; the order is the talk's).
    const order = []; for (const st of states) if (st.dir === 'forward' && st.audience.section && !order.includes(st.audience.section)) order.push(st.audience.section)
    const NAMES = ['before-the-walk', 'on-the-path', 'along-the-river', 'tools-for-the-group', 'after-the-walk']
    const leadOf = Object.fromEntries(order.map((sec, i) => [NAMES[i] ?? sec, [...leads[sec] || []].join('/')]))
    const want = { 'before-the-walk': 'blue', 'on-the-path': SECTION_OVERRIDES['on-the-path'], 'along-the-river': 'light', 'tools-for-the-group': SECTION_OVERRIDES['tools-for-the-group'], 'after-the-walk': 'light-amber' }
    const leadsOk = order.length === NAMES.length && noLead.length === 0 && Object.entries(want).every(([k, v]) => leadOf[k] === v)
    record('present.section-leads', leadsOk, `shown ${JSON.stringify(leadOf)}; expected ${JSON.stringify(want)}; slides without a lead: ${[...new Set(noLead)].join(',') || 'none'}`, rel(join(out, 'audience')), { leadOf, noLead: [...new Set(noLead)] })
    // The presenter at 1280 px wide (known fault: the status bar collapses too far; could-not-allowed.mjs).
    await winCall(app, 'presenter=1', 'w.setBounds({ x: 0, y: 0, width: 1280, height: 800 }); return w.getBounds()'); await size(presenter, 1280, 800); await pause(1200)
    const bar = await presenter.evaluate(() => ({ items: [...document.querySelectorAll('.tw-st')].map((e) => ({ t: e.textContent.trim().slice(0, 20), w: Math.round(e.getBoundingClientRect().width) })) }))
    // Passes when every item keeps its width; the tracked collapse is a COULD-NOT only inside its bounds
    // (could-not-allowed.mjs: recording and live items shown with their words, every tool in the bar); else FAIL.
    const barClean = statusBarMeasured(bar) && bar.items.every((i) => i.w > 0)
    record('present.status-bar-1280', barClean ? true : statusBarKnownCollapse(bar) ? null : false, JSON.stringify(bar).slice(0, 600), await shot(presenter, 'presenter-1280'), bar)
    await winCall(app, 'presenter=1', 'w.setBounds({ x: 0, y: 0, width: 1440, height: 900 }); return w.getBounds()'); await size(presenter, 1440, 900); await pause(600)
  })
  // The long handout address on the title and closing slides, and the mind map's drawn size (PR 385).
  if (only.includes('2') && presenter) await step('2 present', async () => {
    const FULL = 'walks.example.org/handouts/planning-a-river-walk-for-volunteers'
    for (const id of ['deck-title', 'deck-thanks']) {
      await presenter.evaluate((id) => { location.hash = id }, id); await pause(2000)
      const q = await audience.evaluate(() => {
        const cap = document.querySelector('.slide.active .qr-caption'); if (!cap) return { active: document.querySelector('.slide.active')?.dataset.id ?? null, caption: false }
        const r = cap.getBoundingClientRect(), sr = document.querySelector('.slide.active').getBoundingClientRect(), c = getComputedStyle(cap)
        const lines = new Set(); const range = document.createRange(); range.selectNodeContents(cap); for (const x of range.getClientRects()) if (x.width > 0.5) lines.add(Math.round(x.top))
        let clippedBy = null; for (let a = cap; a && !a.classList.contains('slide'); a = a.parentElement) { const ar = a.getBoundingClientRect(); const o = getComputedStyle(a); if (/(hidden|clip)/.test(o.overflow + o.overflowX + o.overflowY) && (r.bottom > ar.bottom + 1 || r.right > ar.right + 1)) { clippedBy = a.className.toString().slice(0, 40); break } }
        return { active: document.querySelector('.slide.active').dataset.id, text: cap.innerText.replace(/\s+/g, ''), lines: lines.size, overflow: cap.scrollWidth > cap.clientWidth + 1 || cap.scrollHeight > cap.clientHeight + 1, ellipsis: /…/.test(cap.innerText) || c.textOverflow === 'ellipsis' && cap.scrollWidth > cap.clientWidth, insideSlide: r.right <= sr.right + 1 && r.bottom <= sr.bottom + 1, clippedBy }
      })
      const file = join(out, `address-${id}.png`); await capturePage(app, 'audience=1', file)
      record(id === 'deck-title' ? 'present.qr-title' : 'present.qr-closing', q.active === id && q.text === FULL && !q.overflow && !q.ellipsis && q.insideSlide && !q.clippedBy, JSON.stringify(q), rel(file))
    }
    await presenter.evaluate(() => { location.hash = 'mindmap' }); await pause(2500)
    const mm = await audience.evaluate(() => {
      const s = document.querySelector('.slide.active'); const content = s.querySelector('.slide-content') || s
      const svg = [...s.querySelectorAll('svg')].sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0]
      const g = svg?.querySelector('g'); const drawn = (g || svg)?.getBoundingClientRect(); const cr = content.getBoundingClientRect(), sv = svg?.getBoundingClientRect()
      return drawn ? { active: s.dataset.id, content: [Math.round(cr.width), Math.round(cr.height)], svg: [Math.round(sv.width), Math.round(sv.height)], drawn: [Math.round(drawn.width), Math.round(drawn.height)], widthShare: +(drawn.width / cr.width).toFixed(2), heightShare: +(drawn.height / cr.height).toFixed(2) } : null
    })
    const mmFile = join(out, 'mindmap-audience.png'); await capturePage(app, 'audience=1', mmFile)
    record('present.mindmap-size', !!mm && mm.active === 'mindmap' && Math.max(mm.widthShare, mm.heightShare) >= 0.8, JSON.stringify(mm), rel(mmFile))
  })
  // The widget, in the audience window, without going full screen: its colour where the window composites the frame.
  if (only.includes('2') && presenter) await step('2 present', async () => {
    await presenter.evaluate(() => { location.hash = 'widget' }); await pause(3000)
    const file = join(out, 'audience-widget.png')
    await capturePage(app, 'audience=1', file)
    const info = await audience.evaluate(() => {
      const f = document.querySelector('.slide.active iframe'); if (!f) return null
      const r = f.getBoundingClientRect(); return { active: document.querySelector('.slide.active').dataset.id, x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, iw: innerWidth, full: document.querySelector('.slide.active')?.classList.contains('embed-full-screen') }
    })
    // Share of the frame (inset 10% each side) in the widget's colour. A single centre pixel can land on the
    // widget's own centred text (it once hit the colon of "Walkers: 8") and read white while the widget shows.
    let share = null
    if (info) {
      const sharp = (await import('sharp')).default
      const img = sharp(readFileSync(file)); const meta = await img.metadata(); const scale = meta.width / info.iw
      const w = Math.max(1, Math.round(info.w * 0.8 * scale)), h = Math.max(1, Math.round(info.h * 0.8 * scale))
      const left = Math.max(0, Math.round((info.x - info.w * 0.4) * scale)), top = Math.max(0, Math.round((info.y - info.h * 0.4) * scale))
      const { data, info: raw } = await img.extract({ left, top, width: Math.min(w, meta.width - left), height: Math.min(h, meta.height - top) }).raw().toBuffer({ resolveWithObject: true })
      let match = 0, total = 0
      for (let i = 0; i < data.length; i += raw.channels) { total++; if (Math.abs(data[i] - 30) < 25 && Math.abs(data[i + 1] - 110) < 25 && Math.abs(data[i + 2] - 160) < 25) match++ }
      share = total ? +(match / total).toFixed(3) : 0
    }
    const ok = share !== null && info.active === 'widget' && !info.full && share >= 0.6
    record('present.widget-visible', ok, `frame=${JSON.stringify(info)} share of the frame in the widget colour rgb(30,110,160)=${share} (needs 0.6)`, rel(file))
  })

  // ── 3. Print ────────────────────────────────────────────────────────────────────────────────────
  // The presenter's Print button calls window.print(), which opens macOS's print dialog (not drivable).
  // The app's own print path is therefore taken with webContents.printToPDF on the real presenter window,
  // which runs the same beforeprint/afterprint arrangement as "Save as PDF" in that dialog.
  if (only.includes('3') && presenter) await step('3 print', async () => {
    const pdfInfo = (f) => { const t = execFileSync('pdfinfo', [f], { encoding: 'utf8' }); return { pages: Number(t.match(/Pages:\s+(\d+)/)[1]), size: t.match(/Page size:\s+([^\n]+)/)[1] } }
    const pdfText = (f, n) => execFileSync('pdftotext', ['-layout', '-f', String(n), '-l', String(n), f, '-'], { encoding: 'utf8' })
    const printOnce = async (name) => {
      const before = await presenter.evaluate(() => location.hash)
      const b64 = await winCall(app, 'presenter=1', 'return w.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true }).then((b) => b.toString("base64"))')
      const file = join(out, name + '.pdf'); writeFileSync(file, Buffer.from(b64, 'base64'))
      return { file, before }
    }
    // The deck as the audience window holds it: its slides, and the pages a print should give (one per slide,
    // one per card on a carousel). A count that cannot be read fails the check below.
    const deckCount = await audience.evaluate(() => { const sl = [...document.querySelectorAll('.slide')]; return { slides: sl.length, pages: sl.reduce((n, s) => n + (s.querySelector('.card-gallery, .gallery') ? Math.max(1, s.querySelectorAll('.card').length) : 1), 0) } })
    await presenter.evaluate(() => { location.hash = 'loop' }); await pause(1500)
    const p1 = await printOnce('deck-print-1')
    // Known fault being fixed: printing while a simulation slide is part-way leaves it scrolled wrongly.
    await presenter.evaluate(() => { location.hash = 'sim' }); await pause(1500)
    // Step through the chat until it scrolls (or its steps run out), staying on the slide.
    const simState = () => audience.evaluate(() => {
      const s = document.querySelector('.slide.active'); const parts = [...s.querySelectorAll('.sim-step')]
      const shown = parts.filter((e) => getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).opacity !== '0').length
      const first = s.querySelector('.sim-part, .sim-step'); let box = first?.parentElement
      while (box && box !== s && !/(auto|scroll|hidden)/.test(getComputedStyle(box).overflowY)) box = box.parentElement
      const offset = first && box ? Math.round(first.getBoundingClientRect().top - box.getBoundingClientRect().top) : null
      return { id: s.dataset.id, stepsShown: shown, steps: parts.length, firstOffset: offset, scrolled: offset !== null && offset < 0 }
    })
    let simSteps = 0
    for (; simSteps < 30; simSteps++) { const st = await simState(); if (st.scrolled && st.stepsShown < st.steps - 2) break; await presenter.keyboard.press('ArrowRight'); await pause(1200); if ((await simState()).id !== 'sim') { await presenter.keyboard.press('ArrowLeft'); await pause(1200); break } }
    await pause(2500)
    const simBefore = await simState()
    await capturePage(app, 'audience=1', join(out, 'sim-before-print.png'))
    const pSim = await printOnce('deck-print-sim-partway')
    await pause(1200)
    const simAfter = await simState()
    await capturePage(app, 'audience=1', join(out, 'sim-after-print.png'))
    const simShot = await shot(presenter, 'presenter-sim-after-print')
    execFileSync('pdftoppm', ['-r', '40', '-png', pSim.file, join(out, 'deck-print-sim-page')])
    record('print.sim-restored', simBefore.id === 'sim' && simBefore.scrolled && simBefore.stepsShown < simBefore.steps && JSON.stringify(simBefore) === JSON.stringify(simAfter), `${simSteps} presses; before ${JSON.stringify(simBefore)} after ${JSON.stringify(simAfter)}; pages ${pdfInfo(pSim.file).pages}; see sim-before-print.png, sim-after-print.png and the sim page of deck-print-sim-partway.pdf`, simShot)
    await presenter.evaluate(() => { location.hash = 'loop' }); await pause(1200)
    const i1 = pdfInfo(p1.file)
    execFileSync('pdftoppm', ['-r', '30', '-png', p1.file, join(out, 'deck-print-1-page')])
    const notesOnPages = [1, 2, 3, 4, 5].map((n) => pdfText(p1.file, n)).join('\n')
    await auditPdf(p1.file, 'presenter')
    let notesPage = 0
    for (let n = 1; n <= i1.pages && !notesPage; n++) if (/Open with the reason/.test(pdfText(p1.file, n))) { notesPage = n; execFileSync('pdftoppm', ['-r', '150', '-png', '-f', String(n), '-l', String(n), '-singlefile', p1.file, join(GUIDE, 'printed-page-with-notes')]) }
    record('print.notes-guide-page', notesPage > 0, notesPage ? `page ${notesPage}` : 'no page carries the first slide\'s notes', notesPage ? rel(join(GUIDE, 'printed-page-with-notes.png')) : '')
    record('print.one-page-per-slide', deckCount.slides === EXPECTED_SLIDES && deckCount.pages === EXPECTED_PRINT_PAGES && i1.pages === deckCount.pages, `pages=${i1.pages}; deck ${deckCount.slides} slides → ${deckCount.pages} pages expected (fixture: ${EXPECTED_SLIDES} slides, ${EXPECTED_PRINT_PAGES} pages); size=${i1.size}`, rel(p1.file), { pages: i1.pages, ...deckCount })
    record('print.notes', /Open with the reason/.test(notesOnPages), 'notes text found on first pages: ' + /Open with the reason/.test(notesOnPages))
    // Back to presenting: the screen layout intact.
    await pause(800)
    await presenter.keyboard.press('ArrowRight'); await pause(800); await presenter.keyboard.press('ArrowLeft'); await pause(800)
    const s1 = await shot(presenter, 'presenter-after-print')
    const layout = await presenter.evaluate(() => { const f = document.querySelector('#currentPreview'); const r = f?.getBoundingClientRect(); return { w: r?.width, h: r?.height, bodyPrint: document.body.className, hash: location.hash } })
    const aud = await audience.evaluate(PROBE)
    await capturePage(app, 'audience=1', join(out, 'audience-after-print.png'))
    record('print.layout-intact', layout.w > 300 && aud.id === 'loop' && !aud.outside.length && !aud.overlaps.length, `${JSON.stringify(layout)} audience=${aud.id} outside=${aud.outside.length} overlaps=${aud.overlaps.length}`, s1)
    const p2 = await printOnce('deck-print-2')
    const i2 = pdfInfo(p2.file)
    const allText = (f) => execFileSync('pdftotext', ['-raw', f, '-'], { encoding: 'utf8' }).replace(/\d/g, '#') // a running clock may differ
    const sameText = allText(p2.file) === allText(p1.file)
    record('print.repeat-same', i2.pages === i1.pages && i1.pages === deckCount.pages && sameText, `first=${i1.pages} second=${i2.pages}; same text=${sameText}`, rel(p2.file))
  })

  // ── 3b and 7. Share: the handout and the single-file presentation, built from the Share menu; then
  // page.pdf() on each in Playwright Chromium (step 3), and stepped through as a reader (step 7).
  if (only.includes('7')) await step('7 share', async () => {
    const htmlFiles = () => { const found = []; const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.html')) found.push(p) } }; walk(state); return found }
    const before = new Map(htmlFiles().map((f) => [f, statSync(f).mtimeMs]))
    const built = {}
    // The file each Share item writes: the talk's dist/<slug>-full.html and dist/<slug>-handout.html.
    const NAME = { presentation: /\/dist\/[^/]+-full\.html$/, handout: /\/dist\/[^/]+-handout\.html$/ }
    for (const [kind, rx] of [['presentation', /HTML presentation/], ['handout', /handout/i]]) {
      await main.locator('button.toolbar-btn', { hasText: 'Share' }).first().click(); await pause(700)
      const menuText = await main.locator('body').innerText()
      writeFileSync(join(out, `share-menu-${kind}.txt`), menuText)
      const sm = await shot(main, `share-menu-${kind}`)
      const item = main.locator('[role=menuitem], .tw-mi, button').filter({ hasText: rx }).filter({ hasNotText: /publish|Cloudflare|comments/i }).first()
      const offered = (await item.count()) > 0
      record(`share.offers-${kind}`, offered, offered ? (await item.innerText()).trim().slice(0, 80) : 'no matching item', sm)
      if (!offered) { await main.keyboard.press('Escape'); record(`share.builds-${kind}`, false, 'not offered'); continue }
      await item.click()
      let made = null
      for (let i = 0; i < 120 && !made; i++) { await pause(500); made = htmlFiles().find((f) => NAME[kind].test(f) && (!before.has(f) || statSync(f).mtimeMs > before.get(f))) || null }
      if (made) before.set(made, statSync(made).mtimeMs)
      record(`share.builds-${kind}`, !!made, made ? `${rel(made).replace(state, '<state>')} ${(statSync(made).size / 1024).toFixed(0)} KB` : `no new or updated ${NAME[kind]} in 60 s`, await shot(main, `shared-${kind}`))
      if (made) built[kind] = made
    }
    const browser = await launchChromium()
    try {
      for (const kind of ['presentation', 'handout']) {
        const file = built[kind]
        if (!file) {
          for (const id of [kind === 'presentation' ? 'share.presentation-steps' : 'share.handout-steps', ...(kind === 'handout' ? ['share.handout-no-notes'] : []), `print.saved-${kind}.qr-address`, `print.saved-${kind}.own-text`, `print.saved-${kind}.video-page`, `print.saved-${kind}.pages`]) record(id, false, `no ${kind} file was built`)
          continue
        }
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
        const errs = []; page.on('pageerror', (e) => errs.push(e.message))
        await page.goto('file://' + file); await pause(2500)
        const s0 = await shot(page, `${kind}-browser-open`)
        const seen = new Set()
        if (kind === 'presentation') {
          // Arrow keys until the last slide has been shown; every slide id of the file must be seen.
          const ids = await page.evaluate(() => [...document.querySelectorAll('.slide')].map((s) => s.dataset.id))
          for (let i = 0; i < 100 && seen.size < ids.length; i++) { seen.add(await page.evaluate(() => document.querySelector('.slide.active')?.dataset.id || null)); await page.keyboard.press('ArrowRight'); await pause(250) }
          await shot(page, `${kind}-browser-end`)
          const missing = ids.filter((id) => !seen.has(id))
          record('share.presentation-steps', ids.length === EXPECTED_SLIDES && missing.length === 0 && errs.length === 0, `${seen.size} slides seen of ${ids.length} in the file (fixture ${EXPECTED_SLIDES}); not seen: ${missing.join(',') || 'none'}; page errors: ${errs.slice(0, 3).join(' | ') || 'none'}`, s0, { slides: ids.length, missing })
        } else {
          // The handout is a page-per-slide viewer with an "N / M" counter: every N from 1 to M must be shown, and at
          // each N the slide on screen must be the deck's N-th (talk.mjs DECK: its id, or for a section divider its
          // section's title), drawn, with every picture in it loaded (waited for, up to 5 s).
          let t = '', total = null
          const wrong = []
          let pictures = 0
          const hasPictures = new Set(), drewPicture = new Set()
          for (let i = 0; i < 80; i++) {
            // The viewer's own counter: a visible leaf element reading exactly "N / M" (a carousel's "1/4" is not it).
            const look = () => page.evaluate(() => {
              const c = [...document.querySelectorAll('body *')].filter((e) => !e.children.length && /^\d+ \/ \d+$/.test(e.textContent.trim()) && e.getBoundingClientRect().width > 0).at(-1)
              const m = c?.textContent.trim().match(/^(\d+) \/ (\d+)$/)
              const shown = [...document.querySelectorAll('.slide')].filter((s) => { const r = s.getBoundingClientRect(), st = getComputedStyle(s); return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden' })
              const s = shown[0]
              const imgs = s ? [...s.querySelectorAll('img')] : []
              const drawn = (im) => { const r = im.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(im).visibility !== 'hidden' }
              return { n: m ? Number(m[1]) : null, of: m ? Number(m[2]) : null, text: document.body.innerText, shown: shown.length, id: s?.dataset.id ?? null, index: s ? Number(s.dataset.shareIndex) : null, heading: s ? s.innerText.replace(/\s+/g, ' ').trim().slice(0, 120) : '', w: s ? Math.round(s.getBoundingClientRect().width) : 0, imgs: imgs.map((im) => ({ src: (im.currentSrc || im.src || '').slice(0, 80), ok: im.complete && im.naturalWidth > 0, drawn: drawn(im) })) }
            })
            let r = await look()
            for (let k = 0; k < 25 && r.imgs.some((im) => !im.ok); k++) { await pause(200); r = await look() }
            if (r.n) {
              seen.add(r.n)
              const exp = DECK[r.n - 1]
              const isIt = !!exp && r.shown === 1 && r.w > 0 && r.index === r.n - 1 && (exp.id ? r.id === exp.id : !DECK.some((d) => d.id && d.id === r.id) && r.heading.includes(exp.section))
              // Every picture in the slide must have loaded, hidden ones too (a carousel's other cards), and a slide
              // that has pictures must draw at least one at some point while it is shown (a carousel can be on a
              // text card): a picture that vanished or shrank to nothing is a fault, not something to leave out.
              const broken = r.imgs.filter((im) => !im.ok)
              if (r.imgs.length) hasPictures.add(r.n)
              if (r.imgs.some((im) => im.drawn)) drewPicture.add(r.n)
              pictures += r.imgs.filter((im) => im.ok && im.drawn).length
              if (!isIt || broken.length) wrong.push(`${r.n}: ${exp ? (exp.id || `section "${exp.section}"`) : 'beyond the deck'} expected; shown ${r.shown} slide(s), id ${r.id}, index ${r.index}, "${r.heading.slice(0, 40)}"${broken.length ? `; pictures not loaded: ${broken.map((im) => im.src).join(', ')}` : ''}`)
            }
            if (r.of) total = r.of; t += ' ' + r.text
            if (total && seen.size >= total) break
            await page.keyboard.press('ArrowRight'); await pause(200)
          }
          const notSeen = total ? Array.from({ length: total }, (_, k) => k + 1).filter((n) => !seen.has(n)) : ['no counter']
          for (const n of hasPictures) if (!drewPicture.has(n)) wrong.push(`${n}: has pictures but none was drawn while it was shown`)
          record('share.handout-steps', total === EXPECTED_SLIDES && DECK.length === EXPECTED_SLIDES && notSeen.length === 0 && wrong.length === 0 && pictures > 0 && errs.length === 0, `counter total ${total} (deck ${EXPECTED_SLIDES}); not shown: ${notSeen.join(',') || 'none'}; wrong slide or picture at: ${wrong.slice(0, 4).join(' | ') || 'none'}; ${pictures} pictures loaded; page errors: ${errs.slice(0, 3).join(' | ') || 'none'}`, await shot(page, `${kind}-browser-end`), { total, notSeen, wrong: wrong.slice(0, 20), pictures })
          const notes = ['Five stops, long labels', 'Open with the reason the group exists', 'The long walk needs a second leader'].filter((n) => t.includes(n) || readFileSync(file, 'utf8').includes(n))
          record('share.handout-no-notes', notes.length === 0, notes.length ? `notes found: ${notes.join(' | ')}` : 'no speaker-note text in the page or the file')
        }
        // Step 3: page.pdf() on the saved file.
        const pdf = join(out, `${kind}-page-pdf.pdf`)
        await page.pdf({ path: pdf, printBackground: true, preferCSSPageSize: true })
        const info = execFileSync('pdfinfo', [pdf], { encoding: 'utf8' })
        const pages = Number(info.match(/Pages:\s+(\d+)/)?.[1] ?? NaN)
        execFileSync('pdftoppm', ['-r', '30', '-png', pdf, join(out, `${kind}-pdf-page`)])
        await auditPdf(pdf, `saved-${kind}`)
        record(`print.saved-${kind}.pages`, pages === EXPECTED_PRINT_PAGES, `pages=${pages}, expected ${EXPECTED_PRINT_PAGES} (one per slide, one per carousel card); size=${info.match(/Page size:\s+([^\n]+)/)?.[1]}`, rel(pdf), { pages })
        await page.close()
      }
    } finally { await browser.close() }
  })
} catch (e) {
  harness(String(e?.stack || e).slice(0, 900))
} finally {
  await closeApp(app)
  console.log('STATE', state)
}
