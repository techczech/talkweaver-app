// The status-bar place chip (onboarding 0.38.1 ticket 02): "On a slide heading · 14 actions ⌘K".
// Pure: the bar's width, the place, the count and the setting in; what the chip shows out.
//
// ABSORPTION. The status bar sits under the editor column, whose width follows the panes. The bar's
// own items clip at its right edge (`overflow: hidden`), and the chip is the first item, so it is
// the chip that gives way, in two steps, before it can push the version and counts out of sight:
//   - from FULL_FROM_PX: the place, the count and the key ("On a slide heading · 14 actions ⌘K");
//   - from PLACE_ONLY_FROM_PX: the place and the key, count dropped ("On a slide heading ⌘K");
//   - narrower: absorbed, the chip is not drawn.
// The full text is the chip's title (hover) at every width it is drawn.
//
// PRESENCE. Drawn while the setting "Show where I am in the status bar" is on (the default). In the
// version-only bar (no talk open) it is drawn only for a Talks-panel place (on a talk, on a vault):
// with no talk open there is no outline to be in.
import { actionCountText, placeLabel, type Place } from '../../../shared/place.ts'

export const FULL_FROM_PX = 640
export const PLACE_ONLY_FROM_PX = 440

export type PlaceChipLayout = 'full' | 'place-only' | 'absorbed'

export interface PlaceChipInput {
  place: Place
  count: number
  /** The chord the chip shows, the effective ⌘K. */
  chord: string
  /** The setting "Show where I am in the status bar". */
  visible: boolean
  /** The version-only bar shown with no talk open. */
  minimal: boolean
  /** The status bar's width in px; null before the first measure (treated as wide). */
  barWidth: number | null
}

export interface PlaceChipView {
  show: boolean
  layout: PlaceChipLayout
  /** The words drawn before the key: "On a slide heading · 14 actions" or "On a slide heading". */
  text: string
  chord: string
  /** The hover title: always the full text, with the key. */
  title: string
}

export function placeChipLayout(barWidth: number | null): PlaceChipLayout {
  if (barWidth === null || barWidth >= FULL_FROM_PX) return 'full'
  if (barWidth >= PLACE_ONLY_FROM_PX) return 'place-only'
  return 'absorbed'
}

const PANEL_PLACES: ReadonlySet<Place> = new Set<Place>(['talk', 'vault'])

export function placeChipView(input: PlaceChipInput): PlaceChipView {
  const label = placeLabel(input.place)
  const full = `${label} · ${actionCountText(input.count)}`
  const layout = placeChipLayout(input.barWidth)
  const present = input.visible && (!input.minimal || PANEL_PLACES.has(input.place))
  return {
    show: present && layout !== 'absorbed',
    layout,
    text: layout === 'full' ? full : label,
    chord: input.chord,
    title: `${full} — ${input.chord} lists them`
  }
}
