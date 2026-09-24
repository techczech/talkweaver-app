// Presenter identity and deck defaults gate (Composition Ticket 9b).
//
// Dominik, 2026-09-11: "have options for consistent metadata in settings so I don't have to
// retype my name as author, email etc." This gate holds the two things that can go wrong:
// a default silently replacing something he wrote, and a blank default writing an empty key.
//
// It tests the pure function (`applyMetadataDefaults`) and the Settings view model, plus source
// checks that every surface reaches the store through the one existing settings mechanism.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { METADATA_REGISTRY, defaultableEntries } from '../src/shared/metadata-registry.ts'
import {
  applyMetadataDefaults,
  controlForEntry,
  defaultableSurfaceEntries,
  metadataDefaultsViewModel,
  normaliseMetadataDefaults
} from '../src/shared/metadata-surfaces.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const defaultable = defaultableEntries()
assert(defaultable.length > 0, 'the registry must mark identity/house-style keys as defaultable')

// ── 1. Only identity and house style may be defaultable ───────────────────────
for (const entry of defaultable) {
  assert.equal(entry.ownership, 'user', `${entry.key}: a system key must never carry an app default`)
  assert.equal(entry.location, 'frontmatter', `${entry.key}: only frontmatter keys are defaultable`)
  assert(!entry.since, `${entry.key}: a reserved key must not be defaultable yet`)
  assert.notEqual(entry.type, 'map', `${entry.key}: a structured map cannot be held as one default value`)
}
for (const key of ['title', 'subtitle', 'event', 'date', 'duration', 'warn-at', 'urgent-at', 'handout_url', 'outline_version', 'defaults', 'sections', 'icons']) {
  assert(
    !defaultable.some((entry) => entry.key === key),
    `${key} must NOT be defaultable — it is per-talk content, a map, a system key, or already has its own Settings default`
  )
}
assert.deepEqual(
  defaultableSurfaceEntries(METADATA_REGISTRY).map((entry) => entry.key),
  defaultable.map((entry) => entry.key),
  'the surface filter and the registry helper must agree'
)

// ── 2. The Settings section renders every defaultable key, with Ticket 9's controls ──
const settingsModel = metadataDefaultsViewModel(METADATA_REGISTRY, {})
const settingsFields = settingsModel.flatMap((group) => group.fields)
assert.deepEqual(
  [...settingsFields.map((field) => field.key)].sort(),
  [...defaultable.map((entry) => entry.key)].sort(),
  'Settings shows exactly the defaultable keys — no more, no fewer'
)
// Within a group, fields keep the registry's own order (groups interleave in the registry, so the
// flattened list is group-major; the per-group sequence is what must not be hand-arranged).
for (const group of settingsModel) {
  assert.deepEqual(
    group.fields.map((field) => field.key),
    defaultable.filter((entry) => (entry.group ?? 'Other') === group.label).map((entry) => entry.key),
    `${group.label}: fields keep registry order`
  )
}
for (const entry of defaultable) {
  const field = settingsFields.find((candidate) => candidate.key === entry.key)
  assert.equal(field.control, controlForEntry(entry), `${entry.key}: Settings must use the control the vocabulary demands`)
  assert.equal(field.explanation, entry.explanation, `${entry.key}: Settings must carry the registry explanation`)
  assert.equal(field.readOnly, false, `${entry.key}: a default must be editable`)
  if (entry.vocabulary.kind === 'closed') {
    assert(field.options, `${entry.key}: a closed vocabulary is a picker in Settings too`)
    for (const option of entry.vocabulary.options) {
      const rendered = field.options.find((candidate) => candidate.value === option.value)
      assert.equal(rendered.explanation, option.explanation, `${entry.key}/${option.value}: choices stay explained in Settings`)
    }
  }
}
const groupOrder = []
for (const entry of defaultable) {
  const label = entry.group ?? 'Other'
  if (!groupOrder.includes(label)) groupOrder.push(label)
}
assert.deepEqual(settingsModel.map((group) => group.label), groupOrder, 'Settings groups follow registry order')

// ── 3. fill-missing never touches an authored value ───────────────────────────
const defaults = { author: 'Dominik Lukeš', affiliation: 'University of Oxford', license: 'by-sa', font: 'gill-sans' }
const authored = [
  { key: 'title', value: 'A talk' },
  { key: 'author', value: 'Someone Else' },
  { key: 'license', value: '' }
]
const fill = applyMetadataDefaults(authored, defaults, { mode: 'fill-missing' })
assert.deepEqual(fill.skipped, ['author'], 'an authored value is skipped, and reported as skipped')
assert.deepEqual(
  fill.edits.map((edit) => [edit.key, edit.value]),
  [['affiliation', 'University of Oxford'], ['font', 'gill-sans'], ['license', 'by-sa']],
  'fill-missing writes the absent keys (and a present-but-empty one), in registry order'
)
assert(
  !fill.edits.some((edit) => edit.key === 'author'),
  'fill-missing must never overwrite what the author wrote'
)

// ── 4. overwrite replaces, and only when asked ────────────────────────────────
const over = applyMetadataDefaults(authored, defaults, { mode: 'overwrite' })
assert.deepEqual(over.skipped, [], 'overwrite skips nothing')
assert.deepEqual(
  over.edits.find((edit) => edit.key === 'author'),
  { key: 'author', aliases: [], value: 'Dominik Lukeš' },
  'overwrite replaces the authored value'
)
const one = applyMetadataDefaults(authored, defaults, { mode: 'overwrite', only: ['author'] })
assert.deepEqual(one.edits.map((edit) => edit.key), ['author'], 'a per-field "use default" touches only that field')

// ── 5. A blank default never writes an empty key ──────────────────────────────
const blanks = applyMetadataDefaults([], { author: '', affiliation: '   ', web: undefined }, { mode: 'overwrite' })
assert.deepEqual(blanks.edits, [], 'a blank, whitespace or missing default produces no edit at all')
const noDefaults = applyMetadataDefaults([{ key: 'title', value: 'T' }], {}, { mode: 'fill-missing' })
assert.deepEqual(noDefaults, { edits: [], skipped: [] }, 'no defaults means no edits and nothing skipped')
const unchanged = applyMetadataDefaults([{ key: 'author', value: 'Dominik Lukeš' }], defaults, { mode: 'overwrite' })
assert(
  !unchanged.edits.some((edit) => edit.key === 'author'),
  'a value already equal to the default is not rewritten'
)

// ── 6. The store only ever holds defaultable keys, trimmed ────────────────────
const stored = normaliseMetadataDefaults(METADATA_REGISTRY, {
  author: '  Dominik Lukeš  ',
  license: '',
  title: 'not defaultable',
  handout_url: 'https://example.test',
  nonsense: 'x'
})
assert.deepEqual(stored, { author: 'Dominik Lukeš' }, 'the store keeps trimmed defaultable values only — no blanks, no per-talk or system keys')

// ── 7. One persistence path, one application path ─────────────────────────────
const mainSource = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
const preloadSource = readFileSync(join(root, 'src/preload/index.ts'), 'utf8')
const settingsSource = readFileSync(join(root, 'src/renderer/src/components/SettingsPanel.tsx'), 'utf8')
const deckSource = readFileSync(join(root, 'src/renderer/src/components/DeckDesignPanel.tsx'), 'utf8')
const tableSource = readFileSync(join(root, 'src/renderer/src/extensions/frontmatterTable.ts'), 'utf8')

assert.match(mainSource, /metadataDefaults\?: MetadataDefaults/, 'the defaults live in the existing config.json Config type — not a second store')
assert.match(mainSource, /settings:get-metadata-defaults/, 'the defaults are read through the existing settings IPC')
assert.match(mainSource, /settings:set-metadata-defaults/, 'the defaults are written through the existing settings IPC')
assert.match(mainSource, /applyMetadataDefaults/, 'new-talk creation pre-fills through the one shared function')
assert.match(preloadSource, /getMetadataDefaults/, 'the preload exposes the defaults on the existing settings API')
assert.match(settingsSource, /metadataDefaultsViewModel/, 'the Settings section renders from the registry-derived model')
assert.match(settingsSource, /Presenter identity and deck defaults/, 'the Settings section is named')
assert.match(deckSource, /applyMetadataDefaults/, 'Deck settings fills from defaults through the one shared function')
assert.match(deckSource, /Fill missing from defaults/, 'Deck settings offers the panel-level fill action')
assert.match(deckSource, /Use default/, 'Deck settings offers a per-field "Use default"')
assert.match(deckSource, /placeholder=\{[^}]*defaultFor|appDefault/, 'Deck settings shows the app default as placeholder text')
assert.match(tableSource, /placeholder/, 'the frontmatter editor shows the app default as placeholder text')

for (const source of [settingsSource, deckSource, tableSource]) {
  assert.doesNotMatch(source, /localStorage\.setItem\(\s*['"`]tw\.metadataDefaults/, 'the defaults must not gain a second persistence path')
}

console.log(
  `metadata defaults: ${defaultable.length} identity/house-style keys offered in Settings; ` +
  'fill-missing preserves authored values, overwrite is explicit, blanks never write'
)
