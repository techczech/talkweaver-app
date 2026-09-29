// =============================================================================
// test:section-divider-eyebrow — section dividers print no automatic "Section" eyebrow
//
// Decided 2026-09-24: the tinted divider already says it is a section, so the old
// `h1::before { content: "Section" }` eyebrow is gone. What must still hold:
//   1. a divider with no kicker renders no "Section" text (computed h1::before content is none)
//   2. a kicker on a divider still shows, styled as before (mono, accent colour, visible)
//   3. the subsection divider's parent-section eyebrow (a compiler-supplied kicker) still shows
//
// Compiles a real deck (prepareSource → model.fullHtml) and reads computed styles in Chromium.
// =============================================================================

import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const dir = mkdtempSync(join(tmpdir(), 'tw-divider-eyebrow-'))
const source = [
  '---', 'title: Divider probe', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  // A bare `##` with children: the structural divider default, no kicker authored.
  '## Plain Divider', '', '### Child one', '', 'Body one.', '',
  // A divider with an authored kicker.
  '## Kicked Divider', '{layout=section-title kicker="Part two"}', '', '### Child two', '', 'Body two.', '',
  // A `###` with children: a subsection divider whose kicker is the parent section's title.
  '### Sub Divider', '', '#### Grandchild', '', 'Body three.'
].join('\n')
const path = join(dir, 'divider-probe.md')
writeFileSync(path, source, 'utf8')
const model = await prepareSource(path, source, 'Divider probe', statSync(path))
const htmlPath = join(dir, 'divider-probe.html')
writeFileSync(htmlPath, model.fullHtml, 'utf8')

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  await page.goto(`file://${htmlPath}`, { waitUntil: 'load' })
  const probe = (id) => page.evaluate((slideId) => {
    const slides = [...document.querySelectorAll('.stage > .slide')]
    const slide = slides.find((node) => node.dataset.id === slideId)
    if (!slide) return null
    slides.forEach((node) => node.classList.toggle('active', node === slide))
    const content = slide.querySelector('.slide-content')
    const h1 = content?.querySelector('h1')
    const kicker = content?.querySelector('.kicker')
    const before = h1 ? getComputedStyle(h1, '::before').content : null
    const kickerStyle = kicker ? getComputedStyle(kicker) : null
    return {
      layoutClass: content?.className ?? '',
      before,
      text: slide.innerText,
      kicker: kicker ? {
        text: kicker.textContent,
        visible: kickerStyle.display !== 'none' && kickerStyle.visibility !== 'hidden' && kicker.getBoundingClientRect().height > 0,
        mono: /mono/i.test(kickerStyle.fontFamily),
        weight: kickerStyle.fontWeight,
        colour: kickerStyle.color,
        accent: (() => {
          const swatch = document.createElement('span')
          swatch.style.color = 'var(--accent)'
          kicker.parentElement.appendChild(swatch)
          const colour = getComputedStyle(swatch).color
          swatch.remove()
          return colour
        })()
      } : null
    }
  }, id)
  const noEyebrow = (before) => before === 'none' || before === 'normal' || before === '""'

  const plain = await probe('plain-divider')
  assert(plain, 'the deck carries the plain divider')
  assert.match(plain.layoutClass, /\blayout-section-title\b/, 'a bare ## with children compiles to the section divider')
  assert.equal(plain.kicker, null, 'the plain divider has no authored kicker')
  assert(noEyebrow(plain.before), `a divider with no kicker paints no ::before eyebrow (got ${plain.before})`)
  assert.doesNotMatch(plain.text, /section/i, 'a divider with no kicker renders no "Section" text')
  console.log('PASS: divider with no kicker renders no "Section" eyebrow')

  const kicked = await probe('kicked-divider')
  assert(kicked, 'the deck carries the kicked divider')
  assert.match(kicked.layoutClass, /\blayout-section-title\b/, 'the kicked slide is a section divider')
  assert.equal(kicked.kicker?.text, 'Part two', 'the authored kicker is on the divider')
  assert.equal(kicked.kicker.visible, true, 'the authored kicker shows')
  assert.equal(kicked.kicker.mono, true, 'the authored kicker keeps the mono face')
  assert.equal(kicked.kicker.weight, '500', 'the authored kicker keeps weight 500')
  assert.equal(kicked.kicker.colour, kicked.kicker.accent, 'the authored kicker keeps the accent colour')
  assert(noEyebrow(kicked.before), `no ::before eyebrow beside an authored kicker (got ${kicked.before})`)
  assert.doesNotMatch(kicked.text, /section/i, 'no "Section" text beside an authored kicker')
  console.log('PASS: authored kicker still shows on a divider, mono, weight 500, accent colour')

  const sub = await probe('sub-divider')
  assert(sub, 'the deck carries the subsection divider')
  assert.equal(sub.kicker?.text, 'Kicked Divider', 'the subsection divider keeps its parent-section eyebrow')
  assert.equal(sub.kicker.visible, true, 'the parent-section eyebrow shows')
  assert(noEyebrow(sub.before), `no "Section" ::before on the subsection divider (got ${sub.before})`)
  console.log('PASS: subsection divider keeps its parent-section eyebrow')
} finally {
  await browser.close()
}
console.log('section divider eyebrow: no automatic "Section" label; authored and parent-section kickers still show passed')
