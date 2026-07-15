export * from '../../../shared/layout-registry/entries'

import type { LayoutDef } from '../../../shared/layout-registry/entries'

export function braceAutocompleteLabel(layout: LayoutDef): string | null {
  const match = layout.trigger.match(/^\{(.+)\}$/)
  return match ? match[1] : null
}
