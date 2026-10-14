// =============================================================================
// test:statement-background-values — the statement Background value set (slide redesign, 13 Oct 2026).
//
// The set is tinted | rule | strong | lower-third. Every older value and one-word option must keep
// compiling to the look it maps to (spec 1.6), at each seam that reads the values:
//   1. the resolver (compiler/scripts/lib/statement-options.mjs): value, synonym, preset and deck
//      claim_style mapping; the retired Bar dimension is accepted and has no effect;
//   2. the assembly hooks (07-assembly): Tinted stamps nothing, the others stamp their own hook,
//      and the inline slide background an authored {bg=…} adds is kept only for Rule;
//   3. the generated trigger dictionary and the Inspector's copy (src/shared/statement-options.ts):
//      the new and the retired values are registered; the Inspector lights the mapped value.
// =============================================================================
import assert from 'node:assert/strict'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  STATEMENT_DEFAULTS, STATEMENT_DIMENSION_VALUES, STATEMENT_PRESETS, canonicalStatementValue, resolveStatementOptions, statementDimensionTokens
} from '../compiler/scripts/lib/statement-options.mjs'
import { VALUE_TRIGGER_DICTIONARY } from '../compiler/scripts/lib/trigger-dictionary.generated.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { statementSelections } from '../src/shared/statement-options.ts'

// 1. The resolver.
assert.deepEqual(STATEMENT_DIMENSION_VALUES.bg, ['tinted', 'rule', 'strong', 'lower-third'], 'the four Backgrounds, canonical first')
assert.equal(STATEMENT_DEFAULTS.bg, 'tinted', 'Tinted is the default')
const MAPPED = { tinted: 'tinted', rule: 'rule', strong: 'strong', 'lower-third': 'lower-third', halo: 'tinted', panel: 'tinted', default: 'tinted', full: 'tinted', none: 'rule' }
for (const [value, want] of Object.entries(MAPPED)) assert.equal(canonicalStatementValue('bg', value), want, `statement-bg=${value} → ${want}`)
assert.equal(canonicalStatementValue('bg', ' Strong '), 'strong', 'case and spaces are forgiven')
assert.equal(canonicalStatementValue('bg', 'glow'), null, 'an unknown value is not canonical')
for (const bar of ['none', 'off', 'left', 'top', 'above', 'bottom', 'below']) {
  const look = resolveStatementOptions({ 'statement-bar': bar })
  assert.equal(look.bar, 'none', `statement-bar=${bar} is accepted and has no effect`)
  assert.deepEqual(look.warnings, [], `statement-bar=${bar} raises no warning`)
}
assert.deepEqual(resolveStatementOptions({ 'statement-bar': 'middle' }).warnings, ['statement-unknown:statement-bar=middle'], 'an unknown Bar value still warns')

const PRESET_WANT = [
  [{}, 'tinted', 'left', 'default'],
  [{ statement: true }, 'tinted', 'left', 'default'],
  [{ statement: 'default' }, 'tinted', 'left', 'default'],
  [{ statement: 'poster' }, 'tinted', 'left', 'default'],
  [{ claim: 'plain' }, 'tinted', 'left', 'default'],
  [{ statement: 'centred' }, 'tinted', 'centred', 'centred'],
  [{ statement: 'tint' }, 'tinted', 'left', 'tint'],
  [{ statement: 'full' }, 'tinted', 'left', 'full'],
  [{ statement: 'bar' }, 'rule', 'left', 'bar'],
  [{ claim: 'bar' }, 'rule', 'left', 'bar']
]
for (const [attrs, bg, align, preset] of PRESET_WANT) {
  const look = resolveStatementOptions(attrs)
  assert.deepEqual([look.bg, look.align, look.bar, look.preset, look.warnings], [bg, align, 'none', preset, []], `${JSON.stringify(attrs)} → ${bg}, ${align}`)
}
assert.equal(resolveStatementOptions({}, { deckClaimStyle: 'bar' }).bg, 'rule', 'a deck claim_style: bar is Rule')
assert.equal(resolveStatementOptions({ claim: 'plain' }, { deckClaimStyle: 'bar' }).bg, 'tinted', 'a slide {claim=plain} wins over the deck')
assert.equal(resolveStatementOptions({ 'statement-bg': 'strong' }, { deckClaimStyle: 'bar' }).bg, 'strong', 'a choice of its own ends following the deck')
assert.equal(resolveStatementOptions({ statement: 'bar', 'statement-bg': 'lower-third' }).bg, 'lower-third', 'a per-dimension token overrides only its own dimension of a preset')
assert.equal(resolveStatementOptions({ statement: 'centred' }).centredNeedsNoTitle, true, 'the older Centred still needs no title')
assert.deepEqual(Object.keys(STATEMENT_PRESETS).sort(), ['bar', 'centred', 'default', 'full', 'tint'], 'the presets are unchanged')
assert.deepEqual(statementDimensionTokens({ sidebar: '', bg: 'tinted', align: 'left', bar: 'none' }), [], 'the defaults write no token')
assert.deepEqual(statementDimensionTokens({ sidebar: '', bg: 'lower-third', align: 'centred', bar: 'none' }), ['statement-bg=lower-third', 'statement-align=centred'], 'a choice writes its own token')

// 2. The assembly hooks.
const dir = mkdtempSync(join(tmpdir(), 'tw-statement-background-values-'))
let probe = 0
async function compile(tokens, extra = '') {
  const source = ['---', 'title: Background values', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '', '## S', '', '### This is an important statement slide', `{id=probe}${tokens}`, '', extra, ''].join('\n')
  const path = join(dir, `${++probe}-outline.md`)
  writeFileSync(path, source, 'utf8')
  const model = await prepareSource(path, source, 'Background values', statSync(path))
  const html = String(model.fullHtml)
  return {
    hooks: html.match(/<div class="slide-content layout-statement([^"]*)"/)?.[1].trim() ?? null,
    section: html.match(/<section[^>]*data-id="probe"[^>]*>/)?.[0] ?? '',
    warnings: model.warnings.filter((warning) => String(warning).startsWith('statement-unknown'))
  }
}
const HOOKS = {
  '{statement}': '', '{statement=default}': '', '{statement=poster}': '', '{statement=tint}': '', '{statement=full}': '', '{claim=plain}{statement}': '',
  '{statement}{statement-bg=tinted}': '', '{statement}{statement-bg=halo}': '', '{statement}{statement-bg=panel}': '', '{statement}{statement-bg=default}': '', '{statement}{statement-bg=full}': '',
  '{statement}{statement-bg=rule}': 'statement-bg-rule', '{statement}{statement-bg=none}': 'statement-bg-rule', '{statement=bar}': 'statement-bg-rule', '{statement}{claim=bar}': 'statement-bg-rule',
  '{statement}{statement-bg=strong}': 'statement-bg-strong', '{statement}{statement-bg=lower-third}': 'statement-bg-lower-third',
  '{statement}{statement-bg=strong}{statement-align=centred}': 'statement-bg-strong statement-centred',
  '{statement}{statement-bar=left}': '', '{statement}{statement-bar=top}': '', '{statement}{statement-bar=bottom}': '', '{statement=tint}{statement-bar=left}': '',
  '{statement=bar}{statement-bar=none}': 'statement-bg-rule'
}
for (const [tokens, want] of Object.entries(HOOKS)) {
  const compiled = await compile(tokens)
  assert.equal(compiled.hooks, want, `${tokens} stamps "${want}" (got "${compiled.hooks}")`)
  assert.deepEqual(compiled.warnings, [], `${tokens} raises no statement warning`)
}
const stamped = await compile('{statement}{statement-bg=rule}')
assert.doesNotMatch(stamped.hooks, /statement-bar|statement-bg-(none|full)/, 'the retired hooks are never stamped')
// The inline slide background an authored {bg=…} adds: kept for Rule (the normal page), dropped for the
// backgrounds the skin paints itself.
for (const [bg, kept] of [['tinted', false], ['rule', true], ['strong', false], ['lower-third', false]]) {
  const compiled = await compile(`{statement}{statement-bg=${bg}}{bg=cobalt}`)
  assert.match(compiled.section, /--slide-bg: #e8eefc/, `${bg}: the authored colour is carried as --slide-bg`)
  assert.equal(/background: var\(--slide-bg\)/.test(compiled.section), kept, `${bg}: the inline slide background is ${kept ? 'kept' : 'dropped'}`)
}

// 3. The trigger dictionary and the Inspector's copy.
assert.deepEqual(VALUE_TRIGGER_DICTIONARY['statement-bg'].slice().sort(), ['full', 'halo', 'lower-third', 'none', 'rule', 'strong', 'tinted'], 'the dictionary registers the new and the retired Background values')
assert.deepEqual(VALUE_TRIGGER_DICTIONARY['statement-bar'].slice().sort(), ['bottom', 'left', 'none', 'top'], 'the dictionary still registers the Bar values')
const lit = (line, context) => statementSelections(line, context)['statement-bg']
assert.equal(lit('{statement}'), '', 'an untokened statement lights Tinted')
assert.equal(lit('{statement}{statement-bg=halo}'), '', 'Halo lights Tinted')
assert.equal(lit('{statement=full}'), '', 'the older Full lights Tinted')
assert.equal(lit('{statement=bar}'), 'statement-bg=rule', 'the older Bar lights Rule')
assert.equal(lit('{statement}{statement-bg=none}'), 'statement-bg=rule', 'None lights Rule')
assert.equal(lit('{statement}{statement-bg=lower-third}'), 'statement-bg=lower-third', 'Lower third lights itself')
assert.equal(lit('{statement}', { deckClaimStyle: 'bar' }), 'statement-bg=rule', 'a Bar deck lights Rule')
assert.equal('statement-bar' in statementSelections('{statement}'), false, 'the Inspector no longer lights a Bar choice')

console.log('statement background values: resolver, assembly hooks, dictionary and Inspector copy agree')
