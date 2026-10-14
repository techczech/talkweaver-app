/**
 * The Plain tab's font and text size (plain editing view, spec T13).
 *
 * Two per-user settings in the main-process config, applied to the Plain tab only. Names, the font
 * stacks, the size range and tolerant reading live here so the main process, the preload bridge,
 * the Settings rows and the editor cannot drift.
 */
export type PlainFont = 'sans' | 'serif'

export interface PlainLook {
  font: PlainFont
  size: number
}

/** The config.json keys. */
export const PLAIN_FONT_KEY = 'plainViewFont'
export const PLAIN_TEXT_SIZE_KEY = 'plainViewTextSize'

export const PLAIN_FONT_DEFAULT: PlainFont = 'sans'
export const PLAIN_TEXT_SIZE_DEFAULT = 16
export const PLAIN_TEXT_SIZE_MIN = 13
export const PLAIN_TEXT_SIZE_MAX = 22

/** The choices in the order Settings shows them. No font file is bundled: both are system stacks. */
export const PLAIN_FONTS: ReadonlyArray<{ id: PlainFont; label: string; stack: string }> = [
  { id: 'sans', label: 'Sans', stack: "-apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif" },
  { id: 'serif', label: 'Serif', stack: "Charter, 'Iowan Old Style', Georgia, serif" }
]

export const PLAIN_LOOK_DEFAULT: PlainLook = { font: PLAIN_FONT_DEFAULT, size: PLAIN_TEXT_SIZE_DEFAULT }

/** Anything but a known font name reads as the default. */
export function plainFontFrom(stored: unknown): PlainFont {
  return stored === 'sans' || stored === 'serif' ? stored : PLAIN_FONT_DEFAULT
}

/** A whole number in range, else the default (out-of-range and unreadable values are not clamped). */
export function plainTextSizeFrom(stored: unknown): number {
  return typeof stored === 'number' && Number.isInteger(stored) && stored >= PLAIN_TEXT_SIZE_MIN && stored <= PLAIN_TEXT_SIZE_MAX
    ? stored
    : PLAIN_TEXT_SIZE_DEFAULT
}

/** One step of the +/- buttons, held inside the range. */
export function stepPlainTextSize(size: number, delta: 1 | -1): number {
  return Math.min(PLAIN_TEXT_SIZE_MAX, Math.max(PLAIN_TEXT_SIZE_MIN, plainTextSizeFrom(size) + delta))
}

export function plainFontStack(font: PlainFont): string {
  return (PLAIN_FONTS.find((f) => f.id === font) ?? PLAIN_FONTS[0]).stack
}

export function plainLookFrom(config: Record<string, unknown>): PlainLook {
  return { font: plainFontFrom(config[PLAIN_FONT_KEY]), size: plainTextSizeFrom(config[PLAIN_TEXT_SIZE_KEY]) }
}
