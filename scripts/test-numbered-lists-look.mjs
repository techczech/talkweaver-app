// =============================================================================
// test:numbered-lists-look — ADR-0028 decision 6 (slide design, 2026-09-25)
//
// What must hold:
//   1. Registry: {numbered=square|plain|styled} are registered values (the generated trigger
//      dictionary carries them, they parse without an unresolved-trigger warning), an unknown
//      value warns `numbered-unknown`, and the Inspector offers Number style nested under List
//      style exactly when the slide's list style is Numbered.
//   2. Compiler: a numbered list takes the icon-list treatment with the number in the icon's
//      place (.fl-numbered; rows above three items or with {iconlist=list}, cards otherwise). A
//      `1.` list tagged as an icon list with icons off keeps its numbers (was .fl-plain).
//   3. Rows (default square): the number's box is the icon's box — 1.75em of the item, 1.1em from
//      the text, centred on its item — with a 2px accent outline and no fill.
//   4. Cards: the number heads the card in the card icon's 1.9em box, above the heading.
//   5. Plain: no outline, the numeral at the text size with a full stop, on the first line.
//      Styled: no outline, a light (300) numeral 2.1× the text, centred on its item.
//
// Compiles a real deck (prepareSource → model.fullHtml) with the round-2 specimens (ypdgq,
// 86l6l) and reads computed styles and rects in Chromium at 1600×900 and 1280×720 after the
// runtime fit pass.
// =============================================================================

import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { parseHeadingAttrs } from '../compiler/scripts/lib/02-triggers-layout.mjs'
import { VALUE_TRIGGER_DICTIONARY } from '../compiler/scripts/lib/trigger-dictionary.generated.mjs'
import { GLOBAL_OPTION_GROUPS, LAYOUTS } from '../src/shared/layout-registry/entries.ts'
import { groupApplies, optionGroupsForSlide, sectionedOptionGroups } from '../src/shared/layout-registry/options.ts'
import { commitOptionSelection, selectionForGroup } from '../src/shared/trigger-line.ts'

// ── 1. Registry and Inspector ────────────────────────────────────────────────
assert.deepEqual([...(VALUE_TRIGGER_DICTIONARY.numbered ?? [])].sort(), ['plain', 'square', 'styled'],
  'the generated trigger dictionary carries the three number styles')
for (const value of ['square', 'plain', 'styled']) {
  const parsed = parseHeadingAttrs(`Title {numbered=${value}}`)
  assert.equal(parsed.attrs.numbered, value, `{numbered=${value}} parses to the numbered attr`)
  assert.deepEqual(parsed.warnings, [], `{numbered=${value}} is registered vocabulary (no unresolved-trigger warning)`)
}
const numberStyle = GLOBAL_OPTION_GROUPS.find((group) => group.key === 'number-style')
assert.ok(numberStyle, 'Number style is a global option group')
assert.deepEqual(numberStyle.values.map((value) => value.token), ['', 'numbered=plain', 'numbered=styled'],
  'Number style offers Square (default), Plain and Styled')
assert.ok(LAYOUTS.find((entry) => entry.name === 'numbered').options.includes(numberStyle),
  'the numbered entry adopts Number style, as the iconlist entry adopts its treatment')
const listSection = (triggerLine) => {
  const context = { layoutName: 'list', headingLevel: 3, hasChildren: false }
  const candidates = optionGroupsForSlide(context)
  const selectedTokens = Object.fromEntries(candidates.map(({ group }) => [group.key, selectionForGroup(triggerLine, group)]))
  const applicable = candidates.filter(({ group }) => groupApplies(group, { ...context, selectedTokens }))
  return sectionedOptionGroups(applicable, 'List')[0].bindings
    .map((binding) => binding.nestedUnder ? `${binding.nestedUnder}>${binding.group.key}` : binding.group.key)
}
assert.deepEqual(listSection('{list}{numbered}'), ['list-style', 'list-style>number-style', 'icon-level'],
  'a numbered list offers Number style under List style')
assert.deepEqual(listSection('{list}'), ['list-style', 'icon-level'], 'a plain list does not offer Number style')
assert.ok(!listSection('{list}{iconlist}').includes('list-style>number-style'), 'an icon list does not offer Number style')
assert.equal(selectionForGroup('{list}{numbered}{numbered=styled}', numberStyle), 'numbered=styled', 'the authored style lights its button')
assert.equal(commitOptionSelection('{list}{numbered}', numberStyle, 'numbered=plain'), '{list}{numbered=plain}{numbered}',
  'choosing Plain writes exactly {numbered=plain}')
const listStyleGroup = LAYOUTS.find((entry) => entry.name === 'list').options.find((group) => group.key === 'list-style')
assert.equal(commitOptionSelection('{list}{numbered}{numbered=plain}', listStyleGroup, 'iconlist'), '{list}{iconlist}',
  'leaving Numbered drops the number style whose group no longer applies')
console.log('PASS registry: {numbered=square|plain|styled} registered; Number style nests under List style on numbered lists only')

// ── 2. Compiler output ───────────────────────────────────────────────────────
const PROMPTS = [
  '1. “Check if the daily meal allowance is 40 or 45.”',
  '2. “Fill in the existing expenses and I will add the receipts later.”',
  '3. “Check my private accounts folder for other receipts and update the form. Taas is just one expense: one till receipt and one credit card receipt. Use the value on the card receipt.”',
  '4. “Add my signature and date, and put an email in my drafts with all the attachments.”'
]
const PARTS = ['1. Nature of AI', '  2. Models', '  3. Apps', '2. Utility of AI', '  3. Practical examples']
const ICON_ROWS = [
  '- **Model capability** can run for longer {icon=lucide:cpu}',
  '- **Speed of developments** three releases between June and August {icon=lucide:zap}',
  '- **More modalities** voice models wait while you speak {icon=lucide:mic}',
  '- **Cost of AI** from $20 a month {icon=lucide:coins}'
]
const ICON_CARDS = ['- Speed {icon=lucide:zap}', '  - Faster', '  - Cheaper', '- Judgement {icon=lucide:brain}', '  - Better']
const dir = mkdtempSync(join(tmpdir(), 'tw-numbered-lists-'))
const source = [
  '---', 'title: Numbered lists probe', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '## Specimens', '',
  // Round-2 specimens: ypdgq (current-state-ai-agents-2026) and 86l6l (exploring-the-nature…).
  '### Follow-up prompts', '{id=ypdgq}{list}{iconlist=list}{iconlist}{icons=off}', '', ...PROMPTS, '',
  '### Follow-up prompts', '{id=rows-plain}{list}{numbered}{numbered=plain}', '', ...PROMPTS, '',
  '### Follow-up prompts', '{id=rows-styled}{list}{numbered=styled}', '', ...PROMPTS.map((line) => line.replace(/^\d+\. /, '- ')), '',
  '### Parts', '{id=86l6l} {list}{numbered}', ...PARTS, '',
  '### Parts', '{id=cards-bogus} {list}{numbered=tiles}', ...PARTS, '',
  // The icon geometry the number must match.
  '### Trends', '{iconlist=list} {id=icon-rows}', '', ...ICON_ROWS, '',
  // ypdgq's own items as icon rows: the numbered rows must fit exactly as these do.
  '### Follow-up prompts', '{id=icon-prompts}{list}{iconlist=list}', '',
  ...PROMPTS.map((line, i) => `${line.replace(/^\d+\. /, '- ')} {icon=lucide:${['cpu', 'zap', 'mic', 'coins'][i]}}`), '',
  '### Trends', '{iconlist} {id=icon-cards}', '', ...ICON_CARDS
].join('\n')
const path = join(dir, 'numbered-lists.md')
writeFileSync(path, source, 'utf8')
const model = await prepareSource(path, source, 'Numbered lists probe', statSync(path))
const htmlPath = join(dir, 'numbered-lists.html')
writeFileSync(htmlPath, model.fullHtml, 'utf8')
const listOf = (id) => {
  const at = model.fullHtml.indexOf(`data-id="${id}"`)
  assert(at > 0, `${id} compiles`)
  return model.fullHtml.slice(at).match(/<ul class="feature-list[^"]*"[^>]*>[\s\S]*?<\/ul>(?:<\/li>)?/)?.[0] ?? ''
}
const classOf = (id) => listOf(id).match(/^<ul class="([^"]*)"/)[1].split(/\s+/)
const numbersOf = (id) => [...listOf(id).matchAll(/<span class="fl-icon fl-num">(\d+)<\/span>/g)].map((m) => Number(m[1]))
assert.deepEqual(classOf('ypdgq').filter((c) => c !== 'feature-list').sort(), ['fl-iconlist-list', 'fl-numbered'],
  'ypdgq ({iconlist=list}{iconlist}{icons=off} on a `1.` list) is numbered icon rows, not a plain list')
assert.deepEqual(numbersOf('ypdgq'), [1, 2, 3, 4], 'ypdgq keeps its four numbers')
assert.ok(classOf('rows-plain').includes('fl-numbered-plain'), '{numbered=plain} stamps the plain style')
assert.ok(classOf('rows-styled').includes('fl-numbered-styled') && classOf('rows-styled').includes('fl-iconlist-list'),
  '{numbered=styled} alone makes a bullet list numbered, in rows above three items')
assert.deepEqual(numbersOf('rows-styled'), [1, 2, 3, 4], '{numbered=styled} numbers a bullet list')
assert.ok(classOf('86l6l').includes('fl-numbered') && !classOf('86l6l').includes('fl-iconlist-list'),
  'two numbered items with sub-items are numbered cards')
assert.ok(model.warnings.includes('numbered-unknown:tiles'), 'an unknown number style warns')
assert.ok(!classOf('cards-bogus').some((c) => c.startsWith('fl-numbered-')), 'an unknown number style falls back to the square')
console.log('PASS compiler: numbered lists take the icon-list treatment; the icons-off `1.` list keeps its numbers')

// ── 3–5. Computed styles ─────────────────────────────────────────────────────
const close = (a, b, tolerance = 0.5) => Math.abs(a - b) <= tolerance
const browser = await chromium.launch({ headless: true })
try {
  for (const viewport of [{ width: 1600, height: 900 }, { width: 1280, height: 720 }]) {
    const key = `${viewport.width}x${viewport.height}`
    const page = await browser.newPage({ viewport })
    await page.goto(`file://${htmlPath}`, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    const probe = (id) => page.evaluate((slideId) => {
      const slides = [...document.querySelectorAll('.stage > .slide')]
      const slide = slides.find((node) => node.dataset.id === slideId)
      if (!slide) return null
      slides.forEach((node) => node.classList.toggle('active', node === slide))
      window.__autofitForTest?.()
      // Canvas px (ADR-0030): the slide lives on the 1280×720 stage, scaled to the window; a painted
      // rect is read relative to the stage and divided by the stage's scale.
      const stageEl = slide.parentElement, sr = stageEl.getBoundingClientRect(), k = sr.width / stageEl.offsetWidth
      const rect = (el) => { const r = el.getBoundingClientRect(); return { left: (r.left - sr.left) / k, right: (r.right - sr.left) / k, top: (r.top - sr.top) / k, bottom: (r.bottom - sr.top) / k, width: r.width / k, height: r.height / k } }
      const list = slide.querySelector('.slide-content > .feature-list')
      const accent = getComputedStyle(slide).getPropertyValue('--accent').trim()
      const probeColour = document.createElement('span')
      probeColour.style.color = accent
      slide.append(probeColour)
      const accentRgb = getComputedStyle(probeColour).color
      probeColour.remove()
      return {
        accentRgb,
        listGap: parseFloat(getComputedStyle(list).getPropertyValue('--list-gap')) || 1,
        items: [...list.children].map((li) => {
          const icon = li.querySelector(':scope > .fl-icon')
          const iconStyle = getComputedStyle(icon)
          const after = getComputedStyle(icon, '::after').content
          const text = li.querySelector(':scope > .fl-text')
          const range = document.createRange()
          range.selectNodeContents(icon)
          const glyphs = [...range.getClientRects()].filter((r) => r.width > 0)
          return {
            fontSize: parseFloat(getComputedStyle(li).fontSize),
            icon: rect(icon),
            glyph: glyphs.length ? { top: (Math.min(...glyphs.map((r) => r.top)) - sr.top) / k, bottom: (Math.max(...glyphs.map((r) => r.bottom)) - sr.top) / k } : null,
            text: rect(text),
            border: { style: iconStyle.borderTopStyle, width: parseFloat(iconStyle.borderTopWidth), color: iconStyle.borderTopColor },
            background: iconStyle.backgroundColor,
            iconFontSize: parseFloat(iconStyle.fontSize),
            fontWeight: Number(iconStyle.fontWeight),
            color: iconStyle.color,
            after
          }
        })
      }
    }, id)

    // 3. Rows, default square: the icon row's box, gap and centring.
    const iconRows = await probe('icon-rows')
    const rows = await probe('ypdgq')
    const iconBoxEm = iconRows.items[0].icon.width / iconRows.items[0].fontSize
    for (const [i, item] of rows.items.entries()) {
      const label = `${key} numbered row ${i + 1}`
      const em = item.fontSize
      assert(close(item.icon.width, 1.75 * em) && close(item.icon.height, 1.75 * em), `${label}: number box is 1.75em (${item.icon.width.toFixed(1)}×${item.icon.height.toFixed(1)} for ${em}px)`)
      assert(close(item.icon.width / em, iconBoxEm, 0.02), `${label}: number box matches the icon row's box (${(item.icon.width / em).toFixed(3)}em vs ${iconBoxEm.toFixed(3)}em)`)
      assert(close(item.text.left - item.icon.right, 1.1 * em), `${label}: text starts 1.1em after the number (got ${(item.text.left - item.icon.right).toFixed(1)}px)`)
      const boxCentre = (item.icon.top + item.icon.bottom) / 2
      const textCentre = (item.text.top + item.text.bottom) / 2
      assert(Math.abs(boxCentre - textCentre) <= 2, `${label}: number centre ${boxCentre.toFixed(1)} within 2px of text centre ${textCentre.toFixed(1)}`)
      assert.equal(item.border.style, 'solid', `${label}: the square is outlined`)
      assert(close(item.border.width, 2, 0.01), `${label}: the outline is 2px`)
      assert.equal(item.border.color, rows.accentRgb, `${label}: the outline is the accent`)
      assert.equal(item.color, rows.accentRgb, `${label}: the numeral is the accent`)
      assert.match(item.background, /rgba\(0, 0, 0, 0\)|transparent/, `${label}: the square has no fill (got ${item.background})`)
      assert(item.fontWeight >= 700, `${label}: the numeral is bold`)
    }
    const fontSizes = new Set(rows.items.map((item) => item.fontSize))
    assert.equal(fontSizes.size, 1, `${key}: every numbered row reads at one size`)
    // The same items as icon rows: the fitter treats the number exactly as it treats the icon.
    const iconPrompts = await probe('icon-prompts')
    assert(close(rows.items[0].fontSize, iconPrompts.items[0].fontSize), `${key}: numbered rows fit to the icon rows' size for the same items (${rows.items[0].fontSize} vs ${iconPrompts.items[0].fontSize})`)
    assert(close(rows.listGap, iconPrompts.listGap, 0.001), `${key}: numbered rows fit to the icon rows' spacing (--list-gap ${rows.listGap} vs ${iconPrompts.listGap})`)
    rows.items.forEach((item, i) => assert(close(item.icon.top, iconPrompts.items[i].icon.top, 1), `${key} numbered row ${i + 1}: number box sits where the icon does (${item.icon.top.toFixed(1)} vs ${iconPrompts.items[i].icon.top.toFixed(1)})`))
    console.log(`PASS ${key}: numbered rows — 2px accent square in the 1.75em icon box, 1.1em from the text, centred, fitted as icon rows are (${rows.items[0].fontSize}px)`)

    // 4. Cards: the number heads the card in the card icon's box.
    const iconCards = await probe('icon-cards')
    const cards = await probe('86l6l')
    const cardIconEm = iconCards.items[0].icon.width / iconCards.items[0].fontSize
    for (const [i, card] of cards.items.entries()) {
      const label = `${key} numbered card ${i + 1}`
      const em = card.fontSize
      assert(close(card.icon.width, 1.9 * em) && close(card.icon.height, 1.9 * em), `${label}: number box is 1.9em (${card.icon.width.toFixed(1)} for ${em}px)`)
      assert(close(card.icon.width / em, cardIconEm, 0.02), `${label}: number box matches the card icon's box (${(card.icon.width / em).toFixed(3)}em vs ${cardIconEm.toFixed(3)}em)`)
      assert(card.icon.bottom <= card.text.top + 0.5, `${label}: the number sits above the heading`)
      assert(close(card.icon.left, card.text.left), `${label}: the number and the heading share a left edge`)
      assert.equal(card.border.style, 'solid', `${label}: the square is outlined`)
    }
    assert(close(cards.items[0].icon.top, cards.items[1].icon.top), `${key}: the card numbers share one top edge`)
    console.log(`PASS ${key}: numbered cards — the square heads each card in the 1.9em card-icon box`)

    // 5. Plain and styled rows.
    const plain = await probe('rows-plain')
    for (const [i, item] of plain.items.entries()) {
      const label = `${key} plain row ${i + 1}`
      assert.equal(item.border.style, 'none', `${label}: no outline`)
      assert(close(item.iconFontSize, item.fontSize), `${label}: the numeral is the text size (${item.iconFontSize} vs ${item.fontSize})`)
      assert.equal(item.after, '"."', `${label}: the numeral carries a full stop`)
      assert(close(item.glyph.top, item.text.top, 2), `${label}: the numeral sits on the first line (${item.glyph.top.toFixed(1)} vs ${item.text.top.toFixed(1)})`)
    }
    assert.equal(new Set(plain.items.map((item) => Math.round(item.text.left))).size, 1, `${key}: plain rows start their text at one x`)
    const styled = await probe('rows-styled')
    for (const [i, item] of styled.items.entries()) {
      const label = `${key} styled row ${i + 1}`
      assert.equal(item.border.style, 'none', `${label}: no outline`)
      assert(close(item.iconFontSize, 2.1 * item.fontSize), `${label}: the numeral is 2.1× the text (${item.iconFontSize} vs ${item.fontSize})`)
      assert.equal(item.fontWeight, 300, `${label}: the numeral is light`)
      assert.equal(item.after, 'none', `${label}: no full stop`)
      const boxCentre = (item.icon.top + item.icon.bottom) / 2
      const textCentre = (item.text.top + item.text.bottom) / 2
      assert(Math.abs(boxCentre - textCentre) <= 2, `${label}: the numeral is centred on its item (${boxCentre.toFixed(1)} vs ${textCentre.toFixed(1)})`)
    }
    console.log(`PASS ${key}: plain numerals at the text size with a full stop on the first line; styled numerals 2.1× and light, centred`)
    await page.close()
  }
} finally {
  await browser.close()
}
console.log('numbered lists look (ADR-0028 §6): all checks passed')
