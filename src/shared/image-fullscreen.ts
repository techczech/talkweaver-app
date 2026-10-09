// Full-screen presenting (Z) shows an image at its own size, never enlarged, inside a 16:9 screen
// (compiler/scripts/lib/09-output-builders.mjs `.venue-screen .lightbox-img`: max 100vw x 100dvh,
// width/height auto). So an image smaller than the screen along the axis that limits it is shown
// small and soft. Pure.
export const FULL_SCREEN = { width: 1920, height: 1080 } as const

export interface FullScreenFit {
  /** The axis the screen constrains: a wide image is limited by width, a tall one by height. */
  axis: 'width' | 'height'
  /** Pixels the image needs along that axis to fill it at 1:1. */
  needed: number
  lowResolution: boolean
}

export function fullScreenFit(width: number, height: number): FullScreenFit | null {
  if (!(width > 0) || !(height > 0)) return null
  const wide = width / height >= FULL_SCREEN.width / FULL_SCREEN.height
  const axis = wide ? 'width' : 'height'
  const needed = wide ? FULL_SCREEN.width : FULL_SCREEN.height
  return { axis, needed, lowResolution: (wide ? width : height) < needed }
}

/** The quiet note under the overlay's size line, or null when the image is large enough. */
export function lowResolutionNote(width: number, height: number): string | null {
  return fullScreenFit(width, height)?.lowResolution ? `Low resolution for full screen (${width}×${height})` : null
}
