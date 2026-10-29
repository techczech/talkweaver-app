export type LivePageCapture = {
  id: string
  image: string
  capturedAt: string
  currentUrl?: string
  slideId: string
  width: number
  height: number
  bytes: number
  source: 'audience' | 'presenter' | 'window'
  viewport: { w: number; h: number; zoom: number }
  scroll: { fx: number; fy: number }
  mode?: 'page'
  truncated?: true
  slideMarkup?: true
}
export type LivePageCaptureEntry = { pageUrl: string; capture: LivePageCapture }
export type LivePageGallery = { pages: Record<string, LivePageCapture[]>; total: number }

export const LIVE_PAGE_CAPTURES_DIR: string
export const LIVE_PAGE_CAPTURES_VERSION: 1
export const MAX_CAPTURES_PER_PAGE: number
export const MAX_CAPTURES_TOTAL: number
export const MAX_CAPTURE_ENTRY_BYTES: number
export const MAX_CAPTURE_IMAGE_BYTES: number
export const MAX_CAPTURE_URL_LENGTH: number
export const MAX_CAPTURE_HEIGHT: number
export const MAX_CAPTURE_WIDTH: number
export const PUBLIC_CAPTURE_FIELDS: readonly string[]
export function captureImageName(sha256Hex: string): string
export function captureImagePath(sha256Hex: string): string
export function isCaptureImageName(value: unknown): value is string
export function isCaptureImagePath(value: unknown): value is string
export function captureEntryName(capture: { id: string; capturedAt: string }): string
export function isCaptureEntryName(value: unknown): value is string
export function normaliseCaptureUrl(raw: unknown): string | null
export function validateCapture(raw: unknown): LivePageCapture | null
export function encodeCaptureEntry(pageUrl: string, capture: LivePageCapture): string
export function parseCaptureEntry(text: unknown, name: unknown): LivePageCaptureEntry | null
export function galleryFromEntries(entries: Array<(LivePageCaptureEntry & { name: string }) | null>): LivePageGallery
export function earlierCapturesFor(gallery: LivePageGallery | null, pageUrl: string): Array<{ image: string; capturedAt: string; mode?: 'page' }>
export function publicCapturesFor(gallery: LivePageGallery | null, pageUrl: string): Array<{ image: string; capturedAt: string; mode?: 'page' }>
