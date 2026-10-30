// Slide Scratchpad HTML thumbnails (src/main/scratchpad-html-thumb.ts): the cache key, the cache folder (never
// the talk's), one capture at a time, a capture again when the file changes, and no retry of a page that failed.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHtmlThumbnailer, htmlThumbKey } from '../src/main/scratchpad-html-thumb.ts'
import { isScratchPreviewUrl, previewFrame, scratchFrameNavigation } from '../src/main/scratchpad-html.ts'
import { guardWebContents } from '../src/main/navigation-guard.ts'

const root = mkdtempSync(join(tmpdir(), 'tw-scratch-thumb-'))
let checks = 0
const test = async (name, fn) => { try { await fn(); checks++ } catch (e) { console.error(`FAIL ${name}`); throw e } }
try {
  const talk = join(root, 'talk', 'scratchpad'); const cache = join(root, 'cache')
  const { mkdirSync } = await import('node:fs'); mkdirSync(talk, { recursive: true })
  const page = join(talk, 'loop.html'); writeFileSync(page, '<p>one</p>')

  await test('the key follows path, mtime and size', () => {
    const k = htmlThumbKey('/a/b.html', 1000, 10)
    assert.match(k, /^[0-9a-f]{40}$/)
    assert.equal(k, htmlThumbKey('/a/b.html', 1000, 10))
    assert.notEqual(k, htmlThumbKey('/a/c.html', 1000, 10))
    assert.notEqual(k, htmlThumbKey('/a/b.html', 2000, 10))
    assert.notEqual(k, htmlThumbKey('/a/b.html', 1000, 11))
  })

  let active = 0; let peak = 0; let captures = 0; let mode = 'ok'
  const thumb = createHtmlThumbnailer({
    cacheDir: cache, timeoutMs: 50,
    preview: async (path) => ({ url: 'twpresent://preview/' + path, sandbox: 'allow-scripts allow-forms' }),
    capture: async () => {
      captures++; active++; peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 20)); active--
      return mode === 'ok' ? Buffer.from('PNGDATA') : null
    }
  })
  await test('captures once, caches under the cache folder only, and answers from the cache', async () => {
    const url = await thumb(page)
    assert.equal(url, 'data:image/png;base64,' + Buffer.from('PNGDATA').toString('base64'))
    assert.equal(captures, 1)
    assert.equal(readdirSync(cache).length, 2, 'the picture and its text file')
    assert.deepEqual(readdirSync(talk), ['loop.html'], 'nothing written beside the agent files')
    assert.equal(await thumb(page), url); assert.equal(captures, 1)
  })
  await test('an edited file is captured again', async () => {
    writeFileSync(page, '<p>two, longer</p>')
    await thumb(page); assert.equal(captures, 2)
    const t = new Date(Date.now() + 5000); utimesSync(page, t, t)
    await thumb(page); assert.equal(captures, 3)
  })
  await test('concurrency is one, and the same page asked twice is captured once', async () => {
    const pages = ['a', 'b', 'c'].map((n) => { const p = join(talk, n + '.html'); writeFileSync(p, n); return p })
    const before = captures
    const all = await Promise.all([...pages, pages[0]].map((p) => thumb(p)))
    assert.ok(all.every((u) => u && u.startsWith('data:image/png')))
    assert.equal(captures - before, 3); assert.equal(peak, 1)
  })
  await test('a failed page gives null, is not cached and is not retried until it changes', async () => {
    mode = 'fail'
    const p = join(talk, 'bad.html'); writeFileSync(p, 'x')
    const beforeFiles = readdirSync(cache).sort()
    const before = captures
    assert.equal(await thumb(p), null); assert.equal(await thumb(p), null)
    assert.equal(captures - before, 1)
    assert.deepEqual(readdirSync(cache).sort(), beforeFiles, 'a failed page writes no cache files')
    mode = 'ok'; writeFileSync(p, 'xy')
    assert.ok(await thumb(p))
  })
  await test('the rendered text is cached with the picture under the same key and read back by textFor', async () => {
    const p = join(talk, 'widget.html'); writeFileSync(p, '<script>/* builds its words */</script>')
    const t2 = createHtmlThumbnailer({
      cacheDir: cache, timeoutMs: 50,
      preview: async (path) => ({ url: 'twpresent://preview/' + path, sandbox: 'allow-scripts allow-forms' }),
      capture: async () => ({ png: Buffer.from('PNG2'), text: 'coscientist '.repeat(5000) })
    })
    assert.equal(t2.textFor(p), '', 'nothing before a capture')
    assert.ok(await t2(p))
    assert.equal(t2.textFor(p).length, 20000, 'capped at 20k')
    assert.match(t2.textFor(p), /^coscientist/)
    const again = createHtmlThumbnailer({ cacheDir: cache, preview: async () => ({ error: 'x' }), capture: async () => null })
    assert.match(again.textFor(p), /^coscientist/, 'a new process reads it from the cache folder')
    assert.ok(await again(p), 'and the picture answers from the cache without a capture')
  })
  await test('a picture cached before the text was kept is captured once more', async () => {
    const p = join(talk, 'old.html'); writeFileSync(p, 'old')
    const { statSync } = await import('node:fs')
    const info = statSync(p)
    writeFileSync(join(cache, htmlThumbKey(p, info.mtimeMs, info.size) + '.png'), 'OLDPNG')
    let n = 0
    const t3 = createHtmlThumbnailer({ cacheDir: cache, preview: async () => ({ url: 'u', sandbox: 's' }), capture: async () => { n++; return { png: Buffer.from('NEW'), text: 'fresh words' } } })
    assert.ok(await t3(p)); assert.equal(n, 1); assert.equal(t3.textFor(p), 'fresh words')
  })
  await test('a missing file or a folder gives null without a capture', async () => {
    const before = captures
    assert.equal(await thumb(join(talk, 'nope.html')), null)
    assert.equal(await thumb(talk), null)
    assert.equal(captures, before)
  })
  const PAGE = 'twpresent://preview/scratch-0123456789abcdef01234567.html'
  await test('an agent page\'s frame may not leave its own preview address (panel and capture window)', () => {
    assert.equal(isScratchPreviewUrl(PAGE), true); assert.equal(isScratchPreviewUrl(PAGE + '#x'), true)
    assert.equal(isScratchPreviewUrl('twpresent://preview/scratch-thumb-0123456789abcdef01234567.html'), false, 'the capture wrapper is not the page')
    assert.equal(isScratchPreviewUrl('twpresent://preview/deck-1.html'), false)
    for (const to of ['twfile://f/L1VzZXJzL3gvdmF1bHQvdGFsay5tZA', 'twpresent://preview/deck-1.html', 'twpresent://talk/deck.html', 'https://example.org/', 'about:blank', 'data:text/html,x', 'file:///etc/hosts']) {
      assert.equal(scratchFrameNavigation(PAGE, to), 'deny', to)
    }
    assert.equal(scratchFrameNavigation(PAGE, PAGE), null, 'a reload of its own page is left to the general rule')
    assert.equal(scratchFrameNavigation(PAGE, PAGE + '#top'), null)
    assert.equal(scratchFrameNavigation('twpresent://preview/deck-1.html', 'twfile://f/x'), null, 'other frames keep the general rule')
    assert.equal(scratchFrameNavigation('', PAGE), null, 'the iframe\'s first load to the page is allowed')
    // The guard applies it on every window's will-frame-navigate.
    const listeners = new Map()
    const contents = { id: 3, url: 'file:///renderer/index.html', on(event, fn) { listeners.set(event, [...(listeners.get(event) ?? []), fn]); return this }, getURL() { return this.url } }
    const logged = []
    guardWebContents(contents, { openExternal: () => {}, log: (m) => logged.push(m), frameRule: scratchFrameNavigation })
    const fire = (frameUrl, url) => { const e = { url, isMainFrame: false, frame: { parent: {}, url: frameUrl }, prevented: false, preventDefault() { this.prevented = true } }; for (const fn of listeners.get('will-frame-navigate')) fn(e); return e.prevented }
    assert.equal(fire(PAGE, 'twfile://f/L1VzZXJzL3gvdmF1bHQvdGFsay5tZA'), true, 'the page cannot send its frame to a vault file')
    assert.equal(fire(PAGE, 'twpresent://talk/deck.html'), true)
    assert.equal(fire(PAGE, PAGE), false)
    assert.equal(fire('about:blank', PAGE), false, 'the panel\'s iframe loads the page')
    assert.equal(fire('twpresent://preview/deck-1.html', 'twpresent://preview/deck-2.html'), false, 'a deck preview frame is unchanged')
    assert.ok(logged.some((m) => m.includes('refused frame navigation from twpresent://preview/scratch-')))
  })
  await test('the capture reads only the one child frame on the page\'s own address', () => {
    const WRAP = 'twpresent://preview/scratch-thumb-aaaaaaaaaaaaaaaaaaaaaaaa.html'
    assert.equal(previewFrame(WRAP, [{ frame: 'F', url: PAGE }], PAGE), 'F')
    assert.equal(previewFrame(WRAP, [{ frame: 'F', url: 'twfile://f/abc' }], PAGE), null, 'a frame that went to a vault file gives no picture and no words')
    assert.equal(previewFrame(WRAP, [{ frame: 'F', url: 'twpresent://preview/deck-1.html' }], PAGE), null)
    assert.equal(previewFrame(WRAP, [], PAGE), null)
    assert.equal(previewFrame(WRAP, [{ frame: 'F', url: PAGE }, { frame: 'G', url: PAGE }], PAGE), null)
    assert.equal(previewFrame('twfile://f/abc', [{ frame: 'F', url: PAGE }], PAGE), null, 'the wrapper itself must be the preview page')
    // The window (Electron-only, so read as source): every subframe navigation but the page's own is refused,
    // the frame is checked before capturePage and before executeJavaScript, and the iframe is credentialless.
    const src = readFileSync(new URL('../src/main/scratchpad-html-capture.ts', import.meta.url), 'utf8')
    assert.match(src, /on\('will-frame-navigate'[\s\S]*?if \(!samePreviewAddress\(event\.url, preview\.url\)\) event\.preventDefault\(\)/)
    assert.ok(src.indexOf('if (!pageFrame()) return null') > 0 && src.indexOf('if (!pageFrame()) return null') < src.indexOf('capturePage()'), 'checked before the picture')
    assert.match(src, /const child = pageFrame\(\)\s*\n\s*const raw: unknown = child \? await child\.executeJavaScript/, 'checked before the words')
    assert.doesNotMatch(src, /framesInSubtree/, 'never the first frame found anywhere in the tree')
    assert.match(src, /<iframe sandbox="[^\n]*credentialless/)
    const index = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
    assert.match(index, /installNavigationGuard\(app, \{[\s\S]*?frameRule: scratchFrameNavigation[\s\S]*?\}\)/, 'the app installs the rule for every window')
  })
  console.log(`${checks} checks passed`)
} finally { rmSync(root, { recursive: true, force: true }) }
