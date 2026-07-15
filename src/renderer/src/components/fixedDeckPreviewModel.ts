export const FIXED_DECK_WIDTH = 1280
export const FIXED_DECK_HEIGHT = 720

export function fixedDeckScale(stageWidth: number): number {
  return Math.max(0, stageWidth) / FIXED_DECK_WIDTH
}
