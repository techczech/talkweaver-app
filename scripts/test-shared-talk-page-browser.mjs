// Shared talk ticket 04 end to end: the colleague's page, built by the handout builder with the
// comments runtime, pushed to the SharedTalk worker under `wrangler dev`, and driven in headless
// Chromium. Covers the four item kinds, drafts across a reload, the offline queue with no
// duplicates, talk.updated re-rendering, statuses, thumbnails, and the 390px phone layout.
// Set TW_SHARED_TALK_SHOTS=<dir> to keep screenshots of each frame.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { startLiveWorker } from './lib/live-worker-harness.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'

const shotsDir = process.env.TW_SHARED_TALK_SHOTS || ''
if (shotsDir) await mkdir(shotsDir, { recursive: true })
const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-shared-page-'))
const { baseUrl, wsUrl, adminSecret, stop } = await startLiveWorker()
const browser = await chromium.launch({ headless: true })
const sockets = []

const TALK = 'AI and assessment workshop'
const baseSlides = [
  { title: 'Why assessment breaks first', bullets: ['Take-home essays were the first to go', 'Exams moved online in 2020 and stayed'] },
  { title: 'Three failure modes', bullets: ['Detection', 'Prohibition', 'Pretending nothing changed'] },
  { title: 'The rubric problem', bullets: ['Rubrics reward the features a model produces most fluently', 'Markers read for structure first', 'Every criterion we tightened made the pattern easier to match'] },
  { title: 'What we tried in Trinity term', bullets: ['Oral follow-ups on two essays per student', 'Marking time rose by about a third'] },
  { title: 'Close', bullets: ['One change you could make before Michaelmas'] },
]

function slideText(slide) { return `### ${slide.title}\n\n${slide.bullets.map((bullet) => `- ${bullet}`).join('\n')}` }

async function buildTalk(slides) {
  const outline = `# ${TALK}\n\n## Where it breaks\n\n${slides.map(slideText).join('\n\n')}\n`
  const path = join(scratch, 'talk.md')
  await writeFile(path, outline)
  const model = await prepareSource(path, outline, TALK, statSync(path))
  const compiled = extractSlides(model.fullHtml)
  const html = buildShareHtml({ title: TALK, slides: compiled, styles: extractStyles(model.fullHtml), includeNotes: false, slug: 'ai-assessment', license: null, sharedTalk: { ownerName: 'Dominik' } })
  const payload = compiled.map((slide) => {
    const slideId = slide.html.match(/data-id="([^"]+)"/)[1]
    const navTitle = slide.html.match(/data-nav-title="([^"]+)"/)[1]
    const source = slides.find((entry) => entry.title === navTitle)
    return { slideId, title: navTitle, text: source ? slideText(source) : '' }
  })
  const ids = payload.map((slide) => slide.slideId)
  return { html, slides: payload, ids }
}

async function call(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: response.status, json, text }
}

async function waitFor(predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  throw new Error(`Timed out: ${label}`)
}

async function shot(page, name) {
  if (shotsDir) await page.screenshot({ path: join(shotsDir, `${name}.png`), fullPage: false })
}

const log = (line) => console.log(`PASS: ${line}`)

try {
  const created = await call('/shares', { method: 'POST', token: adminSecret, body: { talkSlug: 'ai-assessment', title: TALK } })
  assert.equal(created.status, 201, created.text)
  const { shareId, ownerToken } = created.json
  const share = `/shares/${shareId}`
  const rev1 = await buildTalk(baseSlides)
  assert.equal((await call(`${share}/talk`, { method: 'PUT', token: ownerToken, body: { revision: 1, html: rev1.html, slides: rev1.slides } })).status, 200)
  const [idWhy, idModes, idRubric, idTried] = rev1.ids

  const ownerItems = []
  const owner = new WebSocket(`${wsUrl}${share}/owner?token=${encodeURIComponent(ownerToken)}`)
  sockets.push(owner)
  owner.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.type === 'item.new') ownerItems.push(message.item)
  })
  await new Promise((resolve, reject) => { owner.addEventListener('open', resolve, { once: true }); owner.addEventListener('error', reject, { once: true }) })

  // ── laptop ──────────────────────────────────────────────────────────────────────────────
  const laptop = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await laptop.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${baseUrl}${share}#${idRubric}`)
  const rail = page.locator('.tw-st-rail')
  await rail.locator(`textarea[data-focus-key="replace:${idRubric}"]`).waitFor()
  await waitFor(async () => /following Dominik's saves/.test(await page.locator('.tw-st-top').innerText()), 'the top bar follows his saves')
  assert.equal(await rail.locator(`textarea[data-focus-key="replace:${idRubric}"]`).inputValue(), rev1.slides[2].text, 'the proposal editor opens on the slide\'s source text')
  assert.match(await rail.innerText(), /YOUR COMMENTS · SLIDE 3/i)
  assert.equal(await page.locator('.tw-st-list .tw-st-row').count(), 5)
  log('page loads from the worker with the list, the slide and the margin')

  // Name, remembered on the device.
  await rail.locator('.tw-st-desk-only [data-focus-key="name"]').fill('Ana')
  assert.match(await rail.innerText(), /Shown to Dominik as “Ana”/)

  // Note
  await rail.locator(`textarea[data-focus-key="note:${idRubric}"]`).fill('Too dense for a room of markers.')
  await rail.getByRole('button', { name: 'Send note' }).click()
  await waitFor(async () => ownerItems.some((item) => item.kind === 'note'), 'owner receives the note')
  const note = ownerItems.find((item) => item.kind === 'note')
  assert.deepEqual({ kind: note.kind, slideId: note.slideId, text: note.text, name: note.name }, { kind: 'note', slideId: idRubric, text: 'Too dense for a room of markers.', name: 'Ana' })
  await waitFor(async () => /✓ Sent \d\d:\d\d · slide 3 · kept if you close this tab/.test(await rail.innerText()), 'note receipt shows time and slide')
  log('a note is sent with their name; the receipt shows time and slide')

  // Replace: diff before send
  const editor = rail.locator(`textarea[data-focus-key="replace:${idRubric}"]`)
  await editor.fill('### The rubric problem\n\n- Rubrics reward what a model writes most fluently\n- Markers read for structure first')
  await rail.locator('.tw-st-diff').waitFor()
  assert.equal(await rail.locator('.tw-st-diff .d').count(), 2)
  assert.equal(await rail.locator('.tw-st-diff .a').count(), 1)
  await shot(page, '1-laptop-note-sent-rewording-drafted')
  await rail.getByRole('button', { name: 'Send proposal' }).click()
  await waitFor(async () => ownerItems.some((item) => item.kind === 'replace'), 'owner receives the proposal')
  const replace = ownerItems.find((item) => item.kind === 'replace')
  assert.equal(replace.baseRevision, 1)
  assert.match(replace.text, /what a model writes/)
  await waitFor(async () => /Your rewording of this slide, 3 lines\.[\s\S]*✓ Sent \d\d:\d\d · slide 3 · waiting for Dominik/.test(await rail.innerText()), 'replace receipt')
  log('a proposed rewording shows its diff first, then sends against revision 1')

  // Delete, on slide 4, with a reason
  await page.locator(`.tw-st-row[data-slide-id="${idTried}"]`).click()
  await rail.getByRole('button', { name: /Propose deleting this slide/ }).click()
  await rail.locator(`textarea[data-focus-key="delete:${idTried}"]`).fill('Slide 5 says the same with the outcome attached.')
  await rail.locator('[data-action="send-delete"]').click()
  await waitFor(async () => ownerItems.some((item) => item.kind === 'delete'), 'owner receives the deletion')
  assert.equal(ownerItems.find((item) => item.kind === 'delete').reason, 'Slide 5 says the same with the outcome attached.')
  await waitFor(async () => !(await page.locator('.tw-st-banner').isHidden()), 'deletion banner')
  assert.match(await page.locator('.tw-st-banner').innerText(), /You proposed deleting this slide\. It stays in Dominik's talk until Dominik accepts\./)
  assert.match(await page.locator(`.tw-st-row[data-slide-id="${idTried}"]`).innerText(), /deletion sent/)
  await shot(page, '2-laptop-deletion-sent')
  log('a deletion proposal with its reason; the banner and the list say so')

  // Insert after slide 3, opening a new section: a draft that survives a reload, then sent
  await page.locator(`.tw-st-row[data-slide-id="${idRubric}"]`).click()
  await rail.getByRole('button', { name: /Propose a new slide after this one/ }).click()
  await rail.getByRole('switch', { name: 'Start a new section' }).click()
  await rail.locator(`[data-focus-key="insert-section:${idRubric}"]`).fill('What students told us')
  const insertBox = rail.locator(`textarea[data-focus-key="insert:${idRubric}"]`)
  assert.equal(await insertBox.inputValue(), '### ', 'the new-slide editor starts at the slide heading depth')
  await insertBox.fill('### Students asked for the rules in writing\n- Most used a chatbot to start a draft\n- A one-page policy settled most questions')
  await waitFor(async () => !(await page.locator('.tw-st-ghostfit').isHidden()), 'the draft renders in the centre')
  assert.match(await page.locator('.tw-st-ghostinner').innerText(), /Students asked for the rules in writing/)
  assert.match(await page.locator('.tw-st-banner').innerText(), /Draft · your proposed new slide, after slide 3, opening the section “What students told us”/)
  assert.match(await page.locator('.tw-st-list').innerText(), /NEW SECTION · WHAT STUDENTS TOLD US[\s\S]*Students asked for the rules in writing/i)
  assert.equal(await page.locator('#slideCount').innerText(), 'draft after 3')
  await shot(page, '3-laptop-new-slide-draft')
  // A note draft on slide 2, never sent
  await page.locator(`.tw-st-row[data-slide-id="${idModes}"]`).click()
  await rail.locator(`textarea[data-focus-key="note:${idModes}"]`).fill('Half-written thought')
  await page.reload()
  await rail.locator(`textarea[data-focus-key="note:${idModes}"]`).waitFor()
  assert.equal(await rail.locator(`textarea[data-focus-key="note:${idModes}"]`).inputValue(), 'Half-written thought', 'the note draft survives closing the tab')
  assert.match(await page.locator('.tw-st-list').innerText(), /Students asked for the rules in writing/, 'the new-slide draft survives too')
  await page.locator(`.tw-st-row.ghost[data-ghost-after="${idRubric}"]`).click()
  assert.equal(await rail.locator(`textarea[data-focus-key="insert:${idRubric}"]`).inputValue(), '### Students asked for the rules in writing\n- Most used a chatbot to start a draft\n- A one-page policy settled most questions')
  await rail.locator('[data-action="send-insert"]').click()
  await waitFor(async () => ownerItems.some((item) => item.kind === 'insert'), 'owner receives the new slide')
  const insert = ownerItems.find((item) => item.kind === 'insert')
  assert.deepEqual({ afterSlideId: insert.afterSlideId, section: insert.section, baseRevision: insert.baseRevision }, { afterSlideId: idRubric, section: 'What students told us', baseRevision: 1 })
  await waitFor(async () => /New slide after this one · Students asked for the rules in writing[\s\S]*Opens the section “What students told us”[\s\S]*✓ Sent \d\d:\d\d · after slide 3/.test(await rail.innerText()), 'insert receipt')
  assert.equal(await page.locator('.tw-st-ghostfit').isHidden(), true)
  log('a new slide opening a section: previewed, kept across a reload, sent with its section title')

  // Thumbnails: the grid with marks and a slot between tiles
  await page.getByRole('button', { name: 'Thumbnails' }).click()
  await page.locator('.tw-st-grid .tw-st-tile').first().waitFor()
  assert.equal(await page.locator('.tw-st-grid .tw-st-tile:not(.ghost)').count(), 5)
  assert.equal(await page.locator('#stageFit').isHidden(), true)
  const rubricMarks = await page.locator(`.tw-st-tile[data-slide-id="${idRubric}"] .tw-st-tmarks`).innerText()
  assert.match(rubricMarks, /1 note sent/); assert.match(rubricMarks, /1 edit sent/); assert.match(rubricMarks, /1 new slide sent/)
  assert.match(await page.locator(`.tw-st-tile[data-slide-id="${idTried}"] .tw-st-tmarks`).innerText(), /deletion sent/)
  assert.match(await page.locator(`.tw-st-tile[data-slide-id="${idModes}"] .tw-st-tmarks`).innerText(), /draft note/)
  await page.locator(`.tw-st-slot[data-slot-after="${idWhy}"]`).hover()
  await page.locator(`.tw-st-slot[data-slot-after="${idWhy}"]`).click()
  await rail.locator(`textarea[data-focus-key="insert:${idWhy}"]`).waitFor()
  assert.match(await rail.innerText(), /YOUR COMMENTS · SLIDE 1/i, 'clicking a slot opens the new-slide editor after that tile')
  await rail.locator(`textarea[data-focus-key="insert:${idWhy}"]`).fill('### A draft between tiles\n- one')
  await page.locator(`.tw-st-tile.ghost[data-ghost-after="${idWhy}"]`).waitFor()
  assert.match(await page.locator(`.tw-st-tile.ghost[data-ghost-after="${idWhy}"]`).innerText(), /draft · new slide/)
  await page.locator(`.tw-st-slot[data-slot-after="${idRubric}"]`).hover()
  await shot(page, '4-laptop-thumbnails')
  await page.locator(`.tw-st-tile[data-slide-id="${idTried}"] .tw-st-tbtn`).click()
  assert.match(await rail.innerText(), /YOUR COMMENTS · SLIDE 4/i, 'clicking a tile selects it and the margin follows')
  await page.getByRole('button', { name: 'Slide', exact: true }).click()
  assert.equal(await page.locator('#stageFit').isHidden(), false)
  log('thumbnails: grid with sent, draft and deletion marks; a slot proposes a new slide')

  // talk.updated: he rewrites slides 3 and 4 while they type on slide 3
  await page.locator(`.tw-st-row[data-slide-id="${idRubric}"]`).click()
  const noteBox = rail.locator(`textarea[data-focus-key="note:${idRubric}"]`)
  await noteBox.fill('Better. Now slide 4 needs the same')
  await noteBox.focus()
  const renderedRubricBefore = await page.evaluate((id) => document.querySelector(`#stage > [data-id="${id}"]`).innerText, idRubric)
  const rev2Slides = baseSlides.map((slide, i) => i === 2 ? { ...slide, bullets: ['Criteria reward fluency', 'So does the model'] } : i === 3 ? { ...slide, bullets: ['Oral follow-ups', 'Marking time up a third', 'Students preferred it'] } : slide)
  const rev2 = await buildTalk(rev2Slides)
  assert.deepEqual(rev2.ids, rev1.ids)
  const untouchedBefore = await page.evaluate((id) => document.querySelector(`#stage > [data-id="${id}"]`).outerHTML, idWhy)
  assert.equal((await call(`${share}/talk`, { method: 'PUT', token: ownerToken, body: { revision: 2, html: rev2.html, slides: rev2.slides } })).status, 200)
  await waitFor(async () => /Criteria reward fluency/.test(await page.evaluate((id) => document.querySelector(`#stage > [data-id="${id}"]`).innerText, idRubric)), 'slide 3 re-renders within seconds')
  assert.ok(!/Markers read for structure first/.test(await page.evaluate((id) => document.querySelector(`#stage > [data-id="${id}"]`).innerText, idRubric)), renderedRubricBefore)
  assert.equal(await page.evaluate((id) => document.querySelector(`#stage > [data-id="${id}"]`).outerHTML, idWhy), untouchedBefore, 'an unchanged slide is left alone')
  assert.match(await page.locator('.tw-st-top').innerText(), /Updated just now · following Dominik's saves/)
  assert.equal(await noteBox.inputValue(), 'Better. Now slide 4 needs the same', 'their unsent note is untouched')
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-focus-key')), `note:${idRubric}`, 'and keeps the caret')
  assert.match(await page.locator(`.tw-st-row[data-slide-id="${idTried}"]`).innerText(), /updated/, 'the list marks the slide he changed since they looked')
  assert.doesNotMatch(await page.locator(`.tw-st-row[data-slide-id="${idRubric}"]`).innerText(), /updated/, 'the slide in front of their counts as seen')
  assert.equal(await rail.locator(`textarea[data-focus-key="replace:${idRubric}"]`).count(), 0, 'their sent rewording stays a receipt')
  await page.locator(`.tw-st-row[data-slide-id="${idTried}"]`).click()
  assert.doesNotMatch(await page.locator(`.tw-st-row[data-slide-id="${idTried}"]`).innerText(), /updated/, 'looking at it clears the mark')
  log('talk.updated re-renders only the changed slides, marks the list, leaves drafts and focus alone')

  // Statuses: he accepts the note and dismisses the deletion
  assert.equal((await call(`${share}/items/${note.itemId}`, { method: 'PATCH', token: ownerToken, body: { status: 'accepted' } })).status, 200)
  const deletion = ownerItems.find((item) => item.kind === 'delete')
  assert.equal((await call(`${share}/items/${deletion.itemId}`, { method: 'PATCH', token: ownerToken, body: { status: 'dismissed' } })).status, 200)
  await waitFor(async () => /dismissed by Dominik/.test(await rail.innerText()), 'dismissed status shows')
  assert.equal(await page.locator('.tw-st-banner').isHidden(), true, 'a dismissed deletion no longer claims the slide')
  await page.locator(`.tw-st-row[data-slide-id="${idRubric}"]`).click()
  await waitFor(async () => /✓ Sent \d\d:\d\d · slide 3 · accepted by Dominik \d\d:\d\d/.test(await rail.innerText()), 'accepted status shows')
  // A fresh page load gets the statuses by replay (since=0 once).
  await page.reload()
  await waitFor(async () => /accepted by Dominik/.test(await page.locator('.tw-st-rail').innerText()), 'statuses replay after a reload')
  log('accepted and dismissed statuses reach their items, live and after a reload')

  // Offline: the post fails; the item is kept, the notice shows, the retry sends it once
  let block = true
  await page.route('**/items', (route) => block ? route.abort('internetdisconnected') : route.continue())
  await rail.locator(`textarea[data-focus-key="note:${idRubric}"]`).fill('Sent while the link was down')
  await rail.getByRole('button', { name: 'Send note' }).click()
  await waitFor(async () => /Kept on this device · sends when the connection is back/.test(await rail.innerText()), 'kept-on-device receipt')
  assert.equal(await rail.locator('.tw-st-offline').isVisible(), true)
  assert.match(await rail.locator('.tw-st-offline').innerText(), /You are offline\. Your notes are saved here and nothing is lost; they reach Dominik as soon as the link reconnects\./)
  assert.match(await page.locator('.tw-st-top').innerText(), /Last update \d\d:\d\d · waiting for the connection/)
  await shot(page, '5-laptop-offline')
  // The link returns, but the first answer is lost after the worker stored the item.
  block = false
  await page.unroute('**/items')
  let lost = 0
  await page.route('**/items', async (route) => {
    if (lost++ === 0) { await route.fetch(); await route.abort('connectionreset'); return }
    await route.continue()
  })
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await waitFor(async () => ownerItems.filter((item) => item.text === 'Sent while the link was down').length === 1, 'the queued note reaches the worker')
  await waitFor(async () => (await rail.locator('.tw-st-receipt[data-state="sent"]', { hasText: 'Sent while the link was down' }).count()) === 1, 'receipt turns to sent', 15000)
  assert.match(await rail.locator('.tw-st-receipt', { hasText: 'Sent while the link was down' }).innerText(), /✓ Sent \d\d:\d\d · slide 3/)
  assert.equal(await rail.locator('.tw-st-offline').isHidden(), true)
  const replay = await new Promise((resolve, reject) => {
    const seen = []
    const socket = new WebSocket(`${wsUrl}${share}/owner?since=0&token=${encodeURIComponent(ownerToken)}`)
    sockets.push(socket)
    socket.addEventListener('message', (event) => { const message = JSON.parse(String(event.data)); if (message.type === 'item.new') seen.push(message.item) })
    socket.addEventListener('error', reject)
    setTimeout(() => resolve(seen), 1500)
  })
  assert.equal(replay.filter((item) => item.text === 'Sent while the link was down').length, 1, 'the worker holds it exactly once')
  assert.equal(lost >= 2, true, 'the page retried after the lost answer')
  await page.unroute('**/items')
  log('offline: kept on the device with the notice, retried, stored once despite a lost answer')

  // A structural push (a slide added) reloads the page with drafts intact
  await rail.locator(`textarea[data-focus-key="note:${idRubric}"]`).fill('Draft across a reload')
  const rev3Slides = [...rev2Slides.slice(0, 4), { title: 'Redesign, not detection', bullets: ['Design tasks around process'] }, rev2Slides[4]]
  const rev3 = await buildTalk(rev3Slides)
  assert.equal((await call(`${share}/talk`, { method: 'PUT', token: ownerToken, body: { revision: 3, html: rev3.html, slides: rev3.slides } })).status, 200)
  await waitFor(async () => (await page.locator('.tw-st-list .tw-st-row:not(.ghost)').count()) === 6, 'the page shows the added slide')
  await page.locator(`textarea[data-focus-key="note:${idRubric}"]`).waitFor()
  assert.equal(await page.locator(`textarea[data-focus-key="note:${idRubric}"]`).inputValue(), 'Draft across a reload')
  assert.match(await page.locator(`.tw-st-row[data-slide-id="${rev3.ids[4]}"]`).innerText(), /updated/, 'the new slide is marked')
  log('a push that adds a slide reloads the page on the same slide with drafts intact')
  assert.deepEqual(errors, [], 'no page errors on the laptop')

  // ── phone, 390px ────────────────────────────────────────────────────────────────────────
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
  const phone = await phoneContext.newPage()
  const phoneErrors = []
  phone.on('pageerror', (error) => phoneErrors.push(error.message))
  await phone.goto(`${baseUrl}${share}#${idRubric}`)
  const phoneRail = phone.locator('.tw-st-rail')
  await phoneRail.locator(`textarea[data-focus-key="note:${idRubric}"]`).waitFor()
  const geometry = await phone.evaluate(() => {
    const rect = (el) => el.getBoundingClientRect()
    const stage = rect(document.getElementById('stageFit'))
    const railBox = rect(document.querySelector('.tw-st-rail'))
    const visible = Array.from(document.querySelectorAll('.tw-st-rail textarea, .tw-st-rail input')).filter((el) => el.offsetParent !== null)
    const targets = Array.from(document.querySelectorAll('.tw-st-rail button, #prevBtn, #nextBtn')).filter((el) => el.offsetParent !== null)
    return {
      stageBottom: stage.bottom, railTop: railBox.top, railWidth: railBox.width,
      firstField: visible[0]?.getAttribute('data-focus-key'),
      fonts: visible.map((el) => getComputedStyle(el).fontSize),
      smallTargets: targets.filter((el) => el.getBoundingClientRect().height < 44).map((el) => el.textContent.trim() || el.className),
      scrollWidth: document.documentElement.scrollWidth,
      listVisible: document.querySelector('.tw-st-list').offsetParent !== null,
    }
  })
  assert.ok(geometry.railTop >= geometry.stageBottom, `the margin sits below the slide (${geometry.railTop} >= ${geometry.stageBottom})`)
  assert.equal(geometry.firstField, `note:${idRubric}`, 'Note comes first')
  assert.ok(geometry.fonts.every((size) => size === '16px'), `inputs are 16px: ${geometry.fonts}`)
  assert.deepEqual(geometry.smallTargets, [], 'every visible target is at least 44px tall')
  assert.ok(geometry.scrollWidth <= 390, 'no sideways scroll')
  assert.equal(geometry.listVisible, false)
  assert.equal(await phoneRail.locator(`textarea[data-focus-key="replace:${idRubric}"]`).isVisible(), false, 'the proposal editor sits behind one row')
  assert.match(await phoneRail.innerText(), /Sent as “Colleague”\. Add your name/, "a new device has no name yet")
  await shot(phone, '6-phone-note')
  await phoneRail.getByRole('button', { name: /Propose slide text instead/ }).click()
  assert.equal(await phoneRail.locator('.tw-st-more').isVisible(), true)
  await phoneRail.getByRole('button', { name: /Propose slide text instead/ }).click()
  await phone.route('**/items', (route) => route.abort('internetdisconnected'))
  await phoneRail.locator(`textarea[data-focus-key="note:${idRubric}"]`).fill('Three lines at most.')
  await phoneRail.getByRole('button', { name: 'Send note' }).click()
  await waitFor(async () => /Kept on this device/.test(await phoneRail.innerText()), 'phone kept-on-device receipt')
  assert.equal(await phoneRail.locator('.tw-st-offline').isVisible(), true)
  await shot(phone, '7-phone-offline')
  assert.deepEqual(phoneErrors, [], 'no page errors on the phone')
  log('phone 390px: margin below the slide, Note first, 44px targets, 16px inputs, offline notice')

  // Stop sharing
  assert.equal((await call(`${share}/close`, { method: 'POST', token: ownerToken })).status, 200)
  await waitFor(async () => /Sharing has stopped/.test(await page.locator('.tw-st-top').innerText()), 'the page says sharing stopped')
  log('Stop sharing: the page says so and keeps what they wrote')

  console.log('shared-talk page browser test passed')
} finally {
  for (const socket of sockets) { try { socket.close() } catch {} }
  await browser.close().catch(() => {})
  await stop()
  await rm(scratch, { recursive: true, force: true })
}
