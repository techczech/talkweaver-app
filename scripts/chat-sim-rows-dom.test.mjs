// Full compiled runtime in bundled headless Chromium. Synthetic source only.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'
import { ROWS } from './fixtures/chat-sim-rows/scenario.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { extractStyles, extractSlides } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { ensurePresenterTemplate } from './build-deck-styles.mjs'
import { missingPopplerTools, reportMissingPoppler } from './lib/test-poppler.mjs'
const shots = process.argv.includes('--shots')
const out = resolve('docs/design/2026-11-17-chat-simulations/build-shots')
const dir = await mkdtemp(resolve('.tw-chat-rows-test-'))
const fence = (id, body, options = '', before = '') => `### ${id} {id=${id}}\n{chat sim-version=2 reveal=steps sidebar=off size=large ${options}}\n\n${before}\`\`\`chat\n${body}\n\`\`\`\n\n`
const status = `turn user "You": Check the samples.\nturn status "Checking" id=check state=working: 2 of 3 checked.\nturn status "Checked" ref=check state=done: All 3 checked.`
const long = `turn user "You": Read every sample line.\nturn files "Full listing": sample-quotes/\n${Array.from({ length: 90 }, (_, i) => `  Sample line ${i + 1}`).join('\n')}\n  detail:\n    Final detail sentinel.`
const speakerScript = 'SpeakerScriptSentinel42: explain the completed comparison.'
const md = '# Synthetic row verification\n\n## Examples\n\n' + fence('rows', ROWS) + fence('status', status, '', 'Before the chat.\n\n') + fence('defaults', ROWS.replace('open=off', 'open=on'), 'open=none') + fence('long', long) + speakerScript + '\n\n```js\nconst preservedCode = 42;\n```\n\n' + '### After {id=after}\n\nFinished.\n'
await test('compiled native row runtime and exports', async (t) => {
let browser
try {
  await ensurePresenterTemplate()
  const outline = join(dir, 'outline.md')
  await writeFile(outline, md)
  const model = await prepareSource(outline, md, 'rows-test', { mtimeMs: 0, size: md.length, isDirectory: () => false })
  assert.equal(model.warnings.filter((x) => /unknown|sim-/.test(x)).length, 0, model.warnings.join('\n'))
  const deck = join(dir, 'deck.html')
  const handout = join(dir, 'handout.html')
  await writeFile(deck, model.fullHtml)
  const shared = buildShareHtml({ title: 'Synthetic rows', slides: extractSlides(model.fullHtml), styles: extractStyles(model.fullHtml), includeNotes: false, slug: 'rows-test' })
  await writeFile(handout, shared)
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce' })
  const errors = []
  context.on('page', (p) => p.on('pageerror', (e) => errors.push(String(e))))
  const open = async (file, id) => {
    const p = await context.newPage()
    await p.goto(`${pathToFileURL(file).href}#${id}`)
    await p.waitForTimeout(350)
    return p
  }
  const step = async (p, key = 'ArrowRight') => { await p.keyboard.press(key); await p.waitForTimeout(200) }
  const shot = async (p, name) => { if (shots) { await mkdir(out, { recursive: true }); await p.mouse.move(0, 0); await p.waitForTimeout(250); await p.screenshot({ path: join(out, `${name}.png`) }) } }
  const hidden = (p) => p.locator('.slide.active .sim-step[data-mode-state="hidden"]').count()
  const p = await open(deck, 'rows')
  assert.equal(await hidden(p), 6)
  await shot(p, 'chat-user')
  await step(p)
  assert.equal(await hidden(p), 5)
  assert.equal(await p.locator('.slide.active .sim-row-thought .sim-toggle').getAttribute('aria-expanded'), 'false')
  await shot(p, 'chat-thought-collapsed')
  await p.locator('.slide.active .sim-row-thought .sim-toggle').click()
  assert.equal(await hidden(p), 5, 'disclosure consumes no reveal')
  await shot(p, 'chat-thought-expanded')
  await step(p)
  assert.equal(await hidden(p), 4)
  await shot(p, 'chat-tool-call')
  await step(p)
  assert.equal(await hidden(p), 3, 'result has its own step')
  await shot(p, 'chat-tool-result')
  await step(p); await shot(p, 'chat-status')
  await step(p); await shot(p, 'chat-file-listing')
  await step(p); await shot(p, 'chat-answer')
  assert.equal(await hidden(p), 0)
  await step(p, 'ArrowLeft')
  assert.equal(await hidden(p), 1, 'Back removes the answer')
  await step(p)
  await step(p)
  assert.equal(await p.locator('.slide.active').getAttribute('data-id'), 'status', 'no dead final press')
  await t.test('status replacement uses slide steps when content precedes the chat', async () => {
    const s = await open(deck, 'status')
    assert.equal(await s.locator('.slide.active .content-p').count(), 1, 'compiled prose precedes the chat')
    await step(s) // preceding paragraph
    await step(s) // original status
    assert.equal(await s.locator('.slide.active .sim-row-status.is-superseded').count(), 0, 'original stays visible until replacement step')
    await step(s)
    assert.equal(await s.locator('.slide.active .sim-row-status.is-superseded').count(), 1)
    await step(s, 'ArrowLeft')
    assert.equal(await s.locator('.slide.active .sim-row-status.is-superseded').count(), 0, 'Back restores earlier status')
    await s.close()
  })
  const d = await open(deck, 'defaults')
  assert.equal(await d.locator('.slide.active .sim-row-thought .sim-toggle').getAttribute('aria-expanded'), 'true', 'row override beats simulation open=none')
  await d.close()
  // Presenter, audience and late joiner share the same prefix and disclosure.
  const origin = 'https://native-rows.example.test/'
  await context.route(`${origin}**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: model.fullHtml }))
  const presenter = await context.newPage()
  await presenter.goto(`${origin}?presenter=1&session=rows#rows`)
  const audience = await context.newPage()
  await audience.goto(`${origin}?audience=1&session=rows#rows`)
  await presenter.waitForTimeout(500)
  await step(presenter)
  await audience.waitForTimeout(400)
  assert.equal(await hidden(audience), 5)
  await audience.locator('.slide.active .sim-row-thought .sim-toggle').click()
  await presenter.waitForTimeout(600)
  const current = () => presenter.evaluate(() => document.querySelector('#currentPreview iframe')?.contentDocument?.querySelector('.sim-row-thought .sim-toggle')?.getAttribute('aria-expanded'))
  assert.equal(await current(), 'true')
  const paneToggle = () => presenter.evaluate(() => {
    const frame = document.querySelector('#currentPreview iframe')
    const control = frame.contentDocument.querySelector('.sim-row-thought .sim-toggle')
    const f = frame.getBoundingClientRect(), r = control.getBoundingClientRect(), scale = f.width / 1280
    return { x: f.left + (r.left + r.width / 2) * scale, y: f.top + (r.top + r.height / 2) * scale }
  })
  let at = await paneToggle()
  await presenter.mouse.click(at.x, at.y)
  await audience.waitForTimeout(500)
  assert.equal(await audience.locator('.slide.active .sim-row-thought .sim-toggle').getAttribute('aria-expanded'), 'false', 'Current-pane click reaches the audience')
  assert.equal(await hidden(audience), 5, 'Current-pane disclosure does not advance the prefix')
  at = await paneToggle()
  await presenter.mouse.click(at.x, at.y)
  await audience.waitForTimeout(500)
  const late = await context.newPage()
  await late.goto(`${origin}?audience=1&session=rows`)
  await late.waitForTimeout(700)
  assert.equal(await hidden(late), 5)
  assert.equal(await late.locator('.slide.active .sim-row-thought .sim-toggle').getAttribute('aria-expanded'), 'true')
  await step(presenter, 'ArrowLeft')
  await audience.waitForTimeout(400)
  assert.equal(await hidden(audience), 6)
  await t.test('mixed slide status stays in step for presenter Current pane and audience, forward and Back', async () => {
    const leader = await context.newPage()
    const follower = await context.newPage()
    try {
      await leader.goto(`${origin}?presenter=1&session=mixed#status`)
      await follower.goto(`${origin}?audience=1&session=mixed#status`)
      await leader.waitForTimeout(700)
      const snapshot = (page, pane) => page.evaluate((pane) => {
        const root = pane ? document.querySelector('#currentPreview iframe')?.contentDocument : document
        const rows = root?.querySelectorAll('.slide.active .sim-row-status')
        return rows ? Array.from(rows, (row) => ({ superseded: row.classList.contains('is-superseded'), state: row.dataset.modeState })) : []
      }, pane)
      const check = async (superseded, nextVisible) => {
        await follower.waitForTimeout(500)
        const audienceRows = await snapshot(follower, false)
        assert.equal(audienceRows[0].superseded, superseded)
        assert.equal(audienceRows[1].state !== 'hidden', nextVisible)
        assert.deepEqual(await snapshot(leader, true), audienceRows, 'Current pane matches audience')
      }
      await step(leader); await step(leader)
      await check(false, false)
      await step(leader)
      await check(true, true)
      await step(leader, 'ArrowLeft')
      await check(false, false)
    } finally { await leader.close(); await follower.close() }
  })
  const l = await open(deck, 'long')
  await step(l)
  const metrics = await l.evaluate(() => {
    const scroller = document.querySelector('.slide.active .sim-scroll')
    const body = scroller.querySelector('.sim-row-files .sim-row-body')
    return { overflow: scroller.scrollHeight - scroller.clientHeight, font: getComputedStyle(body).fontSize }
  })
  assert.ok(metrics.overflow > 1000, 'long native payloads scroll instead of shrinking')
  const box = await l.locator('.slide.active .sim-scroll').boundingBox()
  await l.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await l.mouse.wheel(0, -10000)
  await l.waitForTimeout(350)
  assert.equal(await l.locator('.slide.active .sim-row-files .sim-row-body').evaluate((el) => getComputedStyle(el).fontSize), metrics.font)
  await l.close()
  // Static handout has a complete flowing transcript beyond the bounded poster.
  const h = await open(handout, 'long')
  assert.equal(await h.locator('.sim-transcript:not([hidden])').count(), 1)
  assert.match(await h.locator('.sim-transcript:not([hidden])').innerText(), /Sample line 90[\s\S]*Final detail sentinel/)
  const rect = await h.locator('.sim-transcript:not([hidden])').boundingBox()
  assert.ok(rect.height > 1080, 'long transcript flows beyond the slide height')
  assert.ok((await h.locator('#stageFit').boundingBox()).height > 500, 'transcript does not collapse the poster stage')
  await h.evaluate(() => window.scrollTo(0, 1800))
  assert.ok(await h.evaluate(() => window.scrollY > 1000), 'desktop readers can scroll through the complete transcript')
  assert.equal(await h.locator('.slide.active .sim-composer').evaluate((el) => getComputedStyle(el).display), 'none', 'static transcript omits the empty composer')
  const mobile = await open(handout, 'long')
  await mobile.setViewportSize({ width: 390, height: 844 })
  await mobile.reload()
  await mobile.waitForTimeout(400)
  const phoneText = await mobile.locator('#phoneScript').innerText()
  assert.match(phoneText, /Sample line 90[\s\S]*Final detail sentinel/)
  await t.test('phone companion keeps the authored script and unrelated code beside the transcript', () => {
    assert.ok(phoneText.includes(speakerScript))
    assert.match(phoneText, /const preservedCode = 42;/)
  })
  assert.doesNotMatch(phoneText, /turn files/, 'phone companion reads the transcript rather than raw outline syntax')
  await mobile.close()
  const missing = missingPopplerTools('pdftotext')
  reportMissingPoppler('Chat simulation PDF text checks', missing)
  for (const [page, name] of [[h, 'handout'], [p, 'deck']]) {
    const pdf = join(dir, `${name}.pdf`)
    await page.pdf({ path: pdf, printBackground: true })
    if (missing.length === 0) {
      const text = execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' })
      // Layout extraction can interleave poster columns; this unique token identifies the script block.
      assert.match(text, /SpeakerScriptSentinel42:/, `${name} PDF keeps the script`)
      assert.match(text, /Sample line 90/, `${name} PDF includes the final source line`)
      assert.match(text, /Final detail sentinel/, `${name} PDF includes all detail`)
    }
    if (name === 'deck') assert.equal(await page.locator('.sim-print-transcript').count(), 0, 'print clones are cleaned up')
  }
  assert.deepEqual(errors, [])
  console.log('PASS native runtime stepping, Back, status, disclosures, paired/late audience, flowing handout' + (missing.length ? '' : ' and complete PDFs'))
} finally {
  await browser?.close()
  await rm(dir, { recursive: true, force: true })
}

})
