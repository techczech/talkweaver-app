import { METADATA_REGISTRY, type MetadataEntry } from '../metadata-registry.ts'

export type DeckInputType = 'boolean' | 'string' | 'url' | 'number' | 'map'

export interface DeckOptionValue {
  value: string
  label: string
  description: string
  swatch?: string
}

export interface DeckOption {
  key: string
  aliases?: string[]
  label: string
  description: string
  input: { type: DeckInputType; unit?: string; placeholder?: string }
  values?: DeckOptionValue[]
}

export interface DeckOptionGroup {
  key: string
  label: string
  options: DeckOption[]
}

const INPUT_OVERRIDES: Record<string, DeckOption['input']> = {
  duration: { type: 'string', unit: 'seconds, minutes or m:ss', placeholder: '60min' },
  'warn-at': { type: 'number', unit: 'minutes left' },
  'urgent-at': { type: 'number', unit: 'minutes left' },
  web: { type: 'url', placeholder: 'https://…' },
  'license-url': { type: 'url', placeholder: 'https://…' }
}

const SWATCHES: Record<string, string> = {
  green: '#166534'
}

function optionFromMetadata(entry: MetadataEntry): DeckOption {
  const input = INPUT_OVERRIDES[entry.key] ?? {
    type: entry.type === 'text' ? 'string' : entry.type
  }
  return {
    key: entry.key,
    aliases: entry.aliases,
    label: entry.label,
    description: entry.explanation,
    input,
    values: entry.vocabulary.kind === 'closed'
      ? entry.vocabulary.options.map((value) => ({
          value: value.value,
          label: value.label,
          description: value.explanation,
          swatch: entry.key === 'palette' ? SWATCHES[value.value] : undefined
        }))
      : undefined
  }
}

const editableCompilerOptions = METADATA_REGISTRY.filter((entry) =>
  entry.location === 'frontmatter' && entry.ownership === 'user' && !entry.since
)

const order: string[] = []
const grouped = new Map<string, DeckOption[]>()
for (const entry of editableCompilerOptions) {
  const label = entry.group ?? 'Other'
  if (!grouped.has(label)) {
    grouped.set(label, [])
    order.push(label)
  }
  grouped.get(label)!.push(optionFromMetadata(entry))
}

/** Every user-editable frontmatter option the compiler reads, grouped for Deck settings. */
export const DECK_OPTION_GROUPS: DeckOptionGroup[] = order.map((label) => ({
  key: label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
  label,
  options: grouped.get(label) as DeckOption[]
}))

export const DECK_OPTION_KEYS = new Set(
  DECK_OPTION_GROUPS.flatMap((group) => group.options.flatMap((option) => [option.key, ...(option.aliases ?? [])]))
)
