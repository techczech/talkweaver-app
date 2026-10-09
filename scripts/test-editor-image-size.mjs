// Editor image previews say where the image lands and can be opened as Z shows it.
//  1. The placement label comes from the compiler's own decision (image_placements on each
//     projection row), found by line. Rows come from the real compiler, as talk:compile builds them.
//  2. The low-resolution rule for a 1920x1080 full-screen display.
//  3. The widget draws the chip; a click opens the overlay (size line + note); Esc and click close it.
import { strict as assert } from 'node:assert'
import { JSDOM } from 'jsdom'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildPerSlideProjections } from '../compiler/scripts/lib/10-projections.mjs'
import { imagePlacementForLine, placementLabel } from '../src/shared/image-placement.ts'
import { fullScreenFit, lowResolutionNote } from '../src/shared/image-fullscreen.ts'

const outline = `---
title: Placement demo
---

# Placement demo

## Part

### Full
![full](/tmp/a.png)

### Beside
![beside](/tmp/a.png)

Some words beside the picture.

### Thumbs
- one
- two
![t1](/tmp/a.png)
![t2](/tmp/b.png)

### Row
![r1](/tmp/a.png)
![r2](/tmp/b.png)

### Grid
{image-grid}
![g1](/tmp/a.png)
![g2](/tmp/b.png)
![g3](/tmp/c.png)

### Quoted
{image-quote}
![iq](/tmp/a.png)
> A quote

### Stated
{statement}
![st](/tmp/a.png)
Words.

### Spin
{carousel}
![c1](/tmp/a.png)
![c2](/tmp/b.png)
`

const model = await prepareSource('/tmp/editor-image-size.md', outline, 'eis')
const rows = buildPerSlideProjections(model, 'eis')
const lines = outline.split('\n')
const lineOf = (alt) => lines.findIndex((l) => l.startsWith(`![${alt}]`)) + 1
const nameAt = (alt) => placementLabel(imagePlacementForLine(rows, outline, lineOf(alt)))?.name

assert.equal(nameAt('full'), 'Full screen')
assert.equal(nameAt('beside'), 'Beside text')
assert.equal(nameAt('r1'), 'In a row (1 of 2)')
assert.equal(nameAt('r2'), 'In a row (2 of 2)')
assert.equal(nameAt('g3'), 'In a gallery (3 of 3)')
assert.equal(nameAt('iq'), 'Image with quote')
assert.equal(nameAt('st'), 'With statement')
assert.equal(nameAt('c2'), 'In a carousel (2 of 2)')
// A list with screenshots: whatever the compiler chose is named, not guessed.
assert.ok(nameAt('t1'), 'the list-with-screenshots slide gets a placement')
// Lines that are not images of a compiled slide get nothing.
assert.equal(imagePlacementForLine(rows, outline, 1), null)
assert.equal(imagePlacementForLine(null, outline, lineOf('full')), null)
assert.equal(placementLabel(null), null)
assert.equal(placementLabel({ kind: 'mystery', index: 1, count: 1 }), null)
// Stale rows (fewer placements than image lines) give nothing rather than a neighbour's label.
const stale = rows.map((r) => (r.title === 'Row' ? { ...r, image_placements: [r.image_placements[0]] } : r))
assert.equal(placementLabel(imagePlacementForLine(stale, outline, lineOf('r2'))), null)

// Lines the compiler does not count (a video in image syntax, an image inside :::notes, a fence,
// a comment) neither get a chip nor shift the chips of the real images after them.
const odd = `---
title: Odd
---

# Odd

## Part

### Mixed
![clip](/tmp/clip.mp4)

:::notes
![note](/tmp/n.png)
:::

<!-- ![commented](/tmp/c.png) -->

![real1](/tmp/a.png)
![real2](/tmp/b.png)
`
const oddRows = buildPerSlideProjections(await prepareSource('/tmp/odd.md', odd, 'odd'), 'odd')
const oddLines = odd.split('\n')
const oddAt = (alt) => placementLabel(imagePlacementForLine(oddRows, odd, oddLines.findIndex((l) => l.startsWith(`![${alt}]`)) + 1))?.name
const mixed = oddRows.find((r) => r.title === 'Mixed')
assert.equal(mixed.image_placements.length, 2, 'compiler counts real1 and real2 only')
assert.equal(oddAt('clip'), undefined, 'a video line gets no chip')
assert.equal(oddAt('note'), undefined, 'a notes image gets no chip')
assert.equal(oddAt('real1'), 'In a row (1 of 2)', 'a video, a notes image and a comment before it do not shift the label')
assert.equal(oddAt('real2'), 'In a row (2 of 2)')

// {image-quote} with two images: only the first is paired with the quote; the second renders as
// an ordinary figure and is not labelled as the pair.
const iq2 = `---
title: IQ
---

# IQ

## Part

### Paired
{image-quote}
![first](/tmp/a.png)
![second](/tmp/b.png)
> A quote
`
const iqRows = buildPerSlideProjections(await prepareSource('/tmp/iq2.md', iq2, 'iq2'), 'iq2')
const iqLines = iq2.split('\n')
const iqAt = (alt) => placementLabel(imagePlacementForLine(iqRows, iq2, iqLines.findIndex((l) => l.startsWith(`![${alt}]`)) + 1))?.name
assert.equal(iqAt('first'), 'Image with quote')
assert.equal(iqAt('second'), undefined, 'the unpaired image is not "Image with quote"')

// ---- low-resolution rule ----
assert.deepEqual(fullScreenFit(1920, 1080), { axis: 'width', needed: 1920, lowResolution: false })
assert.equal(fullScreenFit(2400, 1000).lowResolution, false, 'wide and large enough')
assert.equal(fullScreenFit(1600, 900).lowResolution, true, '16:9 below 1920 wide')
assert.equal(fullScreenFit(1900, 700).axis, 'width', 'wider than 16:9 is limited by width')
assert.equal(fullScreenFit(1900, 700).lowResolution, true)
assert.equal(fullScreenFit(800, 1200).axis, 'height', 'taller than 16:9 is limited by height')
assert.equal(fullScreenFit(800, 1200).lowResolution, false, '1200 high clears 1080')
assert.equal(fullScreenFit(800, 900).lowResolution, true)
assert.equal(fullScreenFit(800, 1080).lowResolution, false, 'a tall image is fine at 1080 high, however narrow')
assert.equal(fullScreenFit(0, 10), null)
assert.equal(lowResolutionNote(1600, 900), 'Low resolution for full screen (1600×900)')
assert.equal(lowResolutionNote(3000, 2000), null)

// ---- widget + overlay ----
const dom = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.document = dom.window.document
globalThis.window = dom.window
globalThis.Event = dom.window.Event
const { ImageWidget } = await import(new URL('../src/renderer/src/extensions/imageWidget.ts', import.meta.url))

let details = 0
const onClick = () => { details += 1 }
const widget = new ImageWidget('twasset://img-abc1234', 'Cap', 'img-abc1234', onClick, false, { kind: 'row', index: 2, count: 3 })
const root = widget.toDOM()
document.body.appendChild(root)
const chip = root.querySelector('.cm-image-placement-chip')
assert.equal(chip?.textContent, 'In a row (2 of 3)')
assert.ok(chip.querySelector('svg'), 'the chip carries an icon')
assert.equal(new ImageWidget('twasset://img-abc1234', '', null, null, false, null).toDOM().querySelector('.cm-image-placement-chip'), null, 'no placement, no chip')
assert.equal(widget.eq(new ImageWidget('twasset://img-abc1234', 'Cap', 'img-abc1234', onClick, false, { kind: 'full', index: 1, count: 1 })), false, 'a new placement redraws')

const fire = (el, type) => el.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true }))
fire(root, 'mousedown')
assert.equal(document.querySelector('.tw-image-fullscreen'), null, 'mousedown alone opens nothing')
fire(root, 'click')
const overlay = document.querySelector('.tw-image-fullscreen')
assert.ok(overlay, 'a click opens the overlay')
const img = overlay.querySelector('img')
assert.equal(img.src, 'twasset://img-abc1234')
Object.defineProperty(img, 'naturalWidth', { value: 1600 })
Object.defineProperty(img, 'naturalHeight', { value: 900 })
img.dispatchEvent(new dom.window.Event('load'))
assert.equal(overlay.querySelector('.tw-image-fullscreen-size').textContent, '1600 × 900 px')
assert.equal(overlay.querySelector('.tw-image-fullscreen-note').textContent, 'Low resolution for full screen (1600×900)')
assert.match(img.style.width, /83\.3+\d*cqw/, 'shown at its own size on a 1920 screen, not enlarged (1600/1920 of the stage width)')

dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
assert.equal(document.querySelector('.tw-image-fullscreen'), null, 'Escape closes')
fire(root, 'click')
fire(document.querySelector('.tw-image-fullscreen'), 'click')
assert.equal(document.querySelector('.tw-image-fullscreen'), null, 'a click closes')
fire(root, 'click')
document.querySelector('.tw-image-fullscreen button').click()
assert.equal(details, 1, 'Image details opens the metadata panel')
assert.equal(document.querySelector('.tw-image-fullscreen'), null)

console.log('editor image size: ok')
