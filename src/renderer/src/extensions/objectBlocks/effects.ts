import { StateEffect } from '@codemirror/state'

export const setOpenObjectBlock = StateEffect.define<{ from: number; to: number } | null>({
  map(value, mapping) {
    return value
      ? {
        from: mapping.mapPos(value.from, -1),
        to: mapping.mapPos(value.to, 1)
      }
      : null
  }
})

export const setRawObjectBlock = StateEffect.define<{ from: number; raw: boolean }>({
  map(value, mapping) {
    return { ...value, from: mapping.mapPos(value.from, -1) }
  }
})

/** Expanded/collapsed is session chrome (ADR-0042): never written to the outline. */
export const setExpandedObjectBlock = StateEffect.define<{ from: number; expanded: boolean }>({
  map(value, mapping) {
    return { ...value, from: mapping.mapPos(value.from, -1) }
  }
})
