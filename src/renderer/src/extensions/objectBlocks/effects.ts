import { Annotation, StateEffect } from '@codemirror/state'

/** A write whose result must be exactly the text given: a disk version adopted, a save's stamped text
 *  adopted, a planned whole-text rewrite put in as a minimal change, and an object's own planned write
 *  (its Delete, its card actions, deleting a comment). The object source guard (field.ts) leaves these
 *  alone: the buffer has to equal that text byte for byte. */
export const exactTextWrite = Annotation.define<boolean>()

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
