// The one picture-reference extractor (src/main/slide-image-refs.ts) and the svg text reader
// (src/main/svg-text.ts): every syntax a slide can name a picture by, how each resolves, and that
// nothing outside the vault is reached.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { extractImageRefs, extractFrontmatterImageRefs, resolveImagePaths, slideImagePaths, talkImagePaths, deckPicturesOf, rowShowsDeckLogo, rowImageRefs, OCR_PICTURE_EXTS } from '../src/main/slide-image-refs.ts'
import { createSlideSearch, normalizeSearchQuery } from '../src/main/slide-search.ts'
import { svgText } from '../src/main/svg-text.ts'

let passed = 0
const test = (name, fn) => { fn(); passed += 1; console.log(`ok  ${name}`) }
const refs = (md) => extractImageRefs(md).map((r) => r.ref)

test('markdown image: plain, caption, trailing attrs, inline, angle brackets', () => {
  assert.deepEqual(refs('![a](assets/x.png)'), ['assets/x.png'])
  assert.deepEqual(refs('![a](assets/x.png "A caption"){play-on-next}'), ['assets/x.png'])
  assert.deepEqual(refs('text ![a](one.png) and ![b](two.jpg) here'), ['one.png', 'two.jpg'])
  assert.deepEqual(refs('![a](<my pic.png>)'), ['my pic.png'])
  assert.deepEqual(refs('![](img-1a2b3c4)'), ['img-1a2b3c4'])
  assert.deepEqual(refs('![](assets/x.png)\n![](assets/x.png)'), ['assets/x.png'], 'repeats collapse')
})
test('wiki embeds: with size and heading parts', () => {
  assert.deepEqual(refs('![[chart.png]]'), ['chart.png'])
  assert.deepEqual(refs('![[chart.png|300]] ![[b.jpg#top]]'), ['chart.png', 'b.jpg'])
})
test('html img src (double, single, bare) and video poster', () => {
  assert.deepEqual(refs('<img class="x" src="a/b.png" alt="">'), ['a/b.png'])
  assert.deepEqual(refs("<img src='c.webp'>"), ['c.webp'])
  assert.deepEqual(refs('<img src=d.gif>'), ['d.gif'])
  assert.deepEqual(refs('<video poster="p.jpg" src="v.mp4"></video>'), ['p.jpg'])
})
test('video forms are reported as videos', () => {
  assert.deepEqual(extractImageRefs('![](clip.mp4)'), [{ ref: 'clip.mp4', kind: 'video' }])
  assert.deepEqual(extractImageRefs('[Video: clip.mov]'), [{ ref: 'clip.mov', kind: 'video' }])
  assert.deepEqual(extractImageRefs('![](vid-1a2b3c4)'), [{ ref: 'vid-1a2b3c4', kind: 'video' }])
})
test('commented-out pictures are not slide pictures; prose with no carrier is skipped', () => {
  assert.deepEqual(refs('<!-- ![a](gone.png) -->\n![b](kept.png)'), ['kept.png'])
  assert.deepEqual(refs('just words, nothing to see'), [])
})
test('frontmatter logo', () => {
  assert.deepEqual(extractFrontmatterImageRefs('---\ntitle: T\nlogo: "assets/logo.png"\n---\n# x').map((r) => r.ref), ['assets/logo.png'])
  assert.deepEqual(extractFrontmatterImageRefs('# no frontmatter\nlogo: x.png'), [])
})

const root = mkdtempSync(join(tmpdir(), 'tw-image-refs-'))
try {
  const vault = join(root, 'vault'); const talk = join(vault, 'talks', 'one'); const outside = join(root, 'outside')
  mkdirSync(join(talk, 'assets'), { recursive: true }); mkdirSync(join(vault, '_assets'), { recursive: true }); mkdirSync(outside, { recursive: true })
  for (const f of [join(talk, 'assets', 'a.png'), join(talk, 'assets', 'photo.HEIC'), join(talk, 'assets', 'logo.svg'), join(talk, 'assets', 'clip.mp4'), join(talk, 'assets', 'clip.jpg'), join(talk, 'my pic.png'), join(vault, '_assets', 'img-1a2b3c4.webp'), join(vault, '_assets', 'vid-1a2b3c4.jpg'), join(vault, '_assets', 'bare.tiff'), join(outside, 'secret.png')]) writeFileSync(f, '')
  symlinkSync(outside, join(talk, 'linked'))
  const outline = join(talk, 'one-outline.md')
  const at = (md) => slideImagePaths(md, talk, vault)

  test('resolve: relative, encoded, titled, angle path, pooled id', () => {
    assert.deepEqual(at('![](assets/a.png)'), [join(talk, 'assets', 'a.png')])
    assert.deepEqual(at('![](my%20pic.png)'), [join(talk, 'my pic.png')])
    assert.deepEqual(at('![](<my pic.png>)'), [join(talk, 'my pic.png')])
    assert.deepEqual(at('![](img-1a2b3c4)'), [join(vault, '_assets', 'img-1a2b3c4.webp')])
    assert.deepEqual(at('![](img-img-1a2b3c4)'), [join(vault, '_assets', 'img-1a2b3c4.webp')])
    assert.deepEqual(at('![](img-ffffff0)'), [], 'a pooled id with no file names nothing')
  })
  test('resolve: the added formats and svg are picture files; other files are not', () => {
    assert.deepEqual(at('![](assets/photo.HEIC)'), [join(talk, 'assets', 'photo.HEIC')])
    assert.deepEqual(at('![](assets/logo.svg)'), [join(talk, 'assets', 'logo.svg')])
    assert.deepEqual(at('![](notes.pdf)'), [])
    for (const e of ['.heic', '.heif', '.tif', '.tiff', '.bmp', '.svg', '.webp', '.png', '.jpg', '.jpeg', '.gif']) assert.ok(OCR_PICTURE_EXTS.has(e), e)
  })
  test('resolve: a video contributes its sibling poster, a pooled clip its pool poster', () => {
    assert.deepEqual(at('![](assets/clip.mp4)'), [join(talk, 'assets', 'clip.jpg')])
    assert.deepEqual(at('[Video: assets/clip.mp4]'), [join(talk, 'assets', 'clip.jpg')])
    assert.deepEqual(at('![](vid-1a2b3c4)'), [join(vault, '_assets', 'vid-1a2b3c4.jpg')])
  })
  test('resolve: wiki embed by bare name searches the talk, its assets/ and the pool', () => {
    assert.deepEqual(at('![[a.png]]'), [join(talk, 'assets', 'a.png')])
    assert.deepEqual(at('![[bare.tiff]]'), [join(vault, '_assets', 'bare.tiff')])
  })
  test('resolve: nothing outside the vault, remote or data pictures never', () => {
    assert.deepEqual(at(`![](${join(outside, 'secret.png')})`), [])
    assert.deepEqual(at('![](../../../outside/secret.png)'), [])
    assert.deepEqual(at('![](linked/secret.png)'), [], 'a link out of the vault is refused')
    assert.deepEqual(at('![](https://example.com/x.png) ![](data:image/png;base64,AAAA)'), [])
  })
  test('talk level: every slide plus the frontmatter logo, once each', () => {
    const rows = [{ source_markdown: '![](assets/a.png)' }, { source_markdown: '![](assets/a.png) ![](assets/logo.svg)' }]
    assert.deepEqual(talkImagePaths(rows, outline, vault, '---\nlogo: assets/photo.HEIC\n---\n'), [join(talk, 'assets', 'a.png'), join(talk, 'assets', 'logo.svg'), join(talk, 'assets', 'photo.HEIC')])
  })
  test('resolve with an injected exists() sees the same rules without touching disk', () => {
    const present = new Set([join('/v', 't', 'x.png')])
    assert.deepEqual(resolveImagePaths([{ ref: 'x.png', kind: 'picture' }], join('/v', 't'), '/v', { exists: (p) => present.has(p) }), [join('/v', 't', 'x.png')])
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}

test('svg text: text and tspan content, entities, nesting; nothing else', () => {
  const svg = '<svg><title>ignored</title><text x="1">Hello <tspan>big &amp; bold</tspan></text><g><text>Second&#33; &#x41;</text></g><desc>nope</desc></svg>'
  assert.equal(svgText(svg), 'Hello big & bold\nSecond! A')
  assert.equal(svgText('<svg><rect/></svg>'), '')
})

test('svg text: inline children join without a space; a positioned tspan starts a new word', () => {
  assert.equal(svgText('<svg><text>Hel<tspan>lo</tspan></text></svg>'), 'Hello')
  assert.equal(svgText('<svg><text>Hel<tspan font-weight="bold">lo</tspan> world</text></svg>'), 'Hello world')
  assert.equal(svgText('<svg><text><tspan x="0" y="10">First</tspan><tspan x="0" dy="1.2em">line</tspan></text></svg>'), 'First line')
  assert.equal(svgText('<svg><text>One</text><text>Two</text></svg>'), 'One\nTwo', 'separate text elements stay separate pieces')
})
test('svg text: an x-only tspan gives the spaced line and, once more, the joined line', () => {
  // A word split into letter groups by a design tool: found joined ("hello") and as written.
  const split = svgText('<svg><text>Hel<tspan x="20">lo</tspan></text></svg>')
  assert.equal(split, 'Hel lo\nHello')
  assert.ok(split.toLowerCase().includes('hello'))
  assert.equal(svgText('<svg><text>Hel<tspan dx="2">lo</tspan></text></svg>'), 'Hel lo\nHello', 'dx is an x-only join too')
  // One tspan per word: the spaced line is there, so "quarterly revenue" is still found.
  const words = svgText('<svg><text><tspan x="0">Quarterly</tspan><tspan x="80">Revenue</tspan></text></svg>')
  assert.ok(words.split('\n').includes('Quarterly Revenue'), words)
  // Source whitespace between word tspans: both forms are the same, no extra line.
  assert.equal(svgText('<svg><text><tspan x="0">Quarterly</tspan> <tspan x="80">Revenue</tspan></text></svg>'), 'Quarterly Revenue')
  // y / dy start a new line: a space, as before, and no extra line.
  assert.equal(svgText('<svg><text><tspan x="0" y="10">First</tspan><tspan x="0" dy="1.2em">line</tspan></text></svg>'), 'First line')
  // Only the line with the x-only join gets a joined copy.
  assert.equal(svgText('<svg><text><tspan y="10">Big</tspan><tspan y="30">Hel</tspan><tspan x="9">lo</tspan></text><text>Two</text></svg>'), 'Big Hel lo\nHello\nTwo')
})
test('svg text: CDATA is literal text; comments, doctype and processing instructions are skipped', () => {
  assert.equal(svgText('<svg><text><![CDATA[<hello> & bye]]></text></svg>'), '<hello> & bye')
  assert.equal(svgText('<?xml version="1.0"?><!DOCTYPE svg><svg><!-- <text>hidden</text> --><text>shown</text></svg>'), 'shown')
  assert.equal(svgText('<svg><text>a<!-- b -->c</text></svg>'), 'ac')
  assert.equal(svgText('<svg><svg:text xmlns:svg="x">ns</svg:text><text title="a>b">quoted</text></svg>'), 'ns\nquoted')
})
test('svg text: linear on hostile input (many <text> openings with no closing, inside and outside a comment)', () => {
  const opens = '<text>'.repeat(200000) // 1.2 MB
  for (const svg of [`<svg><!-- ${opens}`, `<svg>${opens}`, `<svg>${'<text a="'.repeat(150000)}`, `<svg><text>${'&amp'.repeat(300000)}</text>`]) {
    const t0 = performance.now()
    svgText(svg)
    const ms = performance.now() - t0
    assert.ok(ms < 400, `parsed ${svg.length} bytes in ${ms.toFixed(0)} ms`)
  }
})

test('deck logo: shown on closing slides always, on title slides only with the default poster style', () => {
  const deck = deckPicturesOf('---\ntitle: T\nlogo: assets/logo.png\n---\n')
  assert.deepEqual(deck, { logo: [{ ref: 'assets/logo.png', kind: 'picture' }], openingShowsLogo: true })
  assert.equal(rowShowsDeckLogo({ layout: 'title' }, deck), true)
  assert.equal(rowShowsDeckLogo({ layout: 'closing' }, deck), true)
  assert.equal(rowShowsDeckLogo({ layout: 'bullets' }, deck), false)
  const banner = deckPicturesOf('---\nlogo: assets/logo.png\ntitle_style: banner\n---\n')
  assert.equal(rowShowsDeckLogo({ layout: 'title' }, banner), false, 'banner and split openings draw no logo')
  assert.equal(rowShowsDeckLogo({ layout: 'closing' }, banner), true)
  assert.equal(deckPicturesOf('---\nlogo: a.png\ntitle_style: weird\n---\n').openingShowsLogo, true, 'an unknown style falls back to the poster')
  assert.equal(rowShowsDeckLogo({ layout: 'title' }, deckPicturesOf('---\ntitle: T\n---\n')), false, 'no logo, nothing shown')
  assert.deepEqual(rowImageRefs({ layout: 'closing', source_markdown: '![](assets/logo.png) ![](b.png)' }, deck).map((r) => r.ref), ['assets/logo.png', 'b.png'], 'no repeat')
})

// The real compiler: which rows are the generated title / closing posters, and does the logo's text find them?
{
  const compilerDir = join(process.cwd(), 'compiler', 'scripts')
  const { prepareSource } = await import(pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href)
  const { buildPerSlideProjections } = await import(pathToFileURL(join(compilerDir, 'lib/10-projections.mjs')).href)
  const dir = mkdtempSync(join(tmpdir(), 'tw-deck-logo-'))
  try {
    const vault = dir; const talkDir = join(vault, 'talk'); mkdirSync(join(talkDir, 'assets'), { recursive: true })
    writeFileSync(join(talkDir, 'assets', 'logo.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
    const outline = join(talkDir, 'talk-outline.md')
    const content = '---\ntitle: Deck With Logo\nauthor: A. Speaker\nlogo: assets/logo.png\noutline_version: 2\n---\n\n# Section\n\n## First slide\n\n- one point\n\n## Second slide\n\n- another point\n'
    writeFileSync(outline, content)
    const model = await prepareSource(outline, content, 'talk', statSync(outline), undefined, { projectionsOnly: true })
    const rows = buildPerSlideProjections(model, 'talk') ?? []
    const deck = deckPicturesOf(content)
    const titleRows = rows.filter((r) => r.layout === 'title' || r.layout === 'closing')
    await (async () => {
      assert.ok(titleRows.length >= 1, 'the compiler generated a title poster: ' + JSON.stringify(rows.map((r) => [r.slide_id, r.layout])))
      assert.ok(titleRows.every((r) => r.source_markdown === ''), 'generated posters carry no source markdown')
      const logoPath = join(talkDir, 'assets', 'logo.png')
      const search = createSlideSearch({ imageText: { generation: () => 1, textLower: (p) => (p === logoPath ? 'acme institute' : '') } })
      const hits = await search.scan({
        query: normalizeSearchQuery('acme'),
        talks: [{ key: outline, freshness: '1', rows, imageRefsFor: (r) => rowImageRefs(r, deck), resolveImages: (refs) => resolveImagePaths(refs, talkDir, vault) }],
        load: async (t) => t, yieldToLoop: async () => {}
      })
      assert.deepEqual(hits.map((h) => h.row.slide_id), titleRows.map((r) => r.slide_id), 'the logo text finds the poster slides, and only them')
      passed += 1; console.log('ok  deck logo: the compiler\'s generated title poster is found by the logo\'s text')
    })()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`PASS slide image refs: ${passed} checks`)
