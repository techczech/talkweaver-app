/**
 * A talk with carousels, built into the handout (buildShareHtml) the way the Download handout and the publisher
 * do. Shared by the handout print test and the handout carousel DOM test.
 *   Opening slide, Paragraph carousel (3 items), Heading carousel (2 `####` items), Picture carousel (2: one has an
 *   image), Tall carousel (2: the second is taller than a page), a plain slide, a Cards gallery (non-carousel
 *   exclusive gallery) and the closing slide.
 */
import { statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { prepareSource } from '../../compiler/scripts/lib/08-source-adapters.mjs'
import { buildDeckHtmlFromModel } from '../../compiler/scripts/lib/07-assembly.mjs'
import { extractSlides, extractStyles } from '../../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../../compiler/scripts/lib/09-output-builders.mjs'

export function png(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  const row = Buffer.alloc(1 + width * 3, 0x9a)
  row[0] = 0
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** Words that appear once each in the printed text, in page order, with the slide they belong to. */
export const CAROUSEL_WORDS = {
  opening: 'A first statement.',
  paragraph: ['Alpha thought.', 'Beta thought.', 'Gamma thought.'],
  heading: ['Delta body text.', 'Epsilon body text.'],
  picture: ['Zeta caption text.', 'Eta words.'],
  tall: ['Theta short.', 'Tallest bullet number 14.'],
  closing: 'The last statement.'
}
export const CAROUSEL_ITEM_COUNT = 9
export const CAROUSEL_SLIDE_COUNT = 4

export function carouselOutline(imagePath) {
  const bullets = Array.from({ length: 14 }, (_, i) => `- Tallest bullet number ${i + 1}${i === 13 ? '.' : ' with enough words to wrap onto a second line when the slide is narrow'}`)
  return [
    '# Carousel probe', '', '## Probe', '',
    '### Opening slide {id=opening}', '{statement}', '', CAROUSEL_WORDS.opening, '',
    '### Paragraph carousel {id=para-car}', '{carousel}', '', ...CAROUSEL_WORDS.paragraph.flatMap((w) => [w, '']),
    '### Heading carousel {id=head-car}', '{carousel}', '', '#### First heading item', '', CAROUSEL_WORDS.heading[0], '', '#### Second heading item', '', CAROUSEL_WORDS.heading[1], '',
    '### Picture carousel {id=pic-car}', '{carousel}', '', '#### Picture item', '', `![A grey picture](${imagePath})`, '', CAROUSEL_WORDS.picture[0], '', '#### Plain item', '', CAROUSEL_WORDS.picture[1], '',
    '### Tall carousel {id=tall-car}', '{carousel}', '', '#### Short item', '', CAROUSEL_WORDS.tall[0], '', '#### Tall item', '', ...bullets, '',
    '### Closing slide {id=closing-st}', '{statement}', '', CAROUSEL_WORDS.closing, ''
  ].join('\n')
}

/** Write the image and the outline into `dir`, build the handout, return { html, htmlPath, slideCount }. */
export async function buildCarouselHandout(dir, name, options = {}, markdown) {
  const imagePath = join(dir, 'grey.png')
  writeFileSync(imagePath, png(1200, 800))
  const md = markdown ?? carouselOutline(imagePath)
  const path = join(dir, `${name}.md`)
  writeFileSync(path, md)
  const model = await prepareSource(path, md, 'Talk', statSync(path), undefined, { allowedAssetRoots: [dir] })
  const deck = await buildDeckHtmlFromModel(model)
  const slides = extractSlides(deck)
  const html = buildShareHtml({ title: 'Talk', slug: 't', includeNotes: false, license: null, slides, styles: extractStyles(deck), ...options })
  const htmlPath = join(dir, `${name}.html`)
  writeFileSync(htmlPath, html)
  return { html, htmlPath, slideCount: slides.length, slides }
}
