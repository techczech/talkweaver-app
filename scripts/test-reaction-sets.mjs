// Ticket 04: a slide's own reactions, {reactions=…} (ADR-0027 amendment §6; surfaces-and-states §
// Trigger-line token). Seams: the one reader/writer (compiler/scripts/lib/reaction-sets.mjs), the
// runtime's reading of the compiled list (audienceSlideReactions), and the compiler's output — the
// slide model, the deck section and the published audience page — for a slide with each token form.
// The bar drawing each form in a browser is scripts/audience-reaction-sets-dom.test.mjs.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CUSTOM_LABEL_MAX, MAX_REACTIONS, STANDARD_REACTIONS, customLabelsProblem, reactionLabel, reactionWarnings,
  reactionsToken, readReactionsValue, registeredReactions
} from '../compiler/scripts/lib/reaction-sets.mjs'
import { audienceReactionIcons, audienceReactionRegistry, audienceSlideReactions } from '../compiler/assets/runtime/audience-reactions.js'
import { tokenizeTriggerBody } from '../compiler/scripts/lib/trigger-tokenizer.mjs'
import { parseTriggerLine } from '../compiler/scripts/lib/02-triggers-layout.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { formatWarning, warningDefinition } from '../compiler/scripts/lib/warning-registry.mjs'

// ── The registry: nine reactions, the standard three first, each with a lucide icon the bar draws ──
const registry = registeredReactions()
assert.deepEqual(registry.map((entry) => entry.id), ['puzzled', 'helped', 'bookmark', 'agree', 'disagree', 'yes', 'no', 'more', 'slower'],
  'the registered vocabulary, in the order the Inspector offers it')
assert.deepEqual(STANDARD_REACTIONS, registry.slice(0, 3).map((entry) => entry.id), 'the standard set is the first three')
const icons = audienceReactionIcons()
for (const entry of registry) assert.ok(icons[entry.icon], `${entry.id}: the bar has its icon ${entry.icon}`)
assert.deepEqual(
  Object.fromEntries(registry.map((entry) => [entry.id, [entry.icon, entry.words]])),
  {
    puzzled: ['frown', 'Puzzled by this'], helped: ['lightbulb', 'Helped me understand'], bookmark: ['bookmark', 'Bookmark: I need to return to this'],
    agree: ['thumbs-up', 'Agree'], disagree: ['thumbs-down', 'Disagree'], yes: ['check', 'Yes'], no: ['x', 'No'],
    more: ['message-circle-more', 'Tell me more'], slower: ['snail', 'Slower, please']
  },
  'icons and words as surfaces-and-states lists them'
)
assert.equal(Object.keys(audienceReactionRegistry()).length, registry.length, 'one list: the runtime registry is the compiler’s')

// ── Reading a value ──────────────────────────────────────────────────────────────────────────
const read = (value) => { const result = readReactionsValue(value); return [result.mode, result.ids, result.issues.map((issue) => issue.code)] }
assert.deepEqual(read(undefined), ['standard', ['puzzled', 'helped', 'bookmark'], []], 'no token: the standard three')
assert.deepEqual(read('off'), ['off', [], []], 'off: no reactions')
assert.deepEqual(read('agree,disagree'), ['choose', ['agree', 'disagree'], []], 'a replacement set, in order, no bookmark')
assert.deepEqual(read('agree,disagree,bookmark'), ['choose', ['agree', 'disagree', 'bookmark'], []], 'the bookmark only when named')
assert.deepEqual(read('Too fast,Just right,Too slow'), ['custom', ['custom:Too fast', 'custom:Just right', 'custom:Too slow'], []], 'custom labels')
assert.deepEqual(read('agree,Maybe'), ['custom', ['agree', 'custom:Maybe'], []], 'a mix keeps the named one named')
assert.deepEqual(read(' agree , disagree '), ['choose', ['agree', 'disagree'], []], 'spaces around a value go')
assert.deepEqual(read('Agree'), ['custom', ['custom:Agree'], ['label-like-named']], 'only the exact id is the registered reaction; other case is a custom label with a hint')
assert.equal(readReactionsValue('Too fast,Agree').issues[0].id, 'agree', 'the hint names the reaction it looks like')
// Review fix: a space after a comma ends the list token ({reactions=agree, disagree} reads agree,).
assert.deepEqual(read('agree,'), ['choose', ['agree'], ['list-space']], 'a value ending in a comma is the space-after-comma mark')
assert.deepEqual(read('agree,disagree,yes,no,more'), ['choose', ['agree', 'disagree', 'yes', 'no'], ['too-many']], 'a fifth is left out, with an issue')
assert.equal(readReactionsValue('agree,disagree,yes,no,more,slower').issues[0].count, 6, 'the issue counts what was written')
assert.deepEqual(read('agree,agree'), ['choose', ['agree'], ['duplicate']], 'a duplicate is offered once')
assert.deepEqual(read('off,agree'), ['off', [], ['off-with-others']], 'off with others stays off')
const long = 'A label that runs well past the forty characters the worker takes'
const cut = readReactionsValue(long)
assert.deepEqual([cut.ids[0].length - 'custom:'.length <= CUSTOM_LABEL_MAX, cut.issues.map((issue) => issue.code)], [true, ['label-too-long']], 'a long label is cut to 40')
assert.equal(MAX_REACTIONS, 4, 'at most four')
assert.equal(reactionLabel('custom:Too fast'), 'Too fast', 'a custom id’s label')
assert.equal(reactionLabel('bookmark'), 'Bookmark', 'a registered id’s short name')

// ── Writing a choice: exactly one token (Standard none), which reads back as the same choice ──
const tokens = [
  [{ mode: 'standard' }, ''],
  [{ mode: 'off' }, 'reactions=off'],
  [{ mode: 'choose', ids: ['agree', 'disagree'] }, 'reactions=agree,disagree'],
  [{ mode: 'custom', labels: ['Too fast', 'Just right', 'Too slow'] }, 'reactions="Too fast","Just right","Too slow"'],
  [{ mode: 'choose', ids: [] }, ''],
  [{ mode: 'custom', labels: [] }, '']
]
for (const [choice, token] of tokens) {
  assert.equal(reactionsToken(choice), token, `${JSON.stringify(choice)} writes ${token || 'no token'}`)
  if (!token) continue
  // Through the real tokenizer and heading parser: one token, and the same meaning back.
  const parsed = tokenizeTriggerBody(token)
  assert.equal(parsed.length, 1, `${token}: one token on the Trigger line`)
  const attrs = parseTriggerLine(`{${token}}`)
  assert.deepEqual(attrs.warnings, [], `${token}: registered (no unresolved-trigger)`)
  const back = readReactionsValue(attrs.attrs.reactions)
  assert.equal(back.mode, choice.mode, `${token}: reads back as ${choice.mode}`)
  if (choice.ids) assert.deepEqual(back.ids, choice.ids, `${token}: the same set`)
  if (choice.labels) assert.deepEqual(back.ids, choice.labels.map((label) => `custom:${label}`), `${token}: the same labels`)
}
assert.throws(() => reactionsToken({ mode: 'choose', ids: ['agree', 'maybe'] }), /Not a registered reaction/, 'choose takes registered ids only')
assert.throws(() => reactionsToken({ mode: 'choose', ids: ['agree', 'disagree', 'yes', 'no', 'more'] }), /Up to 4/, 'choose takes four at most')
assert.equal(customLabelsProblem(['Too fast']), '', 'one label is fine')
assert.match(customLabelsProblem(['a', 'b', 'c', 'd', 'e']), /Up to 4/, 'five labels are refused')
assert.match(customLabelsProblem(['Say "hi"']), /quotes/, 'a quote is refused')
assert.match(customLabelsProblem(['x'.repeat(41)]), /40/, 'a label over 40 is refused')
assert.match(customLabelsProblem(['Same', 'Same']), /once/, 'a repeated label is refused')
assert.equal(customLabelsProblem(['yes']), '“yes” is the named reaction yes; choose it under Choose.', 'a label spelled as a registered id is refused')
// Review fix: the refusal ignores case — "Agree" in the Custom field is the named reaction agree.
assert.equal(customLabelsProblem(['Too fast', 'Agree']), '“Agree” is the named reaction agree; choose it under Choose.', 'a label matching a named reaction in other case is refused')
assert.equal(customLabelsProblem(['SLOWER']), '“SLOWER” is the named reaction slower; choose it under Choose.', 'any case')

// ── The compiler's warnings, registered with words the strip and Inspector show ──
const warnings = reactionWarnings('pace', [{ code: 'too-many', count: 5 }, { code: 'duplicate' }, { code: 'label-too-long' }, { code: 'off-with-others' }, { code: 'list-space' }, { code: 'label-like-named', id: 'agree' }])
assert.deepEqual(warnings, ['reactions-too-many:pace:5', 'reactions-duplicate:pace', 'reactions-label-too-long:pace', 'reactions-off-with-others:pace', 'reactions-list-space:pace', 'reactions-label-like-named:pace:agree'])
for (const warning of warnings) {
  assert.ok(warningDefinition(warning), `${warning}: registered`)
  assert.ok(warningDefinition(warning).surfaces.includes('inspector') && warningDefinition(warning).surfaces.includes('strip-badge'), `${warning}: shown on the strip and in the Inspector`)
}
assert.equal(formatWarning('reactions-list-space:pace'), 'No space after the comma in {reactions=…} on slide pace: the list stopped at the space, and what follows was read as separate triggers. Write the list without spaces, as {reactions=agree,disagree}; quote a label with spaces, as "Too fast".')
assert.equal(formatWarning('reactions-label-like-named:pace:agree'), 'Slide pace has a custom reaction label spelled like the named reaction agree; it shows as a label in words, without the icon. Write the name in lower case for the named reaction with its icon, or keep the label.')
assert.equal(formatWarning('reactions-too-many:pace:5'), 'Slide pace names 5 reactions; the bar offers only the first four. Keep at most four reactions on a slide.')

// ── The runtime reads the compiled list; anything malformed is dropped, never drawn ──
const itemIds = (list) => audienceSlideReactions(list).map((item) => [item.id, item.words, item.icon, item.custom])
assert.deepEqual(itemIds(null), [['puzzled', 'Puzzled by this', 'frown', false], ['helped', 'Helped me understand', 'lightbulb', false], ['bookmark', 'Bookmark: I need to return to this', 'bookmark', false]], 'no list: the standard set')
assert.deepEqual(itemIds([]), [], 'off: nothing')
assert.deepEqual(itemIds(['agree', 'custom:Too fast']), [['agree', 'Agree', 'thumbs-up', false], ['custom:Too fast', 'Too fast', null, true]], 'named with icon; custom words only')
assert.deepEqual(itemIds(['agree', 'agree', 'nonsense', 'custom:', 'yes', 'no', 'more', 'slower']).map(([id]) => id), ['agree', 'yes', 'no', 'more'], 'duplicates, unknown ids and empty labels dropped; four at most')

// ── The compiler's output for a slide with each token form: model, deck section, audience page ──
const OUTLINE = `---
title: Reaction sets
auto_title_slide: false
auto_thanks_slide: false
---

### Standard slide
{id=r-standard}

- One

### Off slide
{id=r-off} {reactions=off}

- Two

### Agree slide
{id=r-agree} {reactions=agree,disagree}

- Three

### Agree with bookmark
{id=r-agree-bm} {reactions=agree,disagree,bookmark}

- Four

### Custom slide
{id=r-custom} {reactions="Too fast","Just right","Too slow"}

- Five

### Five slide
{id=r-five} {reactions=agree,disagree,yes,no,more}

- Six

### Space after comma
{id=r-space} {reactions=agree, disagree}

- Eight

### Look-alike label
{id=r-like} {reactions="Agree","Maybe"}

- Nine

### Label markup slide
{id=r-markup} {reactions="<img src=x onerror=alert(1)>","A & B"}

- Seven
`
const dir = mkdtempSync(join(tmpdir(), 'reaction-sets-'))
const path = join(dir, 'reaction-sets.md')
writeFileSync(path, OUTLINE)
const model = await prepareSource(path, OUTLINE, 'Reaction sets', statSync(path))
rmSync(dir, { recursive: true, force: true })
const expected = {
  'r-standard': undefined,
  'r-off': [],
  'r-agree': ['agree', 'disagree'],
  'r-agree-bm': ['agree', 'disagree', 'bookmark'],
  'r-custom': ['custom:Too fast', 'custom:Just right', 'custom:Too slow'],
  'r-five': ['agree', 'disagree', 'yes', 'no'],
  'r-space': ['agree'],
  'r-like': ['custom:Agree', 'custom:Maybe'],
  'r-markup': ['custom:<img src=x onerror=alert(1)>', 'custom:A & B']
}
for (const [id, list] of Object.entries(expected)) {
  assert.deepEqual(model.slides.find((slide) => slide.id === id)?.reactions, list, `${id}: the slide model carries ${JSON.stringify(list)}`)
}
assert.ok(model.warnings.includes('reactions-too-many:r-five:5'), 'the fifth reaction warns')
assert.ok(model.warnings.includes('reactions-list-space:r-space'), 'a space after the comma gets its own warning')
assert.ok(model.warnings.includes('reactions-label-like-named:r-like:agree'), 'a custom label spelled like a named reaction gets a hint')
assert.equal(model.warnings.filter((warning) => /^(unresolved|unknown)-trigger:/.test(warning) && !/reactions=agree,|disagree/.test(warning)).length, 0,
  'every well-formed token is registered (the space-after-comma slide is the only unresolved one)')
// The Layout Doctor (what blanks the Inspector) names the reason with the unresolved token.
const { scanOutlineTriggers, triggerWarningPayloadsForSlide } = await import('../src/shared/layout-doctor.ts')
const spaceFindings = scanOutlineTriggers(OUTLINE).filter((finding) => finding.token === 'reactions=agree,')
assert.equal(spaceFindings.length, 1, 'the cut-short token is one finding')
assert.match(spaceFindings[0].hint ?? '', /^No space after the comma in \{reactions=…\}/, 'with the space-after-comma hint')
const spacePayloads = triggerWarningPayloadsForSlide({ source_line: spaceFindings[0].headingLine }, spaceFindings)
assert.match(formatWarning(spacePayloads[0]), /Unresolved trigger: reactions=agree, — No space after the comma in \{reactions=…\}/, 'the Inspector’s unresolved row says why')
// The deck section (the presenter window is the compiled deck) and the audience page carry it.
const dataOf = (html, id) => {
  const tag = html.match(new RegExp(`<section class="slide" data-id="${id}"[^>]*>`))?.[0]
  assert.ok(tag, `${id}: its section is in the page`)
  const attr = tag.match(/ data-reactions="([^"]*)"/)?.[1]
  return attr === undefined ? undefined : JSON.parse(attr.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'))
}
for (const [id, list] of Object.entries(expected)) assert.deepEqual(dataOf(model.fullHtml, id), list, `${id}: the deck section's data-reactions`)
const share = buildShareHtml({
  title: 'Reaction sets', slug: 'reaction-sets', liveTalkSlug: 'reaction-sets', workerBaseUrl: 'https://live.example.test',
  includeNotes: false, license: null, styles: extractStyles(model.fullHtml), slides: extractSlides(model.fullHtml)
})
for (const [id, list] of Object.entries(expected)) assert.deepEqual(dataOf(share, id), list, `${id}: the audience page's data-reactions`)
assert.ok(!/data-reactions="[^"]*<img/.test(share), 'a custom label is escaped in the attribute, never markup')
assert.match(share, /getSlideReactions: \(slideId\) =>/, 'the audience page hands the bar each slide’s own set')

console.log('reaction sets: registry, reader, writer and warnings; the compiler stamps each form on the deck and the audience page')
