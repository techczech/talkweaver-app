export type FrameIcons = 'off' | 'top' | 'all'
export interface FrameDescriptor {
  title: string
  section: string
  image: string
  align: string
  icons: FrameIcons
}
export const FRAME_BUILTINS: FrameDescriptor
export function plainListForcedIcons(frameIcons: string): boolean
export function resolveSlideFrame(
  slideAttrs?: Record<string, unknown>,
  sectionDefaults?: Record<string, unknown>,
  deckDefaults?: Record<string, unknown>
): FrameDescriptor
