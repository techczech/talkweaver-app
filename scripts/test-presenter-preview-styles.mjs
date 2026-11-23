// The presenter's slide pictures (Current, Next, Then) take the deck stylesheet as one shared blob:
// stylesheet instead of the whole stylesheet inlined into every picture (0.45.1 speed round: about
// 700 KB of CSS was parsed again three times per slide change). Checked in headless Chromium on a
// compiled deck:
//  0. the pure block (PREVIEW_STYLES in compiler/assets/runtime/presenter-panes.js): one URL per stylesheet text; inline where blob: would not do;
//  1. every picture links the same blob: stylesheet, and stepping through the deck keeps that one URL;
//  2. a picture's document is small (no inlined copy of the deck stylesheet);
//  3. the pictures are styled exactly as with the stylesheet inlined: the same computed style and box
//     for every element of every picture, compared with the same deck where blob: URLs are unavailable
//     (the inline fallback, which is also what the runtime does there).
// Usage: node scripts/test-presenter-preview-styles.mjs
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { presenterPanesRuntimeSource } from '../compiler/assets/runtime/presenter-panes.js'

const source = `---
title: Preview styles
auto_title_slide: false
auto_thanks_slide: false
---

## A section {id=sec}

### Columns and a list {id=cols .columns}

- First point with **bold** and *italic*
- Second point with \`code\`

| Left | Right |
|---|---|
| a | b |

### A quote {id=quote}

> Simple things should be simple, complex things should be possible.

### Cards {id=cards .cards}

- **One** — the first card
- **Two** — the second card
- **Three** — the third card

### Plain {id=plain}

A plain slide.

### Two {id=two}

Another slide.

### Three {id=three}

- One more list

### Four {id=four}

The end.
`

// ── 1. The pure block: one URL per stylesheet text, inline where a blob: sheet would not do ─────────
{
  // The module's own source, as the deck inlines it, with URL, Blob and the clock replaced.
  const made = [], revoked = []
  const noDocument = { addEventListener() {} }
  const run = (URLImpl, BlobImpl) => new Function('URL', 'Blob', 'setTimeout', 'document', `${presenterPanesRuntimeSource()}\nreturn createPresenterPanes({}).previewStylesHead`)(URLImpl, BlobImpl, (f) => f(), noDocument)
  const fakeURL = { createObjectURL: (b) => { made.push(b); return `blob:fake/${made.length}` }, revokeObjectURL: (u) => revoked.push(u) }
  const head = run(fakeURL, class { constructor(parts, o) { this.text = parts.join(''); this.type = o.type } })
  const css = '.slide { color: red } @font-face { src: url("data:font/woff2;base64,AAA") } .a { background: url(https://example.org/x.png) } .b { mask: url(#m) } .c { background-image: url( var(--x) ) }'
  assert.equal(head(css), '<link rel="stylesheet" data-preview-styles href="blob:fake/1">', 'absolute, data: and fragment addresses: one blob: stylesheet')
  assert.equal(made[0].text, css, 'the blob holds the stylesheet text unchanged')
  assert.equal(made[0].type, 'text/css')
  assert.equal(head(css), '<link rel="stylesheet" data-preview-styles href="blob:fake/1">', 'the same text reuses the same URL')
  assert.equal(made.length, 1, 'no second blob for the same text')
  assert.equal(head(css + ' .d {}'), '<link rel="stylesheet" data-preview-styles href="blob:fake/2">', 'changed text: a new URL')
  assert.deepEqual(revoked, ['blob:fake/1'], 'the old URL is revoked (later)')
  for (const rel of ['.x { background: url(assets/bg.png) }', ".x { background: url('../img.png') }", '.x { background: url(/abs.png) }', '@import "theme.css";']) {
    assert.equal(head(rel), `<style>${rel}</style>`, `inlined as before: ${rel}`)
  }
  const noBlobs = run({}, undefined)
  assert.equal(noBlobs(css), `<style>${css}</style>`, 'no blob: URLs: inlined as before')
}

// ── 2. The presenter window, rendered ───────────────────────────────────────────────────────
const PROPS = ['font-family', 'font-size', 'font-weight', 'color', 'background-color', 'display', 'grid-template-columns', 'padding-left', 'margin-top', 'line-height', 'text-align', 'border-top-width', 'opacity', 'visibility']

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-preview-styles-'))
let browser
try {
  const sourcePath = join(scratch, 'preview-styles.md')
  await writeFile(sourcePath, source)
  const model = await prepareSource(sourcePath, source, 'preview-styles', statSync(sourcePath))
  const htmlPath = join(scratch, 'preview-styles.html')
  await writeFile(htmlPath, model.fullHtml)
  const url = `${pathToFileURL(htmlPath).href}?presenter=1#sec`
  browser = await chromium.launch({ headless: true })

  const panes = ['currentPreview', 'nextPreview', 'followingPreview']
  async function open(withBlobs) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    if (!withBlobs) await context.addInitScript(() => { URL.createObjectURL = undefined })
    // 'dead': the address is made and at once revoked, so the stylesheet never loads.
    if (withBlobs === 'dead') await context.addInitScript(() => { const make = URL.createObjectURL.bind(URL); URL.createObjectURL = (o) => { const u = make(o); URL.revokeObjectURL(u); return u } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(url)
    await page.waitForSelector('#currentPreview iframe')
    return { page, errors, context }
  }
  // A pane past the end of the talk says "End" and has no picture.
  const settled = (page) => page.waitForFunction((ids) => ids.every((id) => {
    if (document.getElementById(id)?.classList.contains('preview-end')) return true
    const frames = [...document.querySelectorAll(`#${id} > iframe`)]
    return frames.length > 0 && !document.querySelector(`#${id} > iframe.preview-incoming`) && frames.every((f) => f.contentDocument?.readyState === 'complete' && f.contentDocument.querySelector('.slide'))
  }), panes, { timeout: 15000 }).catch(async (e) => {
    console.error(await page.evaluate((ids) => ids.map((id) => { const t = document.getElementById(id); return `${id}: ${t ? t.className + ' frames=' + t.querySelectorAll(':scope > iframe').length + ' ' + [...t.querySelectorAll(':scope > iframe')].map((f) => f.className + '/' + f.contentDocument?.readyState + '/' + !!f.contentDocument?.querySelector('.slide')).join(',') : 'missing'}` }), panes))
    throw e
  }).then(() => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 100))))))
  const facts = (page) => page.evaluate(({ ids, props }) => ids.map((id) => {
    const frame = document.querySelector(`#${id} > iframe`)
    if (!frame) return { id, none: true }
    const doc = frame.contentDocument
    const view = frame.contentWindow
    const links = [...doc.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute('href'))
    const inline = [...doc.querySelectorAll('style')].reduce((n, s) => n + s.textContent.length, 0)
    const elements = [...doc.querySelectorAll('.stage *')].map((el) => {
      const cs = view.getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return [el.tagName, ...props.map((p) => cs.getPropertyValue(p)), Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join('|')
    })
    return { id, links, inline, srcdocLength: frame.getAttribute('srcdoc').length, sheets: doc.styleSheets.length, elements }
  }), { ids: panes, props: PROPS })

  const withBlob = await open(true)
  const withoutBlob = await open(false)
  const seen = new Set()
  let pictures = 0
  for (let step = 0; step < 4; step++) {
    await Promise.all([settled(withBlob.page), settled(withoutBlob.page)])
    const a = await facts(withBlob.page)
    const b = await facts(withoutBlob.page)
    assert.ok(a.filter((f) => !f.none).length >= 2, `step ${step}: at least two panes have a picture`)
    for (let i = 0; i < panes.length; i++) {
      const what = `step ${step}, ${panes[i]}`
      assert.equal(!!a[i].none, !!b[i].none, `${what}: the same panes have pictures`)
      if (a[i].none) continue
      pictures++
      assert.equal(a[i].links.length, 1, `${what}: the picture links one stylesheet`)
      assert.match(a[i].links[0], /^blob:/, `${what}: the stylesheet is a blob: URL`)
      seen.add(a[i].links[0])
      assert.ok(a[i].inline < 5000, `${what}: no inlined copy of the deck stylesheet (${a[i].inline} characters of <style>)`)
      assert.ok(a[i].srcdocLength < b[i].srcdocLength / 2, `${what}: the picture's document is far smaller than with the stylesheet inlined (${a[i].srcdocLength} vs ${b[i].srcdocLength})`)
      assert.equal(b[i].links.length, 0, `${what}: without blob: URLs the stylesheet is inlined`)
      assert.ok(b[i].inline > 50000, `${what}: the inline fallback carries the deck stylesheet`)
      assert.ok(a[i].elements.length > 3, `${what}: the picture has a slide`)
      assert.deepEqual(a[i].elements, b[i].elements, `${what}: every element is styled and placed exactly as with the stylesheet inlined`)
    }
    await withBlob.page.keyboard.press('ArrowRight')
    await withoutBlob.page.keyboard.press('ArrowRight')
  }
  assert.ok(pictures >= 10, `enough pictures compared (${pictures})`)
  assert.equal(seen.size, 1, 'every picture, at every step, shares one stylesheet URL')
  assert.deepEqual(withBlob.errors, [], 'no page errors with the shared stylesheet')
  assert.deepEqual(withoutBlob.errors, [], 'no page errors with the inline fallback')
  // 4. A blob: stylesheet that does not load: every picture is drawn again with the text inline,
  //    styled and placed exactly as the inline version, and later pictures go inline at once.
  const dead = await open('dead')
  const inlineAgain = await open(false)
  for (let step = 0; step < 3; step++) {
    await Promise.all([settled(dead.page), settled(inlineAgain.page)])
    await dead.page.waitForFunction((ids) => ids.every((id) => { const f = document.querySelector(`#${id} > iframe`); return !f || !f.contentDocument.querySelector('link[data-preview-styles]') }), panes, { timeout: 15000 })
    await settled(dead.page)
    const a = await facts(dead.page)
    const b = await facts(inlineAgain.page)
    for (let i = 0; i < panes.length; i++) {
      const what = `failed stylesheet, step ${step}, ${panes[i]}`
      assert.equal(!!a[i].none, !!b[i].none, `${what}: the same panes have pictures`)
      if (a[i].none) continue
      assert.equal(a[i].links.length, 0, `${what}: no dead stylesheet link is left`)
      assert.ok(a[i].inline > 50000, `${what}: the deck stylesheet is inline`)
      assert.deepEqual(a[i].elements, b[i].elements, `${what}: styled and placed exactly as the inline version`)
    }
    await dead.page.keyboard.press('ArrowRight')
    await inlineAgain.page.keyboard.press('ArrowRight')
  }
  assert.deepEqual(dead.errors, [], 'no page errors when the shared stylesheet fails to load')
  console.log('PASS a blob: stylesheet that fails to load falls back to the inline stylesheet')
  console.log(`PASS presenter pictures share one blob: stylesheet (${seen.size} URL for ${pictures} pictures over 4 steps) and are styled exactly as with it inlined`)
} finally {
  await browser?.close()
  await rm(scratch, { recursive: true, force: true })
}
