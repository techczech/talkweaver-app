#!/usr/bin/env node
// check:real-embed-pages — do the embedded pages of a real vault still work in the sandbox?
// (0.38 ticket 11.2; design test matrix row 14.) Run by name, not part of `npm test`:
//
//   node scripts/check-real-embed-pages.mjs <vault folder> [--only <text in the outline path>]
//
// READ-ONLY on the vault. Every talk outline (`*-outline.md`, outside bundle/ and _SLIDE-VERSIONS/)
// that embeds a local .html page is compiled in memory with the vault as the allowed root; the
// compiled decks are served from http://127.0.0.1 and never written anywhere. Nothing of a page's
// content is printed or kept: the report holds file names, counts and hashes. The vault's
// `git status` is compared before and after.
//
// Per embedded page, in headless Chromium:
//   A. alone, twice: UNSANDBOXED as before this ticket (the page with its policy, in a frame that
//      shares the host's origin) and SANDBOXED as now (the compiled document: policy, referrer,
//      base, agent, in sandbox="allow-scripts allow-forms"). Compared after load and again after
//      real clicks on the first two in-page anchors and the first four buttons: element count,
//      visible-text length and hash, the document's text, every element's classes and state,
//      images / canvases / SVGs, console errors. One named exception: the demo counter page's
//      start time, given only to the page that the slide's own `[Embed: …]` line names when that
//      path is the demo's file and the whole file is what was compiled (see START_TIME_DEMO).
//   B. in the compiled deck, on its slide: the frame is live, sandboxed, its origin is opaque, the
//      agent is running, and the page is the one measured in A.
//   C. in a presenter and projector pair on that slide: the same clicks in the presenter's Current
//      pane, then a scroll; the projector's copy ends with the same element count, text and
//      scroll fraction (mirroring through the embed channel). Then, for a page taller than its
//      frame, a REAL wheel gesture over the pane: the page moves and the projector's copy follows.
//      (A scripted scroll passes on a frame a person cannot scroll; the wheel does not.)
// The page is read through the browser's debugging connection, never through the deck.
// Exit 1 when a sandboxed page has a console error the unsandboxed one has not, or differs from it.
import { createServer } from 'node:http'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname, basename, resolve, isAbsolute } from 'node:path'
import { chromium } from 'playwright'
import { prepareSource, EMBED_PAGE_POLICY } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { extractSlides } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { EMBED_SANDBOX_LOCAL, EMBED_REFERRER_META, EMBED_BASE_TAG, withEmbedLead } from '../compiler/scripts/lib/embed-frame.mjs'
import { embedAgentSource } from '../compiler/assets/runtime/embed-agent.js'

const args = process.argv.slice(2)
const vault = args.find((arg) => !arg.startsWith('--') && args[args.indexOf(arg) - 1] !== '--only')
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : ''
if (!vault) { console.error('usage: node scripts/check-real-embed-pages.mjs <vault folder> [--only <text>]'); process.exit(2) }
if (!existsSync(vault)) { console.log(`check:real-embed-pages skipped: no vault at ${vault}`); process.exit(0) }
const root = resolve(vault)
const gitStatus = () => { try { return execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }) } catch { return null } }
const statusBefore = gitStatus()

// ── The talks ─────────────────────────────────────────────────────────────────────────────────
const LOCAL_EMBED = /^\[(?:Embed|Simulation):\s*(?!https?:)([^\]]+\.html?)\]\s*$/gim
function outlines(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'bundle' || entry.name === '_SLIDE-VERSIONS') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) outlines(path, out)
    else if (entry.name.endsWith('-outline.md') && (!only || path.includes(only))) out.push(path)
  }
  return out
}
const unescapeAttr = (text) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const POLICY_META = `<meta http-equiv="Content-Security-Policy" content="${EMBED_PAGE_POLICY}">`
const LEAD_REST = `${EMBED_REFERRER_META}${EMBED_BASE_TAG}<script>${embedAgentSource()}</script>`

// The ONE exception to an exact comparison: the demo counter page prints the time it started
// (HH:MM:SS) in its #started element, which differs between two loads by the clock. It is BOUND to
// the embed reference of the slide being checked, never guessed from what a compiled document looks
// like: the compiler's own model says which `[Embed: …]` reference each document of a slide came
// from (the block's `src` as the outline wrote it, beside the document it compiled). The exception
// is given only when that reference, resolved against the talk's folder, IS the demo's file (real
// paths), and the compiled document is that whole file with the compiler's lead, character for
// character. A page cannot ask for it, and a file that only resembles the demo's does not get it.
const START_TIME_DEMO = join('talkweaver-demos', 'embedded-page', 'assets', 'counter.html')
const realPath = (file) => { try { return realpathSync(file) } catch { return null } }
/** The local pages the compiler inlined on each slide: slide id → [{ src (as written), srcdoc }], in document order. */
function embedsBySlide(model) {
  const bySlide = new Map()
  const walk = (value, found) => {
    if (Array.isArray(value)) { for (const item of value) walk(item, found); return }
    if (!value || typeof value !== 'object') return
    if (value.type === 'embed' && typeof value.srcdoc === 'string') { found.push({ src: String(value.src ?? ''), srcdoc: value.srcdoc }); return }
    for (const key of Object.keys(value)) walk(value[key], found)
  }
  for (const slide of model.slides || []) { const found = []; walk(slide, found); bySlide.set(String(slide.id ?? ''), found) }
  return bySlide
}
/** The file a reference written in the outline at `outlinePath` names (as written, else URL-decoded as the compiler tries), or null. */
function referencedFile(outlinePath, src) {
  const forms = [src]
  try { const decoded = decodeURIComponent(src); if (decoded !== src) forms.push(decoded) } catch { /* not an encoded name */ }
  for (const form of forms) {
    const file = isAbsolute(form) ? form : resolve(dirname(outlinePath), form)
    if (existsSync(file) && statSync(file).isFile()) return file
  }
  return null
}
const talks = []
for (const path of outlines(root)) {
  const source = readFileSync(path, 'utf8')
  const written = [...source.matchAll(LOCAL_EMBED)].map((match) => match[1].trim())
  if (!written.length) continue
  const model = await prepareSource(path, source, null, statSync(path), {}, { allowedAssetRoots: [root] })
  const deck = String(model.fullHtml)
  const embeds = embedsBySlide(model)
  const pages = []
  for (const slide of extractSlides(deck)) {
    const id = slide.html.match(/^\s*<section\b[^>]*\sdata-id="([^"]*)"/)?.[1] ?? ''
    const frames = slide.html.match(/<figure class="slide-embed[^>]*>[\s\S]*?<\/figure>/g) || []
    frames.forEach((figure, position) => {
      const doc = figure.match(/\sdata-embed-doc="([^"]*)"/)
      if (!doc) return
      const compiled = unescapeAttr(doc[1])
      // The reference this document was compiled from: an embed of THIS slide, in the compiler's
      // model, whose compiled document is exactly the one in the frame. Then the file it names.
      // Each reference answers for one frame (two embeds of one slide may hold the same text).
      const onSlide = embeds.get(id) || []
      const at = onSlide.findIndex((candidate) => candidate.srcdoc === compiled)
      const embed = at >= 0 ? onSlide.splice(at, 1)[0] : null
      const file = embed ? referencedFile(path, embed.src) : null
      // What the frame held before this ticket: the page with its policy, and nothing else of ours.
      const before = compiled.replace(LEAD_REST, '').replace(LEAD_REST.replace(EMBED_BASE_TAG, ''), '')
      // The start-time exception: the slide's reference is the demo's own file, and the frame holds
      // that whole file as compiled.
      const isDemo = Boolean(file) && realPath(file) !== null && realPath(file) === realPath(join(root, START_TIME_DEMO))
      const startTime = isDemo && withEmbedLead(readFileSync(file, 'utf8'), POLICY_META) === compiled ? '#started' : null
      pages.push({ slide: id, name: file ? basename(file) : `(embed ${position} of slide ${id})`, startTime, compiled, before, ownBase: !compiled.includes(`${EMBED_REFERRER_META}${EMBED_BASE_TAG}`) })
    })
  }
  const refused = (model.warnings || []).filter((warning) => /^(missing-asset|outside-vault|asset-outside)/.test(String(warning))).length
  talks.push({ path, relative: path.slice(root.length + 1), deck, pages, written: written.length, refused })
}

// ── Serving ───────────────────────────────────────────────────────────────────────────────────
const served = new Map()
const server = createServer((req, res) => {
  const path = req.url.split('?')[0]
  if (served.has(path)) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(served.get(path)); return }
  res.writeHead(404); res.end()
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`
const asScriptValue = (value) => JSON.stringify(value).replace(/</g, '\\u003c')
const hostPage = (doc, sandbox) => `<!doctype html><title>host</title><body style="margin:0"><script>
  var frame = document.createElement('iframe');
  ${sandbox ? `frame.setAttribute('sandbox', ${JSON.stringify(sandbox)});` : ''}
  frame.name = 'page'; frame.style.cssText = 'border:0;width:1280px;height:720px';
  document.body.appendChild(frame);
  ${sandbox ? `frame.srcdoc = ${asScriptValue(doc)};` : `frame.src = URL.createObjectURL(new Blob([${asScriptValue(doc)}], { type: 'text/html' }));`}
</script></body>`

const browser = await chromium.launch({ headless: true })
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
/**
 * What a page is, for comparison. Read-only: nothing in the measured document is changed.
 * `startTimeIn` (the counter demo only): a selector whose element's text is left out of the two
 * text measures; everything else on that page, and every other page, is compared exactly.
 */
const fingerprint = (frame, startTimeIn = null) => frame.evaluate((startTimeIn) => {
  const hashOf = (text) => { let hash = 0; for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0; return hash }
  const skipped = startTimeIn && document.body ? document.body.querySelector(startTimeIn) : null
  // The text as shown (layout decides it, so it is read from the live document): the skipped
  // element's own shown text is taken out of the string, once.
  let text = document.body ? document.body.innerText : ''
  if (skipped && skipped.innerText) text = text.replace(skipped.innerText, '')
  // Independent of the frame's size: the text in the document, and each element's tag, classes and
  // open / hidden / expanded / checked state. Text nodes inside the skipped element are passed over.
  let content = ''
  if (document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (!(skipped && skipped.contains(node))) content += node.data
  }
  const all = Array.from(document.querySelectorAll('body *'))
  const state = all.map((el) => `${el.localName}.${typeof el.className === 'string' ? el.className : ''}${el.hidden ? '!h' : ''}${el.open ? '!o' : ''}${el.checked ? '!c' : ''}${el.getAttribute('aria-expanded') || ''}`).join('|')
  const ours = document.querySelectorAll('base[href="about:srcdoc"], meta[name="referrer"][content="no-referrer"]').length
  return { elements: document.querySelectorAll('*').length - ours, textLength: text.length, textHash: hashOf(text), contentHash: hashOf(content), stateHash: hashOf(state), images: document.images.length, canvases: document.querySelectorAll('canvas').length, svgs: document.querySelectorAll('svg').length }
}, startTimeIn)
/** Real clicks on the first two in-page anchors and the first four buttons that can be clicked. */
async function interact(frame) {
  let done = 0
  for (const [selector, limit] of [['a[href^="#"]', 2], ['button', 4]]) {
    const targets = await frame.$$(selector)
    for (const target of targets.slice(0, limit)) {
      try { await target.click({ timeout: 1500 }); done += 1; await sleep(250) } catch { /* hidden or covered: not a click a person could make */ }
    }
  }
  return done
}
const same = (a, b, keys = ['elements', 'textLength', 'textHash', 'contentHash', 'stateHash', 'images', 'canvases', 'svgs']) => keys.every((key) => a[key] === b[key])
const watch = (page) => {
  const errors = []
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text().replace(/https?:\/\/127\.0\.0\.1:\d+/g, '').replace(/blob:\S+/g, 'blob:').slice(0, 160)) })
  page.on('pageerror', (error) => errors.push(`uncaught: ${String(error.message).slice(0, 160)}`))
  return errors
}
const frameNamed = async (page, name) => { for (let i = 0; i < 100; i += 1) { const found = page.frames().find((frame) => frame.name() === name); if (found) return found; await sleep(50) } throw new Error('no frame') }
/** The live embed frame of a deck window for one embed of the current slide (the presenter: its Current pane). */
async function liveEmbed(page, presenter) {
  for (let tries = 0; tries < 120; tries += 1) {
    for (const frame of page.frames()) {
      if (frame.parentFrame() !== page.mainFrame() || !frame.url().startsWith('about:srcdoc')) continue
      const element = await frame.frameElement().catch(() => null)
      if (!element) continue
      const info = await element.evaluate((el, pane) => (pane ? el.matches('iframe.live-sim-frame[data-embed-local]') : Boolean(el.closest('.slide.active figure.slide-embed[data-embed-state="live"]'))) && { sandbox: el.getAttribute('sandbox'), src: el.hasAttribute('src') }, presenter).catch(() => null)
      if (info) { await frame.waitForLoadState('load').catch(() => {}); return { frame, ...info } }
    }
    await sleep(50)
  }
  return null
}

let failed = 0
const report = []
try {
  let serial = 0
  for (const talk of talks) {
    const deckPath = `/deck-${talks.indexOf(talk)}.html`
    served.set(deckPath, talk.deck)
    const firstOnSlide = new Set()
    for (const page of talk.pages) {
      serial += 1
      const row = { talk: talk.relative, page: page.name, slide: page.slide, problems: [] }
      report.push(row)
      // A. alone: unsandboxed as before, sandboxed as now.
      const alone = {}
      for (const [variant, doc, sandbox] of [['unsandboxed', page.before, null], ['sandboxed', page.compiled, EMBED_SANDBOX_LOCAL.join(' ')]]) {
        const path = `/alone-${serial}-${variant}.html`
        served.set(path, hostPage(doc, sandbox))
        const context = await browser.newContext({ viewport: { width: 1400, height: 800 } })
        const tab = await context.newPage()
        const errors = watch(tab)
        await tab.goto(`${origin}${path}`, { waitUntil: 'load' })
        const frame = await frameNamed(tab, 'page')
        await frame.waitForLoadState('load').catch(() => {})
        await sleep(700)
        const loaded = await fingerprint(frame, page.startTime)
        const clicks = await interact(frame)
        await sleep(300)
        alone[variant] = { loaded, after: await fingerprint(frame, page.startTime), clicks, errors: [...errors], origin: await frame.evaluate(() => self.origin) }
        await context.close()
        served.delete(path)
      }
      const { unsandboxed, sandboxed } = alone
      row.elements = sandboxed.loaded.elements
      row.clicks = sandboxed.clicks
      row.sameAtLoad = same(unsandboxed.loaded, sandboxed.loaded)
      row.sameAfterClicks = unsandboxed.clicks === sandboxed.clicks && same(unsandboxed.after, sandboxed.after)
      row.errorsUnsandboxed = unsandboxed.errors.length
      row.errorsSandboxed = sandboxed.errors.length
      if (sandboxed.origin !== 'null') row.problems.push(`sandboxed origin is ${sandboxed.origin}`)
      if (!row.sameAtLoad) row.problems.push(`differs at load: ${JSON.stringify(unsandboxed.loaded)} vs ${JSON.stringify(sandboxed.loaded)}`)
      if (!row.sameAfterClicks) row.problems.push(`differs after ${unsandboxed.clicks}/${sandboxed.clicks} clicks: ${JSON.stringify(unsandboxed.after)} vs ${JSON.stringify(sandboxed.after)}`)
      const newErrors = sandboxed.errors.filter((text) => !unsandboxed.errors.includes(text))
      if (sandboxed.errors.length > unsandboxed.errors.length) row.problems.push(`console errors only when sandboxed: ${JSON.stringify(newErrors.slice(0, 3))}`)

      // B. in the deck, on its slide.
      const deckContext = await browser.newContext({ viewport: { width: 1280, height: 720 } })
      const deckTab = await deckContext.newPage()
      const deckErrors = watch(deckTab)
      await deckTab.goto(`${origin}${deckPath}#${encodeURIComponent(page.slide)}`, { waitUntil: 'load' })
      const onSlide = await deckTab.evaluate(() => document.querySelector('.slide.active')?.dataset.id ?? null)
      const first = !firstOnSlide.has(page.slide)
      firstOnSlide.add(page.slide)
      const inDeck = onSlide === page.slide && first ? await liveEmbed(deckTab, false) : null
      if (onSlide !== page.slide) row.deck = `not reached (deck opened on ${onSlide})`
      else if (!first) row.deck = 'second embed of its slide: not measured separately'
      else if (!inDeck) { row.deck = 'NOT LIVE'; row.problems.push('the frame did not become live on its slide') }
      else {
        await sleep(700)
        const seen = await inDeck.frame.evaluate(() => ({ origin: self.origin, agent: typeof window[Symbol.for('tw.embed.agent')] }))
        const print = await fingerprint(inDeck.frame, page.startTime)
        row.deck = `live, sandbox="${inDeck.sandbox}", origin ${seen.origin}, agent ${seen.agent === 'function' ? 'running' : 'MISSING'}`
        if (inDeck.sandbox !== EMBED_SANDBOX_LOCAL.join(' ') || inDeck.src || seen.origin !== 'null' || seen.agent !== 'function') row.problems.push(`in the deck: ${row.deck}`)
        // The deck's frame is the slide's size, not 1280×720: structure and the document's text are
        // compared, not what a narrower layout shows.
        if (print.elements !== sandboxed.loaded.elements || print.contentHash !== sandboxed.loaded.contentHash) row.problems.push(`in the deck the page differs from the page alone: ${JSON.stringify(print)}`)
        if (deckErrors.length > sandboxed.errors.length) row.problems.push(`console errors in the deck: ${JSON.stringify(deckErrors.slice(0, 3))}`)
      }
      await deckContext.close()

      // C. presenter and projector: the same clicks in the pane, then a scroll.
      if (onSlide === page.slide && first && inDeck) {
        const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
        const session = `real-${serial}-${Date.now()}`
        const projector = await context.newPage()
        const presenter = await context.newPage()
        await projector.goto(`${origin}${deckPath}?audience=1&session=${session}#${encodeURIComponent(page.slide)}`, { waitUntil: 'load' })
        await presenter.goto(`${origin}${deckPath}?presenter=1&session=${session}#${encodeURIComponent(page.slide)}`, { waitUntil: 'load' })
        const pane = await liveEmbed(presenter, true)
        const copy = await liveEmbed(projector, false)
        if (!pane || !copy) row.mirror = `not measured (${pane ? '' : 'no live copy in the presenter\'s Current pane'}${copy ? '' : ' no live copy in the projector'})`
        else {
          await sleep(900)
          // The presenter chooses the page: a click on the Current pane's cover, in the deck's own document.
          await presenter.click('#currentPreview .live-sim-cover').catch(() => {})
          const clicks = await interact(pane.frame)
          await pane.frame.evaluate(() => { const el = document.scrollingElement; el.scrollTop = (el.scrollHeight - el.clientHeight) / 2 })
          await sleep(900)
          const [a, b] = [await fingerprint(pane.frame, page.startTime), await fingerprint(copy.frame, page.startTime)]
          const at = (frame) => frame.evaluate(() => { const el = document.scrollingElement; const range = el.scrollHeight - el.clientHeight; return range > 0 ? el.scrollTop / range : 0 })
          const [scrollA, scrollB] = [await at(pane.frame), await at(copy.frame)]
          const follows = same(a, b, ['elements', 'contentHash', 'stateHash']) && Math.abs(scrollA - scrollB) < 0.02
          row.mirror = `${clicks} click(s) and a scroll: the projector's copy ${follows ? 'follows' : 'DIFFERS'} (scroll ${scrollA.toFixed(2)} / ${scrollB.toFixed(2)})`
          if (!follows) row.problems.push(`mirroring: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
          // The person's own scroll: back to the top by script, then a real wheel gesture over the pane.
          const range = await pane.frame.evaluate(() => { const el = document.scrollingElement; return el.scrollHeight - el.clientHeight })
          if (range <= 40) row.wheel = `not checked: the page is not taller than its frame (${range}px to scroll)`
          else {
            // A page with smooth scrolling takes a second to get there, and a wheel during that is lost.
            await pane.frame.evaluate(() => { document.scrollingElement.scrollTop = 0 })
            for (let tries = 0; tries < 40 && await pane.frame.evaluate(() => document.scrollingElement.scrollTop) !== 0; tries += 1) await sleep(100)
            await sleep(600)
            const box = await presenter.locator('#currentPreview iframe.live-sim-frame').boundingBox()
            await presenter.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
            await presenter.mouse.wheel(0, Math.min(400, range))
            await sleep(900)
            const moved = await pane.frame.evaluate(() => document.scrollingElement.scrollTop)
            const [wheelA, wheelB] = [await at(pane.frame), await at(copy.frame)]
            const ok = moved > 0 && Math.abs(wheelA - wheelB) < 0.02
            row.wheel = `a real wheel gesture in the pane ${moved > 0 ? `moved the page ${Math.round(moved)}px` : 'DID NOT MOVE the page'}; the projector's copy ${Math.abs(wheelA - wheelB) < 0.02 ? 'follows' : 'DIFFERS'} (scroll ${wheelA.toFixed(2)} / ${wheelB.toFixed(2)})`
            if (!ok) row.problems.push(`wheel: ${row.wheel}`)
          }
        }
        await context.close()
      }
      if (row.problems.length) failed += 1
    }
    served.delete(deckPath)
  }
} finally {
  await browser.close()
  await new Promise((done) => server.close(done))
}

// ── Report ────────────────────────────────────────────────────────────────────────────────────
for (const talk of talks) console.log(`talk ${talk.relative}: ${talk.written} local embed line(s), ${talk.pages.length} inlined page(s)${talk.pages.length < talk.written ? ` (${talk.written - talk.pages.length} missing or outside the vault: no frame)` : ''}`)
for (const row of report) {
  console.log(`\n${row.problems.length ? 'FAIL' : 'ok  '} ${row.page}  [${row.talk} · slide ${row.slide}]`)
  console.log(`     alone: ${row.elements} elements; sandboxed vs unsandboxed ${row.sameAtLoad ? 'identical' : 'DIFFERENT'} at load, ${row.sameAfterClicks ? 'identical' : 'DIFFERENT'} after ${row.clicks} click(s); console errors ${row.errorsUnsandboxed} unsandboxed, ${row.errorsSandboxed} sandboxed`)
  console.log(`     deck:  ${row.deck}`)
  if (row.mirror) console.log(`     pair:  ${row.mirror}`)
  if (row.wheel) console.log(`     wheel: ${row.wheel}`)
  for (const problem of row.problems) console.log(`     PROBLEM ${problem}`)
}
const statusAfter = gitStatus()
const untouched = statusBefore === statusAfter
console.log(`\nvault git status ${statusBefore === null ? 'not available (not a git folder)' : untouched ? 'unchanged' : 'CHANGED'}${statusBefore ? ` (${statusBefore.split('\n').filter(Boolean).length} entries before and after)` : ''}`)
console.log(`${report.length} embedded page instance(s) in ${talks.length} talk(s); ${failed} with a problem`)
if (failed || (statusBefore !== null && !untouched)) process.exit(1)
