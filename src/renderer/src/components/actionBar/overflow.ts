/** Keep the longest leading run of buttons that fits; reserve the overflow trigger only when needed. */
export type OverflowInput = {
  available: number
  /** Cumulative right edges for each button, including section separator and flex gaps. */
  prefixWidths: readonly number[]
  overflowChunk: number
  tailChunk: number
}
export type OverflowPlan = { visible: number; overflowing: number }

export function widthNeeded(input: OverflowInput, visible: number): number {
  const prefix = visible === 0 ? 0 : (input.prefixWidths[visible - 1] ?? 0)
  return prefix + (visible < input.prefixWidths.length ? input.overflowChunk : 0) + input.tailChunk
}

export function planButtonOverflow(input: OverflowInput): OverflowPlan {
  const total = input.prefixWidths.length
  if (total === 0) return { visible: 0, overflowing: 0 }
  if (input.available <= 0) return { visible: total, overflowing: 0 }
  for (let visible = total; visible >= 0; visible--) {
    if (widthNeeded(input, visible) <= input.available) return { visible, overflowing: total - visible }
  }
  return { visible: 0, overflowing: total }
}
