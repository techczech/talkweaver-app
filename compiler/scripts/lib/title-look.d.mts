export const TITLE_LOOKS: string[]
export const TITLE_LOOK_TONES: string[]
export function resolveTitleLook(
  slideAttrs?: Record<string, unknown>,
  sectionDefaults?: Record<string, unknown>,
  deckDefaults?: Record<string, unknown>,
  meta?: Record<string, unknown>
): { look: string; tone: string }
