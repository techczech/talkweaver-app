export const TITLE_LOOKS: string[]
export const TITLE_LOOK_TONES: string[]
export function resolveTitleLook(
  slideAttrs?: Record<string, unknown>,
  sectionDefaults?: Record<string, unknown>,
  deckDefaults?: Record<string, unknown>,
  meta?: Record<string, unknown>
): { look: string; tone: string }
export const TAB_STRIP_MAX_PILLS: number
export function sectionStrip(
  slides: Array<{ section?: string; role?: string; layout?: string; title?: string; navTitle?: string; runExtra?: boolean }>,
  index: number,
  max?: number
): { titles: string[]; plain?: boolean[]; current: number; cutBefore: boolean; cutAfter: boolean }
