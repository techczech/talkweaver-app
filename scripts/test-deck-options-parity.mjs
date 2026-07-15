import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DECK_OPTION_GROUPS } from '../src/shared/layout-registry/deck-options.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// These reads are not editable deck options. Keep every exception justified on its own line.
const SYSTEM_DECK_KEYS = new Map([
  // System migration stamp managed by TalkWeaver.
  ['outline_version', 'System migration stamp managed by TalkWeaver.'],
  // Accepted alias for the system migration stamp.
  ['outline-version', 'Accepted alias for the system migration stamp.'],
  // System publishing stamp managed by TalkWeaver.
  ['handout_url', 'System publishing stamp managed by TalkWeaver.'],
  // Local CLI/share-document metadata, not outline frontmatter.
  ['url', 'Local CLI/share-document metadata, not outline frontmatter.'],
  // Map.get on a local variable named meta in the slide ledger.
  ['get', 'Map.get on a local variable named meta in the slide ledger.'],
  // Map.set on a local variable named meta in the slide ledger.
  ['set', 'Map.set on a local variable named meta in the slide ledger.']
])

function compilerMetaReads() {
  const hits = new Set()
  const dirs = [join(root, 'compiler/scripts/lib'), join(root, 'compiler/scripts')]
  const seen = new Set()
  for (const dir of dirs) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.mjs')) continue
      const file = join(dir, name)
      if (seen.has(file)) continue
      seen.add(file)
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/(?<!import\.)\bmeta(?:\?\.)?\.([A-Za-z_$][\w$]*)/g)) hits.add(match[1])
      for (const match of source.matchAll(/\bmeta\[['"]([^'"]+)['"]\]/g)) hits.add(match[1])
    }
  }
  return hits
}

const options = DECK_OPTION_GROUPS.flatMap((group) => group.options)
const declared = new Set(options.flatMap((option) => [option.key, ...(option.aliases ?? [])]))
const duplicateKeys = [...declared].filter((key) => options.filter((option) => [option.key, ...(option.aliases ?? [])].includes(key)).length > 1)
assert.deepEqual(duplicateKeys, [], 'Deck option keys and aliases must be unique')

for (const option of options) {
  assert(option.key && option.label && option.description, `Deck option ${option.key || '(missing key)'} needs key, label and description`)
  assert(['boolean', 'string', 'url', 'number', 'map'].includes(option.input.type), `${option.key}: invalid typed input`)
  if (option.values) {
    assert(option.values.length > 0, `${option.key}: enumerated values cannot be empty`)
    for (const value of option.values) assert(value.label && value.description, `${option.key}/${value.value}: value needs label and description`)
  }
}

const uncovered = [...compilerMetaReads()]
  .filter((key) => !declared.has(key) && !SYSTEM_DECK_KEYS.has(key))
  .sort()
assert.deepEqual(
  uncovered,
  [],
  `Compiler-readable deck option(s) are uncovered: ${uncovered.join(', ')}. Add each to DECK_OPTION_GROUPS or justify it in SYSTEM_DECK_KEYS.`
)

const deckPanelSource = readFileSync(join(root, 'src/renderer/src/components/DeckDesignPanel.tsx'), 'utf8')
assert.match(deckPanelSource, /visibleGroups\.map/, 'Deck settings must render the groups derived from DECK_OPTION_GROUPS')
assert.match(deckPanelSource, /type="search"/, 'Deck settings must remain searchable')
assert.match(deckPanelSource, /editFrontmatterText\(outlineContent, edits\)/, 'Deck settings must use the shared byte-preserving frontmatter editor')
assert.match(deckPanelSource, /unknown\.map/, 'Deck settings must show unknown frontmatter keys read-only in Other')

console.log(`deck options parity: ${options.length} declared options cover ${compilerMetaReads().size} compiler metadata reads`)
