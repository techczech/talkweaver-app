// A web page on a slide (`[Embed: https://…]`): what the compiler emits for it, and how main makes the
// audience window's copy follow the presenter pane's scrolling (src/main/remote-page-follow.ts).
//   - compile: a remote web page gets the remote sandbox (its own origin, no pop-ups, no top
//     navigation); a video player and a local page keep their markup; the "Open <host> ↗" link is an
//     ordinary link to the address exactly as written (query and fragment kept), on the slide and on
//     the published page; an address that is not http(s) is never a remote frame;
//   - follow: only the pane frame by name, only copies at exactly the pane's address, only direct
//     http(s) frames; a page's answer is used only when it is four finite numbers, and only numbers
//     main formats go into the script it sends; a page that does not answer is not asked again until
//     it does; a copy that appears later is put in place; both windows gone stops it.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { EMBED_SANDBOX_REMOTE } from '../compiler/scripts/lib/embed-frame.mjs'
import { FOLLOW_INTERVAL_MS, PANE_FRAME_NAME, READ_SCROLL, followRemotePages, scrollFraction, scrollToScript } from '../src/main/remote-page-follow.ts'

let passed = 0
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`) } catch (err) { console.error(`  FAIL ${name}`); throw err }
}

const dir = mkdtempSync(join(tmpdir(), 'tw-remote-page-'))
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
const LANGUAGE_LOG = 'https://languagelog.ldc.upenn.edu/nll/?p=60956'
const QUERY_FRAGMENT = 'https://example.org/a?x=1&y=two#sec-2'
writeFileSync(join(dir, 'page.html'), '<!doctype html><title>Local</title><body>LOCAL-MARKER</body>')
const outline = `---\ntitle: Remote\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n### Log {id=log}\n\n[Embed: ${LANGUAGE_LOG}]\n\n### Query {id=query}\n\n[Embed: ${QUERY_FRAGMENT}]\n\n### Video {id=video}\n\n[Embed: https://www.youtube.com/watch?v=dQw4w9WgXcQ]\n\n### Local {id=local}\n\n[Embed: page.html]\n\n### Script {id=script}\n\n[Embed: javascript:alert(1)]\n`
const outlinePath = join(dir, 'remote-outline.md')
writeFileSync(outlinePath, outline)
const model = await prepareSource(outlinePath, outline, null, statSync(outlinePath), {}, {})
const slides = extractSlides(model.fullHtml)
const figure = (id) => (slides.find((s) => s.id === id)?.html.match(/<figure class="slide-embed[\s\S]*?<\/figure>/) ?? [''])[0]
const sandboxOf = (html) => /<iframe[^>]*\ssandbox="([^"]*)"/.exec(html)?.[1] ?? null

await test('a remote web page runs in the remote sandbox: no pop-ups, no top navigation, no downloads', () => {
  for (const id of ['log', 'query']) {
    assert.equal(sandboxOf(figure(id)), EMBED_SANDBOX_REMOTE.join(' '), id)
    assert.ok(!/allow-top-navigation|allow-popups|allow-downloads/.test(figure(id)), id)
  }
})

await test('a video player and a local page keep their own markup', () => {
  const video = figure('video')
  assert.ok(video.includes('data-embed-video="1"') && sandboxOf(video) === null, 'the video player is not given the page sandbox')
  assert.ok(!video.includes('embed-open-link'), 'and has no Open link (the player has its own)')
  const local = figure('local')
  assert.ok(local.includes('data-embed="local"') && sandboxOf(local) === 'allow-scripts allow-forms', 'the local page keeps its opaque sandbox')
  assert.ok(model.fullHtml.includes('LOCAL-MARKER') || local.includes('LOCAL-MARKER'), 'and its bytes are inlined')
})

await test('the Open link is an ordinary link to the address as written, query and fragment kept', () => {
  const href = (html) => /<a class="embed-open-link" href="([^"]*)" target="_blank" rel="noopener">([^<]*)</.exec(html)
  const log = href(figure('log'))
  assert.equal(log[1], LANGUAGE_LOG)
  assert.equal(log[2], 'Open languagelog.ldc.upenn.edu ↗')
  assert.equal(href(figure('query'))[1].replace(/&amp;/g, '&'), QUERY_FRAGMENT)
  const share = buildShareHtml({ title: 'Remote', slug: 'remote', includeNotes: false, license: null, styles: extractStyles(model.fullHtml), slides })
  const links = [...share.matchAll(/<a class="embed-open-link" href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'))
  assert.deepEqual(links, [LANGUAGE_LOG, QUERY_FRAGMENT], 'the published page carries the same two links')
})

await test('an address that is not http(s) is never a remote frame or a link', () => {
  const html = figure('script')
  assert.ok(!/<iframe[^>]*(?:data-src|src)="javascript:/i.test(html), html)
  assert.ok(!html.includes('embed-open-link'), html)
})

// Review finding (2026-10-27): a page whose address merely CONTAINS a player path was drawn as a video
// player: no sandbox, no Open link. Only the player at its own https origin, at its own endpoint, is one.
const LOOKALIKES = [
  'https://attacker.example/youtube-nocookie.com/embed/x',
  'https://attacker.example/x?u=player.vimeo.com/video/x',
  'https://attacker.example/#youtube-nocookie.com/embed/x',
  'http://www.youtube-nocookie.com/embed/x',
  'https://www.youtube-nocookie.com.attacker.example/embed/x',
  'https://player.vimeo.com.attacker.example/video/x',
  'https://user@player.vimeo.com/video/x',
  'https://www.youtube-nocookie.com/embed/abc%2F..%2F..%2Fx',
  'https://www.youtube-nocookie.com:8443/embed/x',
  'https://evil.player.vimeo.com/video/x',
]
const LEGITIMATE = {
  watch: ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s', /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?t=42s&amp;enablejsapi=1$/],
  short: ['https://youtu.be/dQw4w9WgXcQ?si=abc', /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?si=abc&amp;enablejsapi=1$/],
  nocookie: ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=30', /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?start=30&amp;enablejsapi=1$/],
  vimeo: ['https://vimeo.com/76979871#t=30', /^https:\/\/player\.vimeo\.com\/video\/76979871$/],
}
const hostileOutline = `---\ntitle: Lookalikes\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n${LOOKALIKES.map((url, i) => `### Embed ${i} {id=embed-${i}}\n\n[Embed: ${url}]\n\n### Bare ${i} {id=bare-${i}}\n\n${url}\n`).join('\n')}\n${Object.entries(LEGITIMATE).map(([id, [url]]) => `### ${id} {id=${id}}\n\n[Embed: ${url}]\n`).join('\n')}`
const hostilePath = join(dir, 'lookalike-outline.md')
writeFileSync(hostilePath, hostileOutline)
const hostileSlides = extractSlides((await prepareSource(hostilePath, hostileOutline, null, statSync(hostilePath), {}, {})).fullHtml)
const hostileFigure = (id) => (hostileSlides.find((s) => s.id === id)?.html.match(/<figure class="slide-embed[\s\S]*?<\/figure>/) ?? [''])[0]

await test('an address that only contains a player path is a web page: sandboxed, with its Open link', () => {
  LOOKALIKES.forEach((url, i) => {
    for (const id of [`embed-${i}`, `bare-${i}`]) {
      const html = hostileFigure(id)
      assert.ok(html, `${id} (${url}) compiles to an embed`)
      assert.ok(!html.includes('data-embed-video'), `${id} (${url}) is not marked as a video player: ${html}`)
      assert.ok(!html.includes('slide-embed-video'), `${id} (${url}) is not drawn as a video player`)
      assert.equal(sandboxOf(html), EMBED_SANDBOX_REMOTE.join(' '), `${id} (${url}) runs in the remote sandbox`)
      assert.ok(html.includes('class="embed-open-link"'), `${id} (${url}) keeps its Open link`)
    }
  })
})

await test('a real YouTube or Vimeo address still becomes its player, query kept', () => {
  for (const [id, [url, player]] of Object.entries(LEGITIMATE)) {
    const html = hostileFigure(id)
    const src = /<iframe data-src="([^"]*)"/.exec(html)?.[1] ?? ''
    assert.match(src, player, `${id} (${url}) → ${src}`)
    assert.ok(html.includes('data-embed-video="1"') && sandboxOf(html) === null && !html.includes('embed-open-link'), `${id} stays a player: ${html}`)
  }
})

await test('a page answer is used only when it is four finite numbers', () => {
  assert.deepEqual(scrollFraction([0, 500, 0, 1000]), { fx: 0, fy: 0.5 })
  assert.deepEqual(scrollFraction([0, 5000, 0, 1000]), { fx: 0, fy: 1 })
  assert.deepEqual(scrollFraction([0, -3, 0, 1000]), { fx: 0, fy: 0 })
  assert.deepEqual(scrollFraction([10, 10, 0, 0]), { fx: 0, fy: 0 })
  for (const hostile of [null, undefined, 'x', {}, [1, 2, 3], [1, 2, 3, 4, 5], [1, '2', 3, 4], [1, NaN, 3, 4], [1, Infinity, 3, 4], [{ toString: () => '1' }, 0, 0, 0]]) {
    assert.equal(scrollFraction(hostile), null, JSON.stringify(hostile))
  }
})

await test('the script main sends carries only numbers it formatted and clamped', () => {
  assert.match(scrollToScript(0.25, 0.5), /scrollTo\(Math\.round\(0\.25000 \* .*\), Math\.round\(0\.50000 \* .*\)\)/)
  assert.ok(scrollToScript(7, -2).includes('1.00000') && scrollToScript(7, -2).includes('0.00000'))
  assert.ok(scrollToScript(NaN, Infinity).includes('0.00000'))
  assert.ok(!/[`'"]/.test(scrollToScript(0.1, 0.2).replace(/document\.scrollingElement/g, '')), 'no string literal in the script')
})

// Fake windows: frames record what main asks them to run.
const frame = (name, url, answer) => {
  const ran = []
  return { name, url, ran, answer, executeJavaScript(code) { ran.push(code); if (code === READ_SCROLL) return typeof this.answer === 'function' ? this.answer() : Promise.resolve(this.answer); return Promise.resolve(undefined) } }
}
const contents = (frames) => ({ destroyed: false, isDestroyed() { return this.destroyed }, mainFrame: { frames } })
const clock = () => {
  let fn = null
  const timers = { setInterval: (f, ms) => { assert.equal(ms, FOLLOW_INTERVAL_MS); fn = f; return 1 }, clearInterval: () => { fn = null }, setTimeout: (f) => { timers.pending = f; return 2 }, pending: null }
  return { timers, tick: async () => { fn?.(); for (let i = 0; i < 5; i++) await Promise.resolve() }, running: () => fn !== null }
}
const scrolls = (f) => f.ran.filter((code) => code !== READ_SCROLL)

await test('follow: the pane by name, copies at exactly its address, only http(s) frames', async () => {
  const pane = frame(PANE_FRAME_NAME, LANGUAGE_LOG, [0, 1000, 0, 4000])
  const decoyPane = frame('', LANGUAGE_LOG, [0, 3000, 0, 4000])
  const copy = frame('', LANGUAGE_LOG)
  const other = frame('', 'https://languagelog.ldc.upenn.edu/nll/?p=1')
  const local = frame('', 'about:srcdoc')
  const c = clock()
  followRemotePages(contents([decoyPane, pane]), contents([copy, other, local]), c.timers)
  await c.tick()
  assert.deepEqual(scrolls(copy), [scrollToScript(0, 0.25)])
  assert.deepEqual(decoyPane.ran, [], 'a frame of the same page not named as the pane is never read')
  assert.deepEqual(other.ran, [], 'another address is never touched')
  assert.deepEqual(local.ran, [], 'a local page is never touched')
  await c.tick()
  assert.equal(scrolls(copy).length, 1, 'an unchanged position is not sent again')
  pane.answer = [0, 2000, 0, 4000]
  await c.tick()
  assert.deepEqual(scrolls(copy).at(-1), scrollToScript(0, 0.5))
})

await test('follow: a hostile answer moves nothing; a page that does not answer is not asked again until it does', async () => {
  let release
  const pane = frame(PANE_FRAME_NAME, LANGUAGE_LOG, ['1; alert(1)', 0, 0, 0])
  const copy = frame('', LANGUAGE_LOG)
  const c = clock()
  followRemotePages(contents([pane]), contents([copy]), c.timers)
  await c.tick()
  assert.deepEqual(scrolls(copy), [])
  pane.answer = () => new Promise((resolve) => { release = resolve })
  await c.tick()
  c.timers.pending?.()
  for (let i = 0; i < 5; i++) await Promise.resolve()
  const asked = pane.ran.length
  await c.tick(); await c.tick()
  assert.equal(pane.ran.length, asked, 'not asked again while a read is outstanding')
  pane.answer = [0, 100, 0, 400]
  release([0, 100, 0, 400])
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await c.tick()
  assert.deepEqual(scrolls(copy).at(-1), scrollToScript(0, 0.25), 'it follows again once the page answers')
})

await test('follow: a copy that appears later is put in place; a closed window stops it', async () => {
  const pane = frame(PANE_FRAME_NAME, LANGUAGE_LOG, [0, 300, 0, 1200])
  const audienceFrames = []
  const audience = contents(audienceFrames)
  const c = clock()
  followRemotePages(contents([pane]), audience, c.timers)
  await c.tick()
  const late = frame('', LANGUAGE_LOG)
  audienceFrames.push(late)
  await c.tick()
  assert.deepEqual(scrolls(late), [scrollToScript(0, 0.25)])
  audience.destroyed = true
  await c.tick()
  assert.equal(c.running(), false, 'the interval is cleared')
})

// Review finding (2026-10-27): a read that answers after the pane has moved on must not be applied.
// `navigable` fakes WebContents' did-frame-navigate; a deferred read is released after the change.
const navigable = (frames) => {
  const c = contents(frames)
  const listeners = []
  c.on = (event, fn) => { assert.equal(event, 'did-frame-navigate'); listeners.push(fn) }
  c.removeListener = (event, fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1) }
  c.navigate = (frame, url) => { frame.url = url; for (const fn of [...listeners]) fn({}, url, 200, 'OK', false, frame.processId, frame.routingId) }
  c.listeners = listeners
  return c
}
const deferred = (pane) => { let release; pane.answer = () => new Promise((resolve) => { release = resolve }); return (value) => release(value) }
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const OTHER = 'https://semanticmachines.fyi/'

await test('follow: a read from a page the pane has left is dropped (another address)', async () => {
  const pane = Object.assign(frame(PANE_FRAME_NAME, LANGUAGE_LOG), { processId: 1, routingId: 10 })
  const oldCopy = frame('', LANGUAGE_LOG), newCopy = frame('', OTHER)
  const presenter = navigable([pane])
  const c = clock()
  followRemotePages(presenter, contents([oldCopy, newCopy]), c.timers)
  const release = deferred(pane)
  await c.tick()
  presenter.navigate(pane, OTHER)
  release([0, 3000, 0, 4000])
  await settle()
  assert.deepEqual(scrolls(newCopy), [], 'the old page position is never sent to the new page copies')
  assert.deepEqual(scrolls(oldCopy), [], 'nor to copies of the page the pane left')
  pane.answer = [0, 100, 0, 1000]
  await c.tick()
  assert.deepEqual(scrolls(newCopy), [scrollToScript(0, 0.1)], 'the next read of the current page is applied')
})

await test('follow: a read from the document before a reload at the same address is dropped', async () => {
  const pane = Object.assign(frame(PANE_FRAME_NAME, LANGUAGE_LOG), { processId: 1, routingId: 10 })
  const copy = frame('', LANGUAGE_LOG)
  const presenter = navigable([pane])
  const c = clock()
  followRemotePages(presenter, contents([copy]), c.timers)
  const release = deferred(pane)
  await c.tick()
  presenter.navigate(pane, LANGUAGE_LOG)
  release([0, 3000, 0, 4000])
  await settle()
  assert.deepEqual(scrolls(copy), [], 'the old document position is not applied after the reload')
  pane.answer = [0, 0, 0, 4000]
  await c.tick()
  assert.deepEqual(scrolls(copy), [scrollToScript(0, 0)], 'the reloaded document is followed from where it is')
})

await test('follow: a read from a pane frame that was replaced at the same address is dropped', async () => {
  const pane = Object.assign(frame(PANE_FRAME_NAME, LANGUAGE_LOG), { processId: 1, routingId: 10 })
  const copy = frame('', LANGUAGE_LOG)
  const presenterFrames = [pane]
  const c = clock()
  followRemotePages(contents(presenterFrames), contents([copy]), c.timers)
  const release = deferred(pane)
  await c.tick()
  presenterFrames[0] = Object.assign(frame(PANE_FRAME_NAME, LANGUAGE_LOG, [0, 0, 0, 4000]), { processId: 1, routingId: 11 })
  release([0, 3000, 0, 4000])
  await settle()
  assert.deepEqual(scrolls(copy), [], 'the old frame position is not applied to the new frame copies')
})

await test('follow: a window closed during a read stops it; copies are those present when the answer comes', async () => {
  const pane = frame(PANE_FRAME_NAME, LANGUAGE_LOG)
  const gone = frame('', LANGUAGE_LOG), late = frame('', LANGUAGE_LOG)
  const audienceFrames = [gone]
  const audience = contents(audienceFrames)
  const c = clock()
  const presenter = navigable([pane])
  followRemotePages(presenter, audience, c.timers)
  let release = deferred(pane)
  await c.tick()
  audienceFrames.splice(0, 1, late)
  release([0, 500, 0, 1000])
  await settle()
  assert.deepEqual(scrolls(gone), [], 'a copy that left during the read is not scripted')
  assert.deepEqual(scrolls(late), [scrollToScript(0, 0.5)], 'a copy that arrived during the read is')
  release = deferred(pane)
  await c.tick()
  audience.destroyed = true
  release([0, 900, 0, 1000])
  await settle()
  assert.equal(scrolls(late).length, 1, 'nothing is sent once the audience window is gone')
  assert.equal(c.running(), false, 'and the interval is cleared')
  assert.equal(presenter.listeners.length, 0, 'and the navigation listener removed')
})

console.log(`remote page embed: ${passed} passed`)
