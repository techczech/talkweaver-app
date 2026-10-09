import { FULL_SCREEN, lowResolutionNote } from '../../../shared/image-fullscreen.ts'

// The editor's "see it as Z shows it" overlay. Z (full-screen image presenting) draws the image
// on a #080c12 screen at its own size, never enlarged, capped to the screen and letterboxed
// (compiler/scripts/lib/09-output-builders.mjs `.venue-screen .lightbox*`:
// background #080c12, .lightbox-img { max-width: 100vw; max-height: 100dvh; width/height: auto;
// object-fit: contain }). Here the 16:9 screen fills the window and 1920 CSS px of screen width =
// the stage width, so a small image shows small exactly as it would on a 1920x1080 display.

const SCREEN_BG = '#080c12'

export interface FullScreenPreviewOpts {
  url: string
  caption: string
  /** Offered only for vault images: opens the image's metadata panel. */
  onDetails?: (() => void) | null
}

let openOverlay: HTMLElement | null = null

export function closeFullScreenPreview(): void {
  if (!openOverlay) return
  openOverlay.dispatchEvent(new Event('tw-close'))
}

export function openFullScreenPreview(opts: FullScreenPreviewOpts): void {
  closeFullScreenPreview()
  const overlay = document.createElement('div')
  overlay.className = 'tw-image-fullscreen'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', 'Image as shown full screen')
  overlay.style.cssText = [
    'position: fixed', 'inset: 0', 'z-index: 10000', `background: ${SCREEN_BG}`,
    'display: flex', 'align-items: center', 'justify-content: center', 'cursor: zoom-out'
  ].join('; ')

  // The 16:9 screen: as large as fits in the window.
  const stage = document.createElement('div')
  stage.className = 'tw-image-fullscreen-stage'
  stage.style.cssText = [
    `aspect-ratio: ${FULL_SCREEN.width} / ${FULL_SCREEN.height}`,
    `width: min(100vw, calc(100vh * ${FULL_SCREEN.width} / ${FULL_SCREEN.height}))`,
    'container-type: size', 'display: grid', 'place-items: center', 'overflow: hidden'
  ].join('; ')

  const img = document.createElement('img')
  img.alt = opts.caption
  img.style.cssText = ['max-width: 100%', 'max-height: 100%', 'height: auto', 'object-fit: contain', 'display: block'].join('; ')

  const info = document.createElement('div')
  info.style.cssText = [
    'position: absolute', 'right: 14px', 'bottom: 12px', 'text-align: right', 'font: 12px/1.5 var(--font-ui, system-ui, sans-serif)',
    'color: rgba(255,255,255,.72)', 'pointer-events: none'
  ].join('; ')
  const size = document.createElement('div')
  size.className = 'tw-image-fullscreen-size'
  const note = document.createElement('div')
  note.className = 'tw-image-fullscreen-note'
  note.style.cssText = 'color: rgba(255,255,255,.5)'
  info.append(size, note)

  img.addEventListener('load', () => {
    const w = img.naturalWidth
    const h = img.naturalHeight
    if (!w || !h) return
    // Z never enlarges: 1 image px = 1 screen px, and the stage is the 1920-px-wide screen.
    img.style.width = `calc(${w} * 100cqw / ${FULL_SCREEN.width})`
    size.textContent = `${w} × ${h} px`
    note.textContent = lowResolutionNote(w, h) ?? ''
  })
  img.addEventListener('error', () => { size.textContent = 'Image could not be loaded' })
  img.src = opts.url

  stage.appendChild(img)
  overlay.append(stage, info)

  if (opts.onDetails) {
    const details = document.createElement('button')
    details.type = 'button'
    details.textContent = 'Image details'
    details.style.cssText = [
      'position: absolute', 'left: 14px', 'bottom: 12px', 'font: 12px var(--font-ui, system-ui, sans-serif)',
      'color: rgba(255,255,255,.8)', 'background: rgba(255,255,255,.1)', 'border: 0', 'border-radius: 6px', 'padding: 4px 10px', 'cursor: pointer'
    ].join('; ')
    const onDetails = opts.onDetails
    details.addEventListener('click', (event) => { event.stopPropagation(); close(); onDetails() })
    overlay.appendChild(details)
  }

  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    close()
  }
  function close(): void {
    window.removeEventListener('keydown', onKey, true)
    overlay.remove()
    if (openOverlay === overlay) openOverlay = null
  }
  overlay.addEventListener('tw-close', close)
  overlay.addEventListener('click', close)
  window.addEventListener('keydown', onKey, true)
  document.body.appendChild(overlay)
  openOverlay = overlay
}
