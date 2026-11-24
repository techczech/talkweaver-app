import { listSlideBlocks } from '../../compiler/scripts/lib/slide-blocks.mjs'

/** IDs previously assigned to the headings of the submitted text, in structural order. */
export interface OutlineSaveIdentity {
  ids: (string | null)[]
  replay: boolean
}

export const MAX_OUTLINE_SAVE_IDS = 10_000
export const MAX_OUTLINE_SAVE_ID_LENGTH = 256

export function parseOutlineSaveIdentity(value: unknown): OutlineSaveIdentity | undefined {
  if (!value || typeof value !== 'object' || !('ids' in value) || !('replay' in value)) return
  const { ids, replay } = value
  if (typeof replay !== 'boolean' || !Array.isArray(ids) || ids.length > MAX_OUTLINE_SAVE_IDS) return
  if (!ids.every(id => id === null || (
    typeof id === 'string' && id.length <= MAX_OUTLINE_SAVE_ID_LENGTH && /^[A-Za-z0-9_-]+$/.test(id)
  ))) return
  return { ids, replay }
}

/** Resolve an operation's exact old line positions into the previous indices of its new headings. */
export function headingOrderFromLineOrder(before: string, after: string, sourceLines: readonly number[]): number[] {
  const beforeByLine = new Map(listSlideBlocks(before).map(({ start }, index) => [start, index]))
  const order = listSlideBlocks(after).map(({ start }) => beforeByLine.get(sourceLines[start]))
  if (order.length !== beforeByLine.size || new Set(order).size !== beforeByLine.size || order.includes(undefined)) return []
  return order as number[]
}
