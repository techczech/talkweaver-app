// Ticket 04 of 0.38 — "An audio file can be put on a slide": the compiler side.
//  1. The lexer turns `![Title](clip.mp3)` (mp3, m4a, wav, ogg) into an `audio` block, never an image
//     or a video, and carries {autoplay} and {loop}. The editor's image-line count skips it.
//  2. The renderer makes a speaker chip in the text flow: not a figure, no enlarge button, a lucide
//     volume-2 icon, the title (file name without extension when there is none), a preload="none" <audio>.
//  3. Layout is unchanged: a slide with the chip gets the layout it would get without it.
//  4. Source adapters follow the video rule: inline when small, an asset plus a warning when large,
//     and a missing file gives the missing-video warning.
//  5. Handout, phone and venue markup drops the <audio>; the phone text view names it as audio.
import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const lib = (name) => pathToFileURL(join(process.cwd(), 'compiler/scripts/lib', name)).href
const { lexMarkdownBlocks } = await import(lib('03-markdown-lexer.mjs'))
const { isImageBlockLine, audienceImageLineNumbers, imageSyntaxIsAudio, imageSyntaxIsVideo } = await import(lib('image-line-rules.mjs'))
const { renderBlock, audioChipTitle } = await import(lib('06-block-renderers.mjs'))
const { prepareSource } = await import(lib('08-source-adapters.mjs'))
const { markSlidePreviewHtml } = await import(pathToFileURL(join(process.cwd(), 'src/shared/slide-preview.ts')).href)
const { stripAudioElements } = await import(lib('09-output-builders.mjs'))
const { parseSlideScript } = await import(lib('slide-script.mjs'))
const { renderScriptBlocks } = await import(lib('slide-script-render.mjs'))

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`) } catch (error) { failures++; console.error(`FAIL ${name}\n     ${error?.message ?? error}`) }
}

await check('the lexer reads mp3, m4a, wav and ogg as audio blocks, with {autoplay} and {loop}', () => {
  for (const ext of ['mp3', 'm4a', 'wav', 'ogg', 'MP3']) {
    const [block, ...rest] = lexMarkdownBlocks([`![A clip](assets/clip.${ext})`])
    assert.equal(rest.length, 0)
    assert.equal(block.type, 'audio', ext)
    assert.equal(block.src, `assets/clip.${ext}`)
    assert.equal(block.title, 'A clip')
  }
  const [flagged] = lexMarkdownBlocks(['![Theme](theme.mp3){autoplay}{loop}'])
  assert.deepEqual(flagged.flags, { autoplay: true, loop: true })
  const [plain] = lexMarkdownBlocks(['![Theme](theme.mp3)'])
  assert.deepEqual(plain.flags, {})
  assert.equal(lexMarkdownBlocks(['![](theme.mp3)'])[0].title, '')
})

await check('an image and a video are still an image and a video', () => {
  assert.equal(lexMarkdownBlocks(['![pic](a.png)'])[0].type, 'image')
  assert.equal(lexMarkdownBlocks(['![clip](a.mp4)'])[0].type, 'video')
  assert.equal(imageSyntaxIsAudio('a.mp4'), false)
  assert.equal(imageSyntaxIsVideo('a.mp3'), false)
})

await check('the editor image-line count skips audio lines', () => {
  assert.equal(isImageBlockLine('![x](clip.mp3)'), false)
  assert.equal(isImageBlockLine('![x](clip.png)'), true)
  assert.deepEqual(audienceImageLineNumbers(['![a](a.png)', '![b](b.mp3)', '![c](c.jpg)']), [1, 3])
})

await check('the chip is a plain block in the text flow, never a figure', () => {
  const html = renderBlock({ type: 'audio', src: 'clip.mp3', title: 'Interview <1>', flags: { autoplay: true, loop: true } })
  assert.match(html, /^<div class="slide-audio" data-audio-state="ready" data-audio-autoplay data-audio-loop /)
  assert.match(html, /<svg[^>]*fl-svg-lucide[^>]*>.*<\/svg>/s, 'lucide icon')
  assert.match(html, /<span class="slide-audio-title">Interview &lt;1&gt;<\/span>/)
  assert.match(html, /<audio preload="none" loop src="clip\.mp3"><\/audio>/)
  assert.doesNotMatch(html, /<figure|<video|<img|video-enlarge|slide-figure/, 'no media-figure markup')
})

await check('with no title the chip carries the file name without extension', () => {
  assert.equal(audioChipTitle({ src: 'assets/Opening%20theme.mp3' }), 'Opening theme')
  assert.equal(audioChipTitle({ src: 'data:audio/mpeg;base64,AAAA', audioName: 'voice.note.m4a' }), 'voice.note')
  assert.equal(audioChipTitle({ src: 'data:audio/mpeg;base64,AAAA' }), 'Audio')
  assert.match(renderBlock({ type: 'audio', src: 'assets/theme.wav', title: '' }), /slide-audio-title">theme</)
})

// ── source adapters, on real files ───────────────────────────────────────────────────────────
const base = await mkdtemp(join(tmpdir(), 'tw-audio-chip-'))
const dir = join(base, 'talk')
await mkdir(join(dir, 'assets'), { recursive: true })
const KB = 1024
const files = { 'small.mp3': 4 * KB, 'small.m4a': 4 * KB, 'small.wav': 4 * KB, 'small.ogg': 4 * KB, 'big.mp3': 3 * 1024 * KB }
for (const [name, size] of Object.entries(files)) await writeFile(join(dir, 'assets', name), Buffer.alloc(size, 7))
const outline = (body) => ['---', 'title: Audio', '---', '', ...body].join('\n')
async function compile(body, options = {}) {
  const path = join(dir, 'talk-outline.md')
  const text = outline(body)
  await writeFile(path, text, 'utf8')
  return prepareSource(path, text, null, await stat(path), {}, options)
}
// The compiled markup of the authored slide (index 1: slide 0 is the generated title slide).
const slideHtml = (model) => {
  const html = String(model.fullHtml)
  const sections = [...html.matchAll(/<section class="slide\b/g)].map((m) => m.index)
  const from = sections[1]
  return html.slice(from, html.indexOf('</section>', from) + 10)
}

await check('small audio is inlined by the video rule, in every format', async () => {
  const model = await compile(['### Sounds', '', '![One](assets/small.mp3)', '![Two](assets/small.m4a)', '![Three](assets/small.wav)', '![Four](assets/small.ogg)'])
  const html = slideHtml(model)
  for (const mime of ['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg']) assert.match(html, new RegExp(`src="data:${mime};base64,`), mime)
  assert.deepEqual((model.warnings ?? []).filter((w) => /audio|asset/.test(w)), [])
})

await check('audio over the inline limit becomes an asset with a warning, like video', async () => {
  const model = await compile(['### Long', '', '![Long talk](assets/big.mp3)'], { videoInlineLimitBytes: 1 * 1024 * KB })
  const html = slideHtml(model)
  assert.match(html, /<audio preload="none" src="assets\/[^"]*big\.mp3"/)
  assert.match(html, /data-audio-asset-only data-audio-name="big\.mp3"/)
  assert(model.warnings.some((w) => /^audio-asset-only:[^:]+:big\.mp3 /.test(w)), model.warnings.join('\n'))
  assert(!/data:audio/.test(html), 'not inlined')
})

await check('a missing audio file gives the same warning a missing video gives', async () => {
  const model = await compile(['### Gone', '', '![](assets/nope.mp3)', '', '![Gone clip](assets/nope.mp4)'])
  const missing = model.warnings.filter((w) => /^missing-asset:/.test(w))
  assert.equal(missing.length, 2, model.warnings.join('\n'))
  assert(missing.some((w) => w.endsWith(':assets/nope.mp3')) && missing.some((w) => w.endsWith(':assets/nope.mp4')))
  assert.match(slideHtml(model), /slide-audio-title">nope</, 'the chip still renders, named from its file')
})

await check('the chip does not change the slide layout or become media', async () => {
  const withoutChip = await compile(['### Layout', '', 'A sentence of prose that stays prose.'])
  const withChip = await compile(['### Layout', '', 'A sentence of prose that stays prose.', '', '![Clip](assets/small.mp3)'])
  assert.equal(withChip.slides[1].layout, withoutChip.slides[1].layout, 'same layout as without the chip')
  const html = slideHtml(withChip)
  assert.doesNotMatch(html, /layout-(media|copy-visual|list-visual)|slot-media|slide-figure|slide-video/)
  assert.match(html, /class="slide-audio"/)
  const listless = await compile(['### Layout', '', '- one', '- two', '', '![Clip](assets/small.mp3)'])
  assert.doesNotMatch(slideHtml(listless), /layout-(media|copy-visual|list-visual)|slide-figure/)
  assert.equal(listless.slides[1].layout, (await compile(['### Layout', '', '- one', '- two'])).slides[1].layout)
})

await check('share markup (handout, phone, venue) drops the <audio> and keeps the chip', async () => {
  const model = await compile(['### Share', '', '![Clip](assets/small.mp3)'])
  const html = slideHtml(model)
  assert.match(html, /<audio /)
  const shared = stripAudioElements(html)
  assert.doesNotMatch(shared, /<audio|data:audio/)
  assert.match(shared, /<div class="slide-audio" data-audio-state="ready"/)
  assert.match(shared, /slide-audio-title">Clip</)
})

await check('preview HTML (thumbnails, Slide Focus, Inspector) carries no <audio>, only the static chip', async () => {
  const model = await compile(['### Preview', '', '![Clip](assets/small.mp3){autoplay}'])
  const marked = markSlidePreviewHtml(model.fullHtml)
  assert.match(model.fullHtml, /<audio /)
  assert.doesNotMatch(marked, /<audio |data:audio/)
  assert.match(marked, /<div class="slide-audio" data-audio-state="ready" data-audio-autoplay/)
  assert.match(marked, /<body\b[^>]*data-tw-preview/)
})

await check('the phone text view names an untitled audio line by its file, as the chip does', () => {
  const [untitled, captioned] = renderScriptBlocks(parseSlideScript('![](assets/Theme%20tune.mp3)\n![](assets/jingle.wav "caption")\n'))
  assert.deepEqual(untitled, { type: 'audio', title: 'Theme tune' })
  assert.deepEqual(captioned, { type: 'audio', title: 'jingle' })
  assert.equal(audioChipTitle({ src: 'assets/Theme%20tune.mp3', title: '' }), untitled.title, 'one rule for both')
})

await check('a pre-work handout step drops the <audio> too', async () => {
  const { buildShareHtml } = await import(lib('09-output-builders.mjs'))
  const model = await compile(['### Step', '', '![Clip](assets/small.mp3)'])
  const stepHtml = slideHtml(model)
  assert.match(stepHtml, /<audio /)
  const page = buildShareHtml({
    title: 'T', slides: [{ html: '<section class="slide" data-id="a"><div class="slide-content"><h1>A</h1></div></section>', notes: '' }], styles: '', includeNotes: false, slug: 't',
    prework: { preworkId: 'p', workerBaseUrl: 'https://w.example', form: { fields: [] }, steps: [{ html: stepHtml }] }
  })
  const template = page.match(/<template id="preworkSteps">([\s\S]*?)<\/template>/)?.[1] ?? ''
  assert.match(template, /class="slide-audio"/, 'the chip is kept as a label')
  assert.doesNotMatch(template, /<audio|data:audio/)
})

await check('the phone text view names an audio file as audio, not as a figure', () => {
  const blocks = parseSlideScript('![Theme tune](assets/theme.mp3)\n![Chart](assets/chart.png)\n')
  assert.deepEqual(blocks.map((b) => b.type), ['audio', 'media'])
  assert.deepEqual(renderScriptBlocks(blocks), [{ type: 'audio', title: 'Theme tune' }, { type: 'media', alt: 'Chart' }])
  // The lexer's destination excludes a "caption", so an audio line with one is still audio.
  const captioned = parseSlideScript('![Interview](clip.mp3 "Recorded in Oxford"){autoplay}\n![Plot](plot.png "A caption")\n')
  assert.deepEqual(captioned.map((b) => b.type), ['audio', 'media'])
  assert.equal(lexMarkdownBlocks(['![Interview](clip.mp3 "Recorded in Oxford")'])[0].type, 'audio', 'the lexer agrees')
})

console.log(failures ? `\n${failures} failing` : '\nall passing')
process.exit(failures ? 1 : 0)
