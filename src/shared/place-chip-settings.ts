/**
 * The setting "Show where I am in the status bar" (onboarding 0.38.1 ticket 02): the place chip.
 *
 * One app-wide value in the app-level JSON config (`src/main/index.ts` → `userData/config.json`),
 * ON by default, broadcast to every window on change, as the action bar's visibility is
 * (action-bar-settings.ts). Its name lives here so main, preload and renderer cannot drift apart.
 */

/** The config.json key holding the chip's visibility. */
export const PLACE_CHIP_VISIBLE_KEY = 'placeChipVisible'

/** On until switched off. */
export const PLACE_CHIP_VISIBLE_DEFAULT = true

/** Anything that is not a boolean means "never set" → the default. */
export function placeChipVisibleFrom(stored: unknown): boolean {
  return typeof stored === 'boolean' ? stored : PLACE_CHIP_VISIBLE_DEFAULT
}
