import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'

const dir = mkdtempSync(join(tmpdir(), 'tw-round-b-'))
let probe = 0

async function compile(label, trigger, body = 'A **boxed phrase** that carries the point.') {
  const source = [
    '---',
    `title: ${label}`,
    'auto_title_slide: false',
    'auto_thanks_slide: false',
    '---',
    '',
    `### ${label}`,
    trigger,
    '',
    body
  ].join('\n')
  const path = join(dir, `${++probe}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`)
  writeFileSync(path, source, 'utf8')
  const model = await prepareSource(path, source, label, statSync(path))
  return { model, html: await buildDeckHtmlFromModel(model) }
}

const iconBody = [
  '- Speed {icon=lucide:zap}',
  '- Judgement {icon=lucide:brain}',
  '- Craft {icon=lucide:wrench}'
].join('\n')

const iconBoxes = await compile('Icon boxes', '{iconlist}', iconBody)
assert.match(iconBoxes.html, /class="feature-list[^"\n]*"/, 'bare iconlist still renders a feature list')
const iconBoxesMarkup = iconBoxes.html.match(/<ul class="feature-list[^"\n]*">[\s\S]*?<\/ul>/)?.[0] ?? ''
assert.doesNotMatch(iconBoxesMarkup, /fl-iconlist-list/, 'bare iconlist keeps the current boxes treatment')

const iconRows = await compile('Icon rows', '{iconlist=list}', iconBody)
assert.match(iconRows.html, /class="feature-list[^"\n]*fl-iconlist-list[^"\n]*"/, 'list variant stamps the plain-row rendering hook')
const iconRowsMarkup = iconRows.html.match(/<ul class="feature-list[^"\n]*fl-iconlist-list[^"\n]*">[\s\S]*?<\/ul>/)?.[0] ?? ''
assert.doesNotMatch(iconRowsMarkup, /fl-num/, 'fully resolved list-variant icons do not render fallback numbers')

// A value-form {iconlist=…} must never override a list style the author wrote — that was the
// dead List-style toggle (Dominik, 2026-09-21): the treatment value is still recorded, but the
// authored style wins. ADR-0028 §6 (2026-09-25): a numbered list now takes the icon-list layout
// with its numbers, so {iconlist=list} gives it the rows — the numbers stay, no icon replaces them.
const fiveItems = [
  '- Item one {icon=lucide:tally-1}',
  '- Item two {icon=lucide:tally-2}',
  '- Item three {icon=lucide:tally-3}',
  '- Item four {icon=lucide:tally-4}',
  '- Item five {icon=lucide:tally-5}'
].join('\n')
const numberedWithVariant = await compile('Numbered with variant', '{numbered}{iconlist=list}', fiveItems)
const numberedBlock = numberedWithVariant.model.slides[0].blocks.find((block) => block.type === 'feature-list')
assert.equal(numberedBlock.liststyle, 'numbers', '{numbered}{iconlist=list} resolves liststyle numbers')
assert.equal(numberedBlock.iconlistVariant, 'list', '{numbered}{iconlist=list} still records the treatment value')
const numberedMarkup = numberedWithVariant.html.match(/<ul class="feature-list[^"\n]*">[\s\S]*?<\/ul>/)?.[0] ?? ''
assert.match(numberedMarkup, /^<ul class="[^"]*\bfl-iconlist-list\b[^"]*\bfl-numbered\b/, 'a numbered list with {iconlist=list} takes the rows as a numbered list')
assert.match(numberedMarkup, /fl-num/, 'the numbered list keeps its numbers')
assert.doesNotMatch(numberedMarkup, /<svg/, 'no icon replaces a number')
const variantFirst = await compile('Variant first numbered', '{iconlist=list}{numbered}', fiveItems)
const variantFirstBlock = variantFirst.model.slides[0].blocks.find((block) => block.type === 'feature-list')
assert.equal(variantFirstBlock.liststyle, 'numbers', 'token order cannot resurrect the override')
const variantFirstMarkup = variantFirst.html.match(/<ul class="feature-list[^"\n]*">[\s\S]*?<\/ul>/)?.[0] ?? ''
assert.equal(variantFirstMarkup.replace(/data-id="[^"]*"/g, ''), numberedMarkup.replace(/data-id="[^"]*"/g, ''), 'token order does not change the numbered rows')
const logoWithVariant = await compile('Logos with variant', '{logolist}{iconlist=list}', fiveItems)
const logoBlock = logoWithVariant.model.slides[0].blocks.find((block) => block.type === 'feature-list')
assert.equal(logoBlock.liststyle, 'logos', '{logolist}{iconlist=list} keeps the authored logo style')

// The bare-{iconlist} count rule is unchanged at both sides of the 3/4 boundary.
const fourItems = [
  '- Speed {icon=lucide:zap}',
  '- Judgement {icon=lucide:brain}',
  '- Craft {icon=lucide:wrench}',
  '- Care {icon=lucide:heart}'
].join('\n')
const fourAutoRows = await compile('Four auto rows', '{iconlist}', fourItems)
assert.match(fourAutoRows.html, /class="feature-list[^"\n]*fl-iconlist-list/, 'the >3-item auto rule still takes the plain icon rows')

const iconUnknown = await compile('Icon unknown', '{iconlist=tiles}', iconBody)
assert(iconUnknown.model.warnings.includes('iconlist-unknown:tiles'), 'unknown iconlist value warns')
const iconUnknownMarkup = iconUnknown.html.match(/<ul class="feature-list[^"\n]*">[\s\S]*?<\/ul>/)?.[0] ?? ''
assert.doesNotMatch(iconUnknownMarkup, /fl-iconlist-list/, 'unknown iconlist value falls back to boxes')

const statementDefault = await compile('Statement default', '{statement}')
assert.match(statementDefault.html, /class="slide-content layout-statement"/, 'bare statement markup stays unchanged')

// Ticket 02: the older one-word options are presets over the separate choices, and stamp each
// choice's own hook (Halo, Aligned, no bar stamp nothing).
const statementTint = await compile('Statement tint', '{statement=tint}')
assert.match(statementTint.html, /class="slide-content layout-statement statement-bar-left"/, 'Tint is Halo + the left bar')

const statementBar = await compile('Statement bar', '{statement=bar}')
assert.match(statementBar.html, /class="slide-content layout-statement statement-bg-none statement-bar-left"/, 'Bar is no colour + the left bar')

const statementFull = await compile('Statement full', '{statement=full}')
assert.match(statementFull.html, /class="slide-content layout-statement statement-bg-full"/, 'Full colour is the Full background')

const statementChoices = await compile('Statement choices', '{statement}{statement-bg=none}{statement-align=centred}{statement-bar=bottom}{statement-sidebar=off}')
assert.match(statementChoices.html, /class="slide-content layout-statement statement-bg-none statement-centred statement-bar-bottom statement-no-sidebar"/,
  'each choice stamps its own hook; No sidebar beside a title puts the title on top')
assert.match(statementChoices.html, /data-title-layout="top"/, 'No sidebar beside a title: the title goes to the top')
const statementDimensionsOnly = await compile('Statement dimensions only', '{statement-bar=top}')
assert.match(statementDimensionsOnly.html, /class="slide-content layout-statement statement-bar-top"/, 'a statement choice alone implies the statement layout')
const statementBadValue = await compile('Statement bad value', '{statement}{statement-bar=middle}')
assert(statementBadValue.model.warnings.includes('statement-unknown:statement-bar=middle'), 'an unknown choice value warns')
assert.match(statementBadValue.html, /class="slide-content layout-statement"/, 'an unknown choice value falls back to the default')

// ADR-0028 §10: Centred only without a title — beside the rail it renders as the Default.
const statementCentredTitled = await compile('Statement centred titled', '{statement=centred}')
assert.match(statementCentredTitled.html, /class="slide-content layout-statement"/, 'Centred with a title renders as the Default')
assert.equal(statementCentredTitled.model.warnings.some((warning) => warning.startsWith('statement-unknown')), false, 'centred is a registered value')

// Poster is retired: the token still parses, silently, and the slide renders as the Default.
const statementPoster = await compile('Statement poster', '{statement=poster}')
assert.match(statementPoster.html, /class="slide-content layout-statement"/, 'a Poster slide renders as the Default')
assert.doesNotMatch(statementPoster.html, /class="slide-content layout-statement[^"]*statement-poster/, 'Poster no longer stamps a class')
assert.equal(statementPoster.model.warnings.some((warning) => warning.startsWith('statement-unknown')), false, '{statement=poster} does not warn')
assert.match(statementPoster.html, /<strong>boxed phrase<\/strong>/, 'a former Poster keeps its boxed key-phrase markup')

const statementUnknown = await compile('Statement unknown', '{statement=placard}')
assert(statementUnknown.model.warnings.includes('statement-unknown:placard'), 'unknown statement value warns')
assert.match(statementUnknown.html, /class="slide-content layout-statement"/, 'unknown statement value falls back to default')
assert.doesNotMatch(statementUnknown.html, /statement-placard/, 'unknown statement value never invents a class')

const tintHexes = {
  cobalt: '#e8eefc',
  emerald: '#e4f3ee',
  vermilion: '#fcece3',
  forest: '#e4f3ee'
}
for (const [name, tint] of Object.entries(tintHexes)) {
  const compiled = await compile(`Background ${name}`, `{bg=${name}}`, '- Background is independent\n- Accent remains section-owned')
  const style = compiled.html.match(/<section[^>]*style="([^"]*)"/)?.[1] ?? ''
  assert(style.includes(`--slide-bg: ${tint}`), `${name}: section carries the named readable tint`)
  assert(style.includes('--sec-accent:'), `${name}: setting bg preserves the section accent stamp`)
  assert.equal(compiled.model.warnings.includes(`bg-unknown:${name}`), false, `${name}: known bg never warns`)
}

const bgUnknown = await compile('Background unknown', '{bg=ultraviolet}', '- No invented colour')
assert(bgUnknown.model.warnings.includes('bg-unknown:ultraviolet'), 'unknown background warns')
assert.doesNotMatch(bgUnknown.html, /--slide-bg:/, 'unknown background emits no background stamp')

const sectionSource = [
  '---',
  'title: Background independence',
  'auto_title_slide: false',
  'auto_thanks_slide: false',
  '---',
  '',
  '## Pinned section',
  '{id=round-b-section}{accent=vermilion}',
  '',
  '### Tinted child',
  '{id=round-b-bg}{bg=cobalt}',
  '',
  '- Tint changes the paper only',
  '',
  '### Plain child',
  '{id=round-b-plain}',
  '',
  '- Accent remains section-owned'
].join('\n')
const sectionPath = join(dir, `${++probe}-background-independence.md`)
writeFileSync(sectionPath, sectionSource, 'utf8')
const sectionModel = await prepareSource(sectionPath, sectionSource, 'Background independence', statSync(sectionPath))
const sectionHtml = await buildDeckHtmlFromModel(sectionModel)
const styleFor = (id) => sectionHtml.match(new RegExp(`<section[^>]*data-id="${id}"[^>]*style="([^"]*)"`))?.[1] ?? ''
const bgStyle = styleFor('round-b-bg')
const plainStyle = styleFor('round-b-plain')
assert(bgStyle.includes('--sec-accent: #c2410c'), 'background slide keeps its pinned vermilion section accent')
assert(plainStyle.includes('--sec-accent: #c2410c'), 'sibling slide keeps the same pinned vermilion section accent')
assert(bgStyle.includes('--slide-bg: #e8eefc'), 'background tint is added independently on the authored slide')
assert.doesNotMatch(plainStyle, /--slide-bg:/, 'background tint does not leak to sibling slides')

console.log('round B variants: all checks passed')
