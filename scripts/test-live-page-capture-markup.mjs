// Saved views as slide markup (compiler/scripts/lib/live-page-capture-markup.mjs): the {capture} line,
// the one-line outline edit the capture writer makes (withCaptureLine), and the compiler reading the
// lines as the page's gallery (alternatives to the live page, never ordinary images), with the views
// recorded before the markup still shown for a page that has no {capture} line. Plain Node, scratch
// vault under research/, no Electron, no browser.
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CAPTURE_VIEWS_MARKER as MARK, blankHtmlCommentsKeepingCaptureMarkers, captureMarkupLine, captureMarkupOfSlideText, embedLinePageUrl, readCaptureLine, slideHeadingRef, placeCaptureLines, withCaptureLine
} from '../compiler/scripts/lib/live-page-capture-markup.mjs'
import { writeCaptureInWorkingFolder } from '../src/main/live-page-capture-core.ts'
import { loadOutlineTools } from '../src/main/instant-slide-insert.ts'

const repo = fileURLToPath(new URL('..', import.meta.url))
let passed = 0
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`) } catch (err) { console.error(`  FAIL ${name}`); throw err }
}
fs.mkdirSync(new URL('../research/', import.meta.url), { recursive: true })
const scratch = fs.mkdtempSync(join(repo, 'research/scratch-live-page-capture-markup-'))
const home = process.cwd()
const SITE = 'https://example.org'
const PAGE = `${SITE}/`
const A = 'assets/live-page-captures/aaaaaaaaaaaaaaaa.jpg'
const B = 'assets/live-page-captures/bbbbbbbbbbbbbbbb.jpg'
const line = (img, mode) => captureMarkupLine(img, '2026-10-27T11:05:00.000Z', mode)

console.log('live page capture markup')

await test('the {capture} line: image syntax + token; only the writer\'s pictures are saved views; words say what and when', () => {
  assert.equal(line(A), `![Saved view, 27 Oct 2026 11:05](${A}){capture}`)
  assert.equal(line(B, 'page'), `![Entire page, 27 Oct 2026 11:05](${B}){capture}`)
  assert.throws(() => captureMarkupLine('assets/x.jpg', '2026-10-27T11:05:00.000Z'), /capture-invalid/)
  assert.deepEqual(readCaptureLine(`  ![x](${A}) {capture}`), { alt: 'x', src: A, savedView: true })
  assert.deepEqual(readCaptureLine('![x](assets/photo.jpg){capture}'), { alt: 'x', src: 'assets/photo.jpg', savedView: false })
  assert.equal(readCaptureLine(`![x](${A})`), null, 'an image without the token is an ordinary image')
  assert.equal(embedLinePageUrl(`[Embed: ${SITE}]`), PAGE)
  assert.equal(embedLinePageUrl(SITE), PAGE, 'a bare address line embeds too')
  assert.equal(embedLinePageUrl('[Embed: talk-page.html]'), null, 'a local page is not a web page')
})

const OUTLINE = [
  '# Talk', '',
  '## Before {id=before}', '', `[Embed: ${SITE}]`, '',
  '## Radio Times {layout=media id=page}', '', '- Created from 340 hours of audio files', '', `[Embed: ${SITE}]`, '', '```', `[Embed: ${SITE}]`, '```', '',
  ':::notes', `![n](${B}){capture}`, ':::', '',
  '## After {id=after}', '', '- Text', ''
].join('\n')

await test('outline edit: the first view writes the marker and its line under the slide\'s embed, later ones one line; every other byte kept; repeat is a no-op', () => {
  const one = withCaptureLine(OUTLINE, 'page', PAGE, line(A))
  assert.equal(one.replace(`${MARK}\n${line(A)}\n`, ''), OUTLINE, 'only the marker and the line added')
  assert.equal(one.split('\n')[one.split('\n').indexOf(`[Embed: ${SITE}]`, 6) + 1], MARK, 'directly under the slide\'s own embed, not the other slide\'s')
  const two = withCaptureLine(one, 'page', PAGE, line(B, 'page'))
  assert.equal(two.replace(`${line(B, 'page')}\n`, ''), one, 'then one line')
  const lines = two.split('\n'); const at = lines.indexOf(line(A))
  assert.deepEqual([lines[at - 1], lines[at + 1]], [MARK, line(B, 'page')], 'the newest view goes last')
  assert.equal(withCaptureLine(two, 'page', 'https://example.org', line(A)), two, 'the same picture again: unchanged')
  // Every line deleted: the next view goes under the marker, nothing else comes back.
  const emptied = two.replace(`${line(A)}\n${line(B, 'page')}\n`, '')
  assert.equal(withCaptureLine(emptied, 'page', PAGE, line(A), ), emptied.replace(`${MARK}\n`, `${MARK}\n${line(A)}\n`))
  const markup = captureMarkupOfSlideText(lines.slice(lines.indexOf('## Radio Times {layout=media id=page}'), lines.indexOf('## After {id=after}')).join('\n'))
  assert.deepEqual(markup.pages.map((p) => [p.pageUrl, p.managed, p.captures.map((c) => c.src)]), [[PAGE, true, [A, B]]], 'the fenced embed and the notes line are not read')
  assert.equal(withCaptureLine(OUTLINE.replace(/\n/g, '\r\n'), 'page', PAGE, line(A)).includes(`${MARK}\r\n${line(A)}\r\n`), true, 'the outline\'s CRLF kept')
  assert.equal(withCaptureLine('## S {id=s}\n\n  [Embed: https://x.org]\n', 's', 'https://x.org/', line(A)), `## S {id=s}\n\n  [Embed: https://x.org]\n  ${MARK}\n  ${line(A)}\n`, 'the embed line\'s indentation kept')
  // Lines typed by hand before (no marker): the marker goes above them, the new line after them.
  const typed = `## S {id=s}\n\n[Embed: https://x.org]\n${line(A)}\n`
  assert.equal(withCaptureLine(typed, 's', 'https://x.org/', line(B), ), `## S {id=s}\n\n[Embed: https://x.org]\n${MARK}\n${line(A)}\n${line(B)}\n`)
})

await test('the marker is kept through comment blanking only when exact and alone on its line', () => {
  const text = `a\n${MARK}\n  ${MARK}\nx ${MARK}\n<!-- saved views {capture} and more -->\n<!--\n${MARK}\n-->\n`
  // The last: a comment opened above swallows the marker (closes at its `-->`), as blankHtmlComments reads it.
  assert.equal(blankHtmlCommentsKeepingCaptureMarkers(text), `a\n${MARK}\n  ${MARK}\nx \n\n\n\n-->\n`)
})

await test('placement ignores a marker inside a comment and migrates earlier views', () => {
  const source = `### Page {id=page}\n[Embed: ${SITE}]\n<!-- disabled marker\n${MARK}\n-->\n`
  const fresh = line('assets/live-page-captures/cccccccccccccccc.jpg')
  const placed = placeCaptureLines(source, 'page', PAGE, fresh, [line(A), line(B)])
  assert.equal(placed.onSlide, true)
  assert.ok(placed.text.includes(line(A)), 'the hidden marker must not suppress earlier views')
  assert.ok(placed.text.includes(line(B)))
  assert.ok(placed.text.includes(fresh))
  assert.equal(captureMarkupOfSlideText(placed.text).pages[0].captures.length, 3)
})

await test('placement refuses comment-bearing insertion lines without exposing hidden text', () => {
  for (const eol of ['\n', '\r\n']) {
    for (const body of [
      `[Embed: ${SITE}] <!-- note\nsecret draft line\n-->`,
      `[Embed: ${SITE}]\n${MARK}\n${line(A)} <!-- note\nsecret draft line\n-->`
    ]) {
      const source = (`### Page {id=page}\n${body}\n`).replace(/\n/g, eol)
      const placed = placeCaptureLines(source, 'page', PAGE, line(B), [line(A)])
      assert.equal(placed.onSlide, false, 'never insert into an author comment')
      assert.equal(placed.text, source, 'refusal preserves all hidden text byte for byte')
    }
  }
})

await test('outline edit refuses: slide gone or id twice, page not on that slide, a path that is not a saved view', () => {
  assert.throws(() => withCaptureLine(OUTLINE, 'gone', PAGE, line(A)), /capture-slide-missing/)
  assert.throws(() => withCaptureLine(`${OUTLINE}\n## Copy {id=page}\n\n[Embed: ${SITE}]\n`, 'page', PAGE, line(A)), /capture-slide-missing/)
  assert.throws(() => withCaptureLine(OUTLINE, 'after', PAGE, line(A)), /capture-embed-missing/)
  assert.throws(() => withCaptureLine(OUTLINE, 'page', 'https://other.example/', line(A)), /capture-embed-missing/)
  assert.throws(() => withCaptureLine(OUTLINE, 'page', PAGE, '![x](assets/photo.jpg){capture}'), /capture-invalid/)
})

/** A talk with two real saved views (writer in the talk folder) and the outline given; `markup`: saved
 * as the capture job saves them now (`slideMarkup: true`), else as alpha.14/15 saved them. */
function talk(name, outline, markup = true) {
  const dir = join(scratch, name, 'talks', 'radio')
  fs.mkdirSync(dir, { recursive: true })
  const outlinePath = join(dir, 'radio-outline.md')
  fs.writeFileSync(outlinePath, outline)
  const saved = []
  for (const [n, t] of [[1, '2026-10-27T10:00:00.000Z'], [2, '2026-10-27T10:05:00.000Z']]) {
    const st = fs.statSync(outlinePath)
    process.chdir(dir)
    try {
      const r = writeCaptureInWorkingFolder({
        realRoot: fs.realpathSync.native(join(scratch, name)), realTalkPath: fs.realpathSync.native(dir), outlineName: 'radio-outline.md', outline: { dev: st.dev, ino: st.ino }, pageUrl: PAGE,
        capture: { id: `cap-00000000000${n}`, capturedAt: t, slideId: 'page', width: 2, height: 2, source: 'window', viewport: { w: 2, h: 2, zoom: 1 }, scroll: { fx: 0, fy: 0 }, ...(n === 2 ? { mode: 'page' } : {}), ...(markup ? { slideMarkup: true } : {}) },
        jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n, n, n])
      })
      assert.equal(r.ok, true, JSON.stringify(r)); saved.push(r.image)
    } finally { process.chdir(home) }
  }
  return { dir, outlinePath, saved }
}
const compile = async (t, outline) => {
  const { prepareSource } = await import('../compiler/scripts/lib/08-source-adapters.mjs')
  fs.writeFileSync(t.outlinePath, outline)
  return prepareSource(t.outlinePath, outline, null, fs.statSync(t.outlinePath), {}, {})
}
const views = (html) => [...html.matchAll(/<figure class="embed-saved-view( is-page)?">/g)].map((m) => (m[1] ? 'page' : 'view'))
const head = '---\ntitle: Radio\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n### Radio Times {id=page}\n\n'

await test('compiler: the {capture} lines are the gallery, in their order, dated from the records; never ordinary images', async () => {
  const t = talk('markup', head)
  const outline = `${head}[Embed: ${SITE}]\n${line(t.saved[1], 'page')}\n${line(t.saved[0])}\n`
  const model = await compile(t, outline)
  assert.deepEqual(views(model.fullHtml), ['page', 'view'], 'markup order; the Entire page view marked')
  assert.match(model.fullHtml, /Entire page 1 of 2, captured 27 Oct 2026/)
  assert.doesNotMatch(model.fullHtml, /class="slide-figure|<figure class="fig/, 'no ordinary image figure')
  assert.doesNotMatch(model.fullHtml, /live-page-captures\/|\{capture\}/, 'no path or token in the output')
  // One line removed: that view is off the slide; its record stays and does not come back by itself.
  const fewer = await compile(t, `${head}[Embed: ${SITE}]\n${line(t.saved[0])}\n`)
  assert.deepEqual(views(fewer.fullHtml), ['view'])
  assert.equal(fs.readdirSync(join(t.dir, 'assets/live-page-captures')).length, 4, 'pictures and records kept')
})

await test('compiler: deleting the last {capture} line leaves the page with no saved views (2 → 1 → 0, nothing comes back)', async () => {
  const t = talk('delete', head)
  const counts = []
  for (const outline of [
    `${head}[Embed: ${SITE}]\n${line(t.saved[0])}\n${line(t.saved[1], 'page')}\n`,
    `${head}[Embed: ${SITE}]\n${line(t.saved[0])}\n`,
    `${head}[Embed: ${SITE}]\n`
  ]) counts.push(views((await compile(t, outline)).fullHtml).length)
  assert.deepEqual(counts, [2, 1, 0])
  assert.equal(fs.readdirSync(join(t.dir, 'assets/live-page-captures')).length, 4, 'pictures and records kept')
})

await test('compiler: views recorded before the markup still show for a page without {capture} lines (no data lost)', async () => {
  const t = talk('legacy', head, false)
  const model = await compile(t, `${head}[Embed: ${SITE}]\n`)
  assert.deepEqual(views(model.fullHtml), ['view', 'page'], 'the recorded views, in record order')
  // One view saved since: the page is in the markup now, so only its lines show (the placement wrote
  // the earlier views' lines with it: placeCaptureLines `earlier`).
  const st = fs.statSync(t.outlinePath)
  process.chdir(t.dir)
  try {
    const r = writeCaptureInWorkingFolder({
      realRoot: fs.realpathSync.native(join(scratch, 'legacy')), realTalkPath: fs.realpathSync.native(t.dir), outlineName: 'radio-outline.md', outline: { dev: st.dev, ino: st.ino }, pageUrl: PAGE,
      capture: { id: 'cap-000000000003', capturedAt: '2026-10-27T10:10:00.000Z', slideId: 'page', width: 2, height: 2, source: 'window', viewport: { w: 2, h: 2, zoom: 1 }, scroll: { fx: 0, fy: 0 }, slideMarkup: true },
      jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 3, 3, 3])
    })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.deepEqual(r.earlier.map((e) => e.image), t.saved, 'the earlier views, for the placement to write')
    // Saved but not placed (refused, or the writer failed): the outline is as it was, so the page still
    // shows the two older views; the new one shows nowhere (kept in the talk folder).
    assert.deepEqual(views((await compile(t, `${head}[Embed: ${SITE}]\n`)).fullHtml), ['view', 'page'], 'still the two older views')
    const placed = placeCaptureLines(`${head}[Embed: ${SITE}]\n`, 'page', PAGE, line(r.image), r.earlier.map((e) => captureMarkupLine(e.image, e.capturedAt, e.mode)))
    assert.equal(placed.text, `${head}[Embed: ${SITE}]\n${MARK}\n${r.earlier.map((e) => captureMarkupLine(e.image, e.capturedAt, e.mode)).join('\n')}\n${line(r.image)}\n`)
    assert.equal(views((await compile(t, placed.text)).fullHtml).length, 3, 'all three, as lines')
    assert.deepEqual(views((await compile(t, `${head}[Embed: ${SITE}]\n${MARK}\n`)).fullHtml), [], 'every line deleted: none come back')
    assert.deepEqual(views((await compile(t, `${head}[Embed: ${SITE}]\n`)).fullHtml), ['view', 'page'], 'the marker deleted too: the older views again (the outline says so)')
  } finally { process.chdir(home) }
})

await test('a placement changes only its own slide\'s embed; another slide with the page keeps its older views', () => {
  const text = `## A {id=a}\n\n[Embed: ${SITE}]\n\n## B {id=b}\n\n[Embed: ${SITE}]\n\n## C {id=c}\n\n[Embed: https://other.example]\n`
  const r = placeCaptureLines(text, 'b', PAGE, line(B), [line(A)])
  assert.equal(r.onSlide, true)
  assert.equal(r.text, text.replace(`## B {id=b}\n\n[Embed: ${SITE}]\n`, `## B {id=b}\n\n[Embed: ${SITE}]\n${MARK}\n${line(A)}\n${line(B)}\n`))
  // Refused: the text byte for byte, nothing migrated anywhere.
  for (const [slide, reason] of [['gone', 'capture-slide-missing'], ['c', 'capture-embed-missing']]) {
    const gone = placeCaptureLines(text, slide, PAGE, line(B), [line(A)])
    assert.deepEqual([gone.onSlide, gone.reason, gone.text === text], [false, reason, true])
  }
})

await test('compiler: the marker belongs to the embed above it; a slide whose marker is under another page keeps its older views', async () => {
  const t = talk('marker', head, false)
  const two = `${head}[Embed: ${SITE}]\n\n[Embed: https://other.example]\n${MARK}\n`
  assert.deepEqual(views((await compile(t, two)).fullHtml), ['view', 'page'], 'the marker is the other page\'s')
  assert.deepEqual(views((await compile(t, `${head}[Embed: ${SITE}]\n${MARK}\n`)).fullHtml), [])
  const model = await compile(t, `${head}[Embed: ${SITE}]\n${MARK}\n${line(t.saved[1], 'page')}\n`)
  assert.deepEqual(views(model.fullHtml), ['page'])
  assert.doesNotMatch(model.fullHtml, /saved views \{capture\}|&lt;!--/, 'the marker shows nowhere')
  assert.ok(!model.warnings.some((w) => /unknown-trigger|capture/.test(String(w))), model.warnings.join('\n'))
})

await test('compiler: a {capture} line with no web page above it, or with another picture path, shows nothing', async () => {
  const t = talk('stray', head)
  const orphan = await compile(t, `${head}${line(t.saved[0])}\n\n- text\n`)
  assert.doesNotMatch(orphan.fullHtml, /<img src="data:image\/jpeg/, 'not an ordinary image')
  fs.writeFileSync(join(t.dir, 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9]))
  const other = await compile(t, `${head}[Embed: ${SITE}]\n![x](photo.jpg){capture}\n`)
  assert.equal(views(other.fullHtml).length, 0)
  assert.ok(other.warnings.some((w) => String(w).startsWith('capture-not-a-saved-view:page:')), other.warnings.join('\n'))
})

await test('a slide with no {id=…}: found only by a heading no other slide has; an identical heading (then or inserted since) refuses', async () => {
  const tools = await loadOutlineTools(join(repo, 'compiler/scripts'))
  const outline = `---\ntitle: Derived\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n## Part one\n\n### Before\n\n- first, no page\n\n### Radio Times & more!\n\n[Embed: ${SITE}]\n\n### Other {id=other}\n\n- x\n`
  const path = join(scratch, 'derived-outline.md'); fs.writeFileSync(path, outline)
  const slides = await tools.compiledSlides(path, outline)
  const radio = slides.filter((s) => s.id === 'radio-times-and-more')
  assert.equal(radio.length, 1, slides.map((s) => s.id).join(','))
  const ref = slideHeadingRef(outline, radio[0].sourceLine)
  assert.deepEqual(ref, { heading: '### Radio Times & more!' })
  const line = captureMarkupLine(A, '2026-10-27T11:05:00.000Z', 'view')
  const slide = { id: 'radio-times-and-more', ...ref }
  assert.equal(withCaptureLine(outline, slide, PAGE, line), outline.replace(`[Embed: ${SITE}]\n`, `[Embed: ${SITE}]\n${MARK}\n${line}\n`))
  assert.throws(() => withCaptureLine(outline, 'radio-times-and-more', PAGE, line), /capture-slide-missing/, 'the derived id alone names no line')
  // Typed elsewhere since the compile: still the one slide with that heading.
  const typed = outline.replace('- first, no page', '- first, no page\n- typed meanwhile')
  assert.match(withCaptureLine(typed, slide, PAGE, line), /typed meanwhile[\s\S]*Radio Times & more!\n\n\[Embed: [^\]]+\]\n<!-- saved views \{capture\} -->\n!\[[^\n]*\{capture\}/)
  // An identical heading inserted since (above or below): refused, never a guess at one of them.
  const above = outline.replace('### Before', `### Radio Times & more!\n\n[Embed: ${SITE}]\n\n### Before`)
  const below = outline.replace('### Other {id=other}', `### Radio Times & more!\n\n[Embed: ${SITE}]\n\n### Other {id=other}`)
  for (const t of [above, below]) {
    assert.throws(() => withCaptureLine(t, slide, PAGE, line), /capture-slide-ambiguous/)
    const r = placeCaptureLines(t, slide, PAGE, line, [])
    assert.deepEqual([r.onSlide, r.reason, r.text], [false, 'capture-slide-ambiguous', t], 'the text left alone')
  }
  // Retitled, or given another id: refused.
  assert.throws(() => withCaptureLine(outline.replace('### Radio Times & more!', '### Renamed'), slide, PAGE, line), /capture-slide-missing/)
  assert.throws(() => withCaptureLine(outline.replace('### Radio Times & more!', '### Radio Times & more! {id=mine}'), slide, PAGE, line), /capture-slide-missing/, 'now carries another id')
  // Two slides with that heading when compiled: no heading identity at all, so the derived id is refused.
  const twice = outline.replace('### Before', '### Radio Times & more!')
  const repeat = (await tools.compiledSlides(path, twice)).filter((s) => s.id === 'radio-times-and-more-2')
  assert.equal(repeat.length, 1)
  assert.equal(slideHeadingRef(twice, repeat[0].sourceLine), null)
  assert.equal(slideHeadingRef(outline, 2), null, 'not a heading line')
})

fs.rmSync(scratch, { recursive: true, force: true })
console.log(`live page capture markup: ${passed} passed`)
