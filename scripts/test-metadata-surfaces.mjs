// Metadata surfaces gate (Composition Ticket 9).
//
// Dominik, 2026-09-11: "the metadata is not working properly — not everything has selectable
// options and not clearly described." This gate makes that categorical, FROM THE REGISTRY ALONE:
// every user-owned frontmatter key reaches both surfaces, every closed vocabulary is a picker
// (never a free text box), every explanation — the key's and each option's — is in the rendered
// model, and system keys are read-only with the consequence named.
//
// It tests the view-model seam (`src/shared/metadata-surfaces.ts`), a pure function over the
// registry, plus a source check that neither component has grown a private field list again.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { METADATA_REGISTRY } from '../src/shared/metadata-registry.ts'
import { editFrontmatterText } from '../src/shared/frontmatter-editor.ts'
import {
  PICKER_CONTROLS,
  SEGMENTED_LIMIT,
  SYSTEM_GROUP_LABEL,
  SYSTEM_NOTE_PREFIX,
  controlForEntry,
  deckSettingsViewModel,
  frontmatterFieldViewModel,
  frontmatterSurfaceViewModel
} from '../src/shared/metadata-surfaces.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const isPicker = (control) => PICKER_CONTROLS.includes(control)

const active = METADATA_REGISTRY.filter((entry) => entry.location === 'frontmatter' && !entry.since)
const userEntries = active.filter((entry) => entry.ownership === 'user')
const systemEntries = active.filter((entry) => entry.ownership === 'system')
assert(userEntries.length > 0 && systemEntries.length > 0, 'registry must declare frontmatter keys of both ownerships')

// ── 1. Closed vocabularies are pickers, never typing ──────────────────────────
for (const entry of active) {
  if (entry.vocabulary.kind !== 'closed') continue
  const control = controlForEntry(entry)
  assert(
    isPicker(control),
    `${entry.key}: a closed vocabulary must render as a picker, got "${control}"`
  )
  const expected = entry.vocabulary.options.length > SEGMENTED_LIMIT ? 'select' : 'segmented'
  assert.equal(control, expected, `${entry.key}: ${entry.vocabulary.options.length} choices must render as ${expected}`)
  assert(
    entry.vocabulary.options.some((option) => option.value === ''),
    `${entry.key}: a closed vocabulary needs an option for the state the compiler treats as default (value: ''), or the current value can fall outside every choice`
  )
}

// ── 2. Typed fields get the control their declaration demands ─────────────────
for (const entry of active) {
  if (entry.vocabulary.kind === 'closed') continue
  const control = controlForEntry(entry)
  if (entry.type === 'map') assert.equal(control, 'map', `${entry.key}: map keys render as a structured block`)
  else if (entry.type === 'number') assert(['number', 'url'].includes(control), `${entry.key}: number keys render as a number input`)
  else if (entry.type === 'boolean') assert.equal(control, 'toggle', `${entry.key}: an undocumented boolean renders as a toggle`)
  else assert(['text', 'url', 'number'].includes(control), `${entry.key}: open text renders as a text box, got "${control}"`)
}

// ── 3. Deck settings: every user key present, explained, grouped in registry order ──
const emptyDeck = deckSettingsViewModel(METADATA_REGISTRY, [])
const deckFields = emptyDeck.groups.flatMap((group) => group.fields)
const deckKeys = new Set(deckFields.map((field) => field.key))
for (const entry of userEntries) {
  assert(deckKeys.has(entry.key), `Deck settings must render ${entry.key}`)
  const field = deckFields.find((candidate) => candidate.key === entry.key)
  assert.equal(field.control, controlForEntry(entry), `${entry.key}: Deck settings control must be the one the vocabulary demands`)
  assert.equal(field.explanation, entry.explanation, `${entry.key}: the registry explanation must be in the rendered model, verbatim`)
  assert.equal(field.readOnly, false, `${entry.key}: a user-owned key must stay editable`)
  if (entry.vocabulary.kind === 'closed') {
    assert(field.options, `${entry.key}: a closed vocabulary must arrive as options`)
    assert.equal(field.options.length, entry.vocabulary.options.length, `${entry.key}: every documented choice must be offered`)
    for (const option of entry.vocabulary.options) {
      const rendered = field.options.find((candidate) => candidate.value === option.value)
      assert(rendered, `${entry.key}: choice "${option.value}" missing from the model`)
      assert.equal(rendered.explanation, option.explanation, `${entry.key}/${option.value}: the choice's own explanation must be in the model`)
      assert(rendered.label, `${entry.key}/${option.value}: choice needs a label`)
    }
  } else {
    assert.equal(field.options, null, `${entry.key}: an open value space must not invent choices`)
  }
}

const userGroupOrder = []
for (const entry of userEntries) {
  const label = entry.group ?? 'Other'
  if (!userGroupOrder.includes(label)) userGroupOrder.push(label)
}
assert.deepEqual(
  emptyDeck.groups.map((group) => group.label),
  [...userGroupOrder, SYSTEM_GROUP_LABEL],
  'Deck settings groups must follow registry order, with the system group last — nothing hand-ordered'
)

// ── 4. System keys are read-only, named and explained ─────────────────────────
const systemGroup = emptyDeck.groups.find((group) => group.label === SYSTEM_GROUP_LABEL)
assert(systemGroup && systemGroup.readOnly, 'the system group must be read-only')
assert.deepEqual(
  systemGroup.fields.map((field) => field.key),
  systemEntries.map((entry) => entry.key),
  'every active system frontmatter key must be shown, not hidden in an unlabelled bucket'
)
for (const field of systemGroup.fields) {
  assert.equal(field.readOnly, true, `${field.key}: system keys are read-only`)
  assert(field.note && field.note.startsWith(SYSTEM_NOTE_PREFIX), `${field.key}: a system key must say it is set by TalkWeaver`)
  const entry = systemEntries.find((candidate) => candidate.key === field.key)
  assert(field.note.includes(entry.deleteConsequence), `${field.key}: the note must name the consequence the registry records`)
}

// ── 5. A value outside the vocabulary is shown as custom, with the way back intact ──
const licence = METADATA_REGISTRY.find((entry) => entry.key === 'license')
const custom = frontmatterFieldViewModel(licence, 'CC BY 4.0 (bespoke)')
assert(custom.custom, 'an off-vocabulary value must be reported as custom')
assert.equal(custom.custom.label, 'custom: CC BY 4.0 (bespoke)')
assert.equal(custom.options.filter((option) => option.selected).length, 0, 'no documented choice may claim an off-vocabulary value')
assert.equal(custom.options.length, licence.vocabulary.options.length, 'every documented choice stays offered, so there is a way back')

const chosen = frontmatterFieldViewModel(licence, 'by-sa')
assert.deepEqual(chosen.options.filter((option) => option.selected).map((option) => option.value), ['by-sa'])
assert.equal(chosen.custom, null, 'a documented value is not custom')

// ── 6. The outline's frontmatter table: nothing unreachable, nothing unexplained ──
const outlinePairs = [
  { key: 'title', value: 'A talk' },
  { key: 'license', value: 'by-nc' },
  { key: 'handout_url', value: 'https://example.pages.dev/t' },
  { key: 'mystery', value: 'hand-authored' }
]
const table = frontmatterSurfaceViewModel(METADATA_REGISTRY, outlinePairs)
assert.deepEqual(table.rows.map((row) => row.key), ['title', 'license', 'handout_url', 'mystery'], 'rows follow document order')
assert.equal(table.rows[1].control, 'select', 'a present closed vocabulary is a picker on the outline surface too')
assert.equal(table.rows[1].explanation, licence.explanation, 'the outline surface carries the registry explanation')
assert.equal(table.rows[2].readOnly, true, 'a system key is read-only on the outline surface')
assert.equal(table.rows[3].unregistered, true, 'an unknown key is marked, not silently typed')

const reachable = new Set([...table.rows.map((row) => row.key), ...table.addable.map((option) => option.key)])
for (const entry of userEntries) {
  assert(reachable.has(entry.key), `${entry.key} must be reachable on the outline frontmatter surface (row or "add field")`)
}
for (const entry of systemEntries) {
  assert(
    !table.addable.some((option) => option.key === entry.key),
    `${entry.key}: TalkWeaver's own key must never be offered as a field to add`
  )
}
assert.deepEqual(
  table.addable.map((option) => option.key),
  userEntries.filter((entry) => entry.key !== 'title' && entry.key !== 'license').map((entry) => entry.key),
  'the add list follows registry order and omits keys already written'
)
for (const option of table.addable) assert(option.explanation, `${option.key}: the add list must explain what it adds`)

// ── 7. Neither component may grow a private field list again ──────────────────
const deckSource = readFileSync(join(root, 'src/renderer/src/components/DeckDesignPanel.tsx'), 'utf8')
const tableSource = readFileSync(join(root, 'src/renderer/src/extensions/frontmatterTable.ts'), 'utf8')

assert.match(deckSource, /deckSettingsViewModel|defaultDeckSettingsViewModel/, 'Deck settings must render from the shared view model')
assert.match(deckSource, /field\.explanation/, 'Deck settings must render each key\'s explanation inline')
assert.match(deckSource, /option\.explanation/, 'Deck settings must render each choice\'s explanation, not only a tooltip')
assert.match(deckSource, /field\.note/, 'Deck settings must show the "set by TalkWeaver" note on system keys')

assert.match(tableSource, /frontmatterSurfaceViewModel/, 'the outline frontmatter table must render from the shared view model')
assert.match(tableSource, /row\.explanation|field\.explanation/, 'the outline frontmatter table must render explanations inline')
assert.match(tableSource, /option\.explanation/, 'the outline frontmatter table must render each choice\'s explanation')
assert.doesNotMatch(tableSource, /const FIELDS\b/, 'the outline frontmatter table must not carry its own field list')
assert.doesNotMatch(tableSource, /FIELD_BY_KEY/, 'the outline frontmatter table must not carry its own label map')
assert.match(tableSource, /editFrontmatterText/, 'the outline frontmatter table must write through the shared byte-preserving editor')
assert.doesNotMatch(tableSource, /function serialize\(/, 'the outline frontmatter table must not re-serialise the block itself — that dropped comments and nested maps')

// ── 8. The write the table performs keeps the bytes it does not own ───────────
// The widget slices the `--- … ---` block out of the document and hands exactly that to the
// shared editor, so prove the slice round-trips: comments and nested map blocks must survive an
// edit to an unrelated key (the old private serialiser deleted both).
const block = ['---', 'title: A talk', '# a hand-written comment', 'defaults:', '  title: side', '  image: left', '---'].join('\n')
const rewritten = editFrontmatterText(block, [{ key: 'palette', value: 'green' }])
assert(rewritten.includes('# a hand-written comment'), 'a comment in the frontmatter block must survive an edit')
assert(rewritten.includes('defaults:\n  title: side\n  image: left'), 'a nested map must survive an edit to another key')
assert(rewritten.includes('palette: green'), 'the edit must land')

for (const source of [deckSource, tableSource]) {
  for (const entry of userEntries) {
    const stray = new RegExp(`label:\\s*['"\`]${entry.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`)
    assert.doesNotMatch(source, stray, `a component re-declares the label for ${entry.key}; labels come from the registry`)
  }
}

console.log(
  `metadata surfaces: ${userEntries.length} user + ${systemEntries.length} system frontmatter keys reach both surfaces; ` +
  `${active.filter((entry) => entry.vocabulary.kind === 'closed').length} closed vocabularies render as pickers with every choice explained`
)
