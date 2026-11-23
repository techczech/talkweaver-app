export const FIXED_DECK_WIDTH = 1280
export const FIXED_DECK_HEIGHT = 720

/** Sandbox of the Slide Focus and Inspector deck frame. No allow-top-navigation (the editor window
 *  holds window.tw), no allow-modals, no allow-downloads. allow-same-origin is safe because the
 *  frame's twpresent: origin is never the editor's; without it the deck's storage throws and
 *  embedded videos and sites, which inherit these limits, lose their own origin. */
export const FIXED_DECK_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-presentation'

export function fixedDeckScale(stageWidth: number): number {
  return Math.max(0, stageWidth) / FIXED_DECK_WIDTH
}
