import { LAYOUTS, type LayoutCategory } from './layout-registry/entries.ts'

export interface ImportLayoutChoice {
  value: string
  label: string
  trigger: string
  category: LayoutCategory | null
}

export const IMPORT_LAYOUT_CATEGORY_LABELS: Record<LayoutCategory, string> = {
  everyday: 'Everyday',
  structural: 'Structural',
  specialised: 'Specialised',
  diagrams: 'Diagrams',
  modes: 'Modes'
}

export const IMPORT_LAYOUT_CATEGORIES = Object.keys(IMPORT_LAYOUT_CATEGORY_LABELS) as LayoutCategory[]

export const IMPORT_LAYOUT_CHOICES: ImportLayoutChoice[] = [
  { value: 'auto', label: 'Auto', trigger: '', category: null },
  ...LAYOUTS
    .filter((entry) => entry.kind === 'layout')
    .map((entry) => ({
      value: entry.name,
      label: entry.label,
      trigger: entry.trigger,
      category: entry.category
    }))
]

const choiceByValue = new Map(IMPORT_LAYOUT_CHOICES.map((choice) => [choice.value, choice]))

// Retired layout names that saved import runs may still carry; map each to its current trigger token.
const RETIRED_IMPORT_LAYOUTS: Record<string, string> = { 'contrast-cards': 'contrast=cards' }

export function isImportLayout(value: string): boolean {
  return choiceByValue.has(value)
}

export function importLayoutTrigger(value: string): string {
  const current = choiceByValue.get(value)
  if (current) return current.trigger
  const retired = RETIRED_IMPORT_LAYOUTS[value]
  if (retired) return `{${retired}}`
  const token = value.trim().replace(/^\{/, '').replace(/\}$/, '')
  return token ? `{${token}}` : ''
}
