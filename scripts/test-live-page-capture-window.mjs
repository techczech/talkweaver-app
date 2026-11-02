// Capture embed… (src/main/live-page-capture-window.ts, src/renderer/src/lib/captureEmbed.ts): the
// editor's request checked field by field; the existing views' pictures read only from the talk's own
// folder, never through a link, bounded; the one call into the window's page carries JSON only; the
// inspector's count is the slide's {capture} lines now. Plain Node, a scratch talk under research/.
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CAPTURE_EMBED_MAX_PICTURES, CAPTURE_EMBED_TEXT, captureEmbedInitScript, checkCaptureEmbedRequest, readCaptureEmbedViews
} from '../src/main/live-page-capture-window.ts'
import { openCaptureEmbed, savedViewsLabel, slideLivePages } from '../src/renderer/src/lib/captureEmbed.ts'
import { MAX_CAPTURE_IMAGE_BYTES } from '../compiler/scripts/lib/live-page-captures.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
let passed = 0
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`) } catch (err) { console.error(`  FAIL ${name}`); throw err }
}
fs.mkdirSync(new URL('../research/', import.meta.url), { recursive: true })
const scratch = fs.mkdtempSync(join(repo, 'research/scratch-live-page-capture-window-'))
const vault = join(scratch, 'vault')
const talkDir = join(vault, 'talks', 'radio')
fs.mkdirSync(join(talkDir, 'assets', 'live-page-captures'), { recursive: true })
const outlinePath = join(talkDir, 'radio-outline.md')
fs.writeFileSync(outlinePath, '### Radio\n\n[Embed: https://example.com]\n')
const writable = (p) => (p.startsWith(vault) ? vault : undefined)
const pic = (hex) => `assets/live-page-captures/${hex.repeat(16).slice(0, 16)}.jpg`
const jpeg = (n = 16) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(n).fill(7)])
const good = { outlinePath, slideId: 'radio', pageUrl: 'https://example.com', title: 'Radio', images: [pic('a')] }

console.log('live page capture window')

await test('request: talk in a writable vault, an id, a web page; only capture picture paths; title cleaned', () => {
  const ok = checkCaptureEmbedRequest(good, { writableTalkRoot: writable })
  assert.equal(ok.ok, true)
  assert.deepEqual([ok.request.pageUrl, ok.request.root, ok.request.images], ['https://example.com/', vault, [pic('a')]])
  const refused = (over, words) => {
    const r = checkCaptureEmbedRequest({ ...good, ...over }, { writableTalkRoot: writable })
    assert.equal(r.ok, false, JSON.stringify(over)); assert.equal(r.message, words)
  }
  refused({ outlinePath: join(scratch, 'elsewhere', 'x-outline.md') }, CAPTURE_EMBED_TEXT.noTalk)
  refused({ outlinePath: join(talkDir, 'notes.md') }, CAPTURE_EMBED_TEXT.noTalk)
  refused({ outlinePath: `${outlinePath}\0-outline.md` }, CAPTURE_EMBED_TEXT.noTalk)
  for (const slideId of ['', '../x', 'a b', 'x'.repeat(129), 7]) refused({ slideId }, CAPTURE_EMBED_TEXT.noSlide)
  for (const pageUrl of ['file:///etc/passwd', 'http://127.0.0.1:8080/', 'http://192.168.1.2/', 'javascript:alert(1)', '', null]) refused({ pageUrl }, CAPTURE_EMBED_TEXT.notWebPage)
  assert.equal(checkCaptureEmbedRequest(null, { writableTalkRoot: writable }).ok, false)
  const odd = checkCaptureEmbedRequest({ ...good, title: 'A\u0000b\nc', images: [pic('a'), '../../etc/passwd', 'assets/x.jpg', pic('a'), 5, pic('b')] }, { writableTalkRoot: writable })
  assert.deepEqual(odd.request.images, [pic('a'), pic('b')], 'only the writer\'s picture paths, once each')
  assert.equal(odd.request.title, 'A b c')
})

await test('pictures: from the talk folder only, never through a link; regular JPEG files under the limit; bounded in number', () => {
  const dir = join(talkDir, 'assets', 'live-page-captures')
  fs.writeFileSync(join(talkDir, pic('a')), jpeg())
  fs.writeFileSync(join(talkDir, pic('c')), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]))
  fs.writeFileSync(join(talkDir, pic('d')), new Uint8Array(MAX_CAPTURE_IMAGE_BYTES + 1).fill(0xff))
  const outside = join(scratch, 'outside.jpg'); fs.writeFileSync(outside, jpeg())
  fs.symlinkSync(outside, join(talkDir, pic('e')))
  fs.mkdirSync(join(talkDir, pic('f')))
  const views = readCaptureEmbedViews(outlinePath, [pic('a'), pic('b'), pic('c'), pic('d'), pic('e'), pic('f'), '../outside.jpg'].map((image) => ({ image, alt: 'Saved view' })))
  assert.deepEqual(views.map((v) => v.src !== null), [true, false, false, false, false, false, false], 'only the real JPEG in the talk')
  assert.match(views[0].src, /^data:image\/jpeg;base64,/)
  // A linked saved-view folder: nothing is read through it.
  const linkedTalk = join(vault, 'talks', 'linked'); fs.mkdirSync(join(linkedTalk, 'assets'), { recursive: true })
  fs.symlinkSync(dir, join(linkedTalk, 'assets', 'live-page-captures'))
  fs.writeFileSync(join(linkedTalk, 'linked-outline.md'), '#')
  assert.equal(readCaptureEmbedViews(join(linkedTalk, 'linked-outline.md'), [{ image: pic('a') }])[0].src, null)
  // Many views: all listed, at most CAPTURE_EMBED_MAX_PICTURES pictures sent.
  const many = Array.from({ length: CAPTURE_EMBED_MAX_PICTURES + 5 }, () => ({ image: pic('a') }))
  const listed = readCaptureEmbedViews(outlinePath, many)
  assert.equal(listed.length, many.length)
  assert.equal(listed.filter((v) => v.src).length, CAPTURE_EMBED_MAX_PICTURES)
})

await test('pictures (review P2): the folder swapped for a link at the moment of reading returns nothing from outside; other systems read nothing', () => {
  // The reviewer's reproduction: the path was checked, then the parent folder was replaced by a link
  // to a folder outside holding a JPEG of the same name, then read. Now the read is the open itself
  // (no link in any part of the path, O_NOFOLLOW_ANY), so the swap is made just before that open.
  const swapTalk = join(vault, 'talks', 'swap'); const swapDir = join(swapTalk, 'assets', 'live-page-captures')
  fs.mkdirSync(swapDir, { recursive: true }); fs.writeFileSync(join(swapTalk, 'swap-outline.md'), '#')
  fs.writeFileSync(join(swapTalk, pic('a')), jpeg())
  const elsewhere = join(scratch, 'elsewhere-captures'); fs.mkdirSync(elsewhere, { recursive: true })
  const secret = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x53, 0x45, 0x43, 0x52, 0x45, 0x54])
  fs.writeFileSync(join(elsewhere, pic('a').split('/').pop()), secret)
  let swapped = false
  const racing = { ...fs, realpathSync: fs.realpathSync, openSync: (path, flags) => {
    if (!swapped) { fs.renameSync(swapDir, `${swapDir}-moved`); fs.symlinkSync(elsewhere, swapDir); swapped = true }
    return fs.openSync(path, flags)
  } }
  const [view] = readCaptureEmbedViews(join(swapTalk, 'swap-outline.md'), [{ image: pic('a') }], racing, true)
  assert.equal(swapped, true)
  assert.equal(view.src, null, 'nothing read through the link')
  // The same read with the folder in place gives the talk's own picture; off macOS, none at all.
  fs.rmSync(swapDir); fs.renameSync(`${swapDir}-moved`, swapDir)
  assert.equal(readCaptureEmbedViews(join(swapTalk, 'swap-outline.md'), [{ image: pic('a') }], fs, true)[0].src, `data:image/jpeg;base64,${Buffer.from(jpeg()).toString('base64')}`)
  assert.equal(readCaptureEmbedViews(join(swapTalk, 'swap-outline.md'), [{ image: pic('a') }], fs, false)[0].src, null)
})

await test('the call into the window: one fixed function, its argument JSON that cannot end the script', () => {
  const script = captureEmbedInitScript({ slideId: 's', pageUrl: 'https://example.com/', title: '</script><img src=x onerror=alert(1)>\u2028', host: 'example.com', views: [] })
  assert.ok(script.startsWith('window.__twCaptureEmbedInit && window.__twCaptureEmbedInit("'))
  assert.doesNotMatch(script, /<\/script>|\u2028/)
  const arg = JSON.parse(JSON.parse(script.slice(script.indexOf('(') + 1, -1)))
  assert.equal(arg.title, '</script><img src=x onerror=alert(1)>\u2028')
})

await test('inspector: each web page on the slide with its saved views now (empty state or n); the request names that page', async () => {
  const text = `### Radio {id=radio}\n\n[Embed: https://example.com]\n![Saved view, 27 Oct 2026 11:05](${pic('a')}){capture}\n![x](assets/other.jpg){capture}\n\nhttps://example.org/page\n\n![plain](${pic('b')})\n`
  const pages = slideLivePages(text)
  assert.deepEqual(pages.map((p) => [p.host, p.count]), [['example.com', 1], ['example.org', 0]])
  assert.deepEqual(pages[0].images, [pic('a')]); assert.deepEqual(pages[0].alts, ['Saved view, 27 Oct 2026 11:05'])
  assert.deepEqual([savedViewsLabel(0), savedViewsLabel(1), savedViewsLabel(3)], ['No saved views', '1 saved view', '3 saved views'])
  assert.deepEqual(slideLivePages('### Plain\n\n- no page\n'), [])
  const asked = []; const told = []
  const deps = { open: async (r) => { asked.push(r); return { ok: true } }, notify: (m) => told.push(m) }
  assert.equal(await openCaptureEmbed(deps, { outlinePath, slideId: 'radio', title: 'Radio', text }, 'https://example.org/page'), true)
  assert.deepEqual(asked[0], { outlinePath, slideId: 'radio', pageUrl: 'https://example.org/page', title: 'Radio', images: [], alts: [] })
  assert.equal(await openCaptureEmbed(deps, { outlinePath, slideId: 'radio', title: 'Radio', text }), true)
  assert.equal(asked[1].pageUrl, 'https://example.com/', 'no page named: the first')
  assert.equal(await openCaptureEmbed(deps, { outlinePath, slideId: 'plain', title: '', text: '### Plain\n' }), false)
  assert.equal(await openCaptureEmbed(deps, { outlinePath: null, slideId: 'radio', title: '', text }), false)
  assert.equal(await openCaptureEmbed({ ...deps, open: async () => ({ ok: false, message: 'refused here' }) }, { outlinePath, slideId: 'radio', title: '', text }), false)
  assert.equal(asked.length, 2); assert.equal(told.at(-1), 'refused here')
})

fs.rmSync(scratch, { recursive: true, force: true })
console.log(`live page capture window: ${passed} passed`)
