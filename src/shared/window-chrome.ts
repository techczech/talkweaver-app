// Electron's hiddenInset defaults to (12, 11) on macOS. Set it explicitly so the host
// can report it through getWindowButtonPosition and the renderer has a first-paint
// fallback while Electron's Window Controls Overlay geometry is still unavailable.
const trafficLightPosition = { x: 12, y: 11 }

export function insetWindowOptions(platform: string) {
  return platform === 'darwin'
    ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition, titleBarOverlay: true }
    : {}
}

export const macWindowChromeFallback = {
  // A conservative button-row footprint in CSS pixels. The overlay can grow it at
  // runtime. Keep it in fullscreen too, where AppKit can reveal buttons on hover.
  inline: 2 * trafficLightPosition.x + 60,
  block: 2 * trafficLightPosition.y + 16
}
