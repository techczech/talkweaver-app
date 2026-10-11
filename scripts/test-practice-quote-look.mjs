// test:practice-quote-look — onboarding 0.38.1 ticket 05: the practice quotation and key caps as
// drawn in state 07 (light theme), read from computed styles in chrome-headless-shell (Playwright's
// headless Chromium) on a real compiled deck (prepareSource → model.fullHtml) and its handout.
//
// State 07's slide: the title "Move through the talk" shows; "Open the presenter with F5." and
// "**Try it.** Press → for the next slide, ← to go back, and the letter **O** for the outline."
// The practice line has a left rule in the accent, no quotation mark, no tint, upright text, the
// bold lead-in in ink, and upright key caps in a sans face (O and 0 differ) at 12px or more.
// A quotation with no key cap keeps the quote device (mark, accent bold, cite).
// The handout shows the same key cap (same computed face, size, border and fill).
// SCREENSHOT=<path> saves the practice slide at 1280×720.
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'

const dir = mkdtempSync(join(tmpdir(), 'tw-practice-quote-look-'))
const source = [
  '---', 'title: Practice quote look', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '## 06 Present', '',
  '### Move through the talk', '{id=practice}', '',
  'Open the presenter with <kbd>F5</kbd>.', '',
  '> **Try it.** Press <kbd>→</kbd> for the next slide, <kbd>←</kbd> to go back, and the letter **O** for the outline.', '',
  '### Letter and digit', '{id=letter-digit}', '',
  'The letter <kbd>O</kbd> and the digit <kbd>0</kbd>.', '',
  '### A plain quote', '{id=plain}', '',
  'Some context.', '',
  '> We think with **metaphors** before we notice them.', ''
].join('\n')
const path = join(dir, 'practice-quote-look.md')
writeFileSync(path, source, 'utf8')
const model = await prepareSource(path, source, 'Practice quote look', statSync(path))
const deckPath = join(dir, 'deck.html')
writeFileSync(deckPath, model.fullHtml, 'utf8')
const handoutPath = join(dir, 'handout.html')
writeFileSync(handoutPath, buildShareHtml({
  title: 'Practice quote look', slides: extractSlides(model.fullHtml), styles: extractStyles(model.fullHtml),
  includeNotes: false, slug: 'practice-quote-look', license: null
}), 'utf8')

let passed = 0
const check = (name, fn) => {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

// Reads one slide (made the active one) by id.
function probe(page, slideId) {
  return page.evaluate((id) => {
    const slides = [...document.querySelectorAll('section.slide')]
    const slide = slides.find((node) => node.dataset.id === id)
    if (!slide) return null
    if (slide.parentElement?.classList.contains('stage')) slides.forEach((node) => node.classList.toggle('active', node === slide))
    const colour = (value) => {
      const probeEl = document.createElement('span')
      probeEl.style.color = value
      slide.appendChild(probeEl)
      const out = getComputedStyle(probeEl).color
      probeEl.remove()
      return out
    }
    const pick = (el, pseudo, props) => {
      const style = getComputedStyle(el, pseudo)
      return Object.fromEntries(props.map((prop) => [prop, style.getPropertyValue(prop)]))
    }
    const quote = slide.querySelector('.slide-content blockquote')
    const caps = [...slide.querySelectorAll('kbd.key-cap')].map((cap) => ({
      text: cap.textContent,
      width: cap.getBoundingClientRect().width,
      ...pick(cap, null, ['font-family', 'font-size', 'font-style', 'font-weight', 'border-top-width', 'border-bottom-width', 'border-top-style', 'background-color', 'color'])
    }))
    const h1 = slide.querySelector('.slide-head h1')
    return {
      accent: colour(getComputedStyle(slide).getPropertyValue('--accent').trim()),
      title: h1 ? { text: h1.textContent, srOnly: h1.classList.contains('sr-only') } : null,
      quote: quote ? {
        className: quote.className,
        style: pick(quote, null, ['border-left-style', 'border-left-width', 'border-left-color', 'background-color', 'font-style', 'color']),
        mark: pick(quote, '::before', ['content']),
        cite: Boolean(quote.querySelector('cite')),
        strong: [...quote.querySelectorAll('strong')].map((el) => pick(el, null, ['color', 'font-weight', 'background-color']))
      } : null,
      caps
    }
  }, slideId)
}

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  await page.goto(`file://${deckPath}`, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts?.ready)
  const practice = await probe(page, 'practice')
  if (process.env.SCREENSHOT) {
    await page.waitForTimeout(300)
    await page.screenshot({ path: process.env.SCREENSHOT })
  }
  const letters = await probe(page, 'letter-digit')
  const plain = await probe(page, 'plain')

  check('the practice slide keeps its visible title', () => {
    assert.equal(practice.title.text.replace(/ /g, ' '), 'Move through the talk')
    assert.equal(practice.title.srOnly, false)
  })
  check('the practice line: accent left rule, no mark, no tint, no cite, upright', () => {
    assert.match(practice.quote.className, /\bpractice-quote\b/)
    assert.equal(practice.quote.style['border-left-style'], 'solid')
    assert.ok(parseFloat(practice.quote.style['border-left-width']) >= 4, practice.quote.style['border-left-width'])
    assert.equal(practice.quote.style['border-left-color'], practice.accent)
    assert.equal(practice.quote.mark.content, 'none')
    assert.equal(practice.quote.style['background-color'], 'rgba(0, 0, 0, 0)')
    assert.equal(practice.quote.style['font-style'], 'normal')
    assert.equal(practice.quote.cite, false)
  })
  check('the "Try it." lead-in and the letter O are bold in ink, not accent', () => {
    assert.equal(practice.quote.strong.length, 2)
    for (const strong of practice.quote.strong) {
      assert.equal(strong.color, practice.quote.style.color)
      assert.notEqual(strong.color, practice.accent)
      assert.ok(Number(strong['font-weight']) >= 700)
      assert.equal(strong['background-color'], 'rgba(0, 0, 0, 0)')
    }
  })
  check('three upright key caps in a sans face at 12px or more', () => {
    assert.deepEqual(practice.caps.map((cap) => cap.text), ['F5', '→', '←'])
    for (const cap of practice.caps) {
      assert.ok(!/mono|menlo|courier|consolas/i.test(cap['font-family']), cap['font-family'])
      assert.ok(parseFloat(cap['font-size']) >= 12, cap['font-size'])
      assert.equal(cap['font-style'], 'normal')
      assert.equal(cap['border-top-style'], 'solid')
      assert.ok(parseFloat(cap['border-bottom-width']) > parseFloat(cap['border-top-width']), 'heavier bottom edge')
    }
  })
  check('the letter O and the digit 0 read differently', () => {
    const [capO, cap0] = letters.caps
    assert.deepEqual([capO.text, cap0.text], ['O', '0'])
    assert.ok(Math.abs(capO.width - cap0.width) >= 2, `O ${capO.width}px vs 0 ${cap0.width}px`)
  })
  check('a quotation without a key cap keeps the quote device', () => {
    assert.ok(!/practice-quote/.test(plain.quote.className))
    assert.equal(plain.quote.mark.content, '"“"')
    assert.equal(plain.quote.cite, true)
    assert.equal(plain.quote.strong[0].color, plain.accent)
    assert.equal(plain.caps.length, 0)
  })

  const handout = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  await handout.goto(`file://${handoutPath}`, { waitUntil: 'load' })
  await handout.evaluate(() => document.fonts?.ready)
  const inHandout = await probe(handout, 'practice')
  check('the handout shows the same key caps', () => {
    assert.ok(inHandout, 'practice slide in the handout')
    assert.deepEqual(inHandout.caps.map((cap) => cap.text), ['F5', '→', '←'])
    const keys = ['font-family', 'font-size', 'font-style', 'font-weight', 'border-top-width', 'border-bottom-width', 'background-color', 'color']
    for (let i = 0; i < 3; i += 1) {
      for (const key of keys) assert.equal(inHandout.caps[i][key], practice.caps[i][key], `${key} of ${practice.caps[i].text}`)
    }
    assert.match(inHandout.quote.className, /\bpractice-quote\b/)
  })
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}
console.log(`test:practice-quote-look ${passed} passed`)
