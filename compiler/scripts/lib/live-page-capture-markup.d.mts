export type CaptureLine = { alt: string; src: string; savedView: boolean }
export type SlideCaptureMarkup = {
  pages: Array<{ pageUrl: string; line: number; managed: boolean; marker: number | null; captures: Array<CaptureLine & { line: number }> }>
  orphans: Array<{ src: string; line: number }>
}
export const CAPTURE_TOKEN_RE: RegExp
export function hasCaptureToken(tokens: unknown): boolean
export function readCaptureLine(line: unknown): CaptureLine | null
export function embedLinePageUrl(line: unknown): string | null
export function captureLineAlt(capturedAt: string, mode?: 'view' | 'page'): string
export function captureMarkupLine(image: string, capturedAt: string, mode?: 'view' | 'page'): string
export function slideCaptureMarkup(lines: string[]): SlideCaptureMarkup
export type CaptureSlideRef = string | { id: string; heading?: string }
export function slideHeadingRef(text: string, sourceLine: number): { heading: string } | null
export function placeCaptureLines(text: string, slide: CaptureSlideRef, pageUrl: string, line: string, earlier?: string[]): { text: string; onSlide: boolean; reason?: 'capture-slide-missing' | 'capture-slide-ambiguous' | 'capture-embed-missing' }
export function withCaptureLine(text: string, slide: CaptureSlideRef, pageUrl: string, line: string): string
export function captureMarkupOfSlideText(slideText: string | null | undefined): SlideCaptureMarkup
export const CAPTURE_VIEWS_MARKER: string
export function isCaptureViewsMarker(line: string): boolean
export function blankHtmlCommentsKeepingCaptureMarkers(text: string): string
export function removeCaptureLine(text: string, slide: string | { id: string; heading?: string; line?: number }, pageUrl: string, image: string, embed?: { index: number; of: number }): { text: string; removed: boolean; reason?: 'capture-slide-missing' | 'capture-slide-ambiguous' | 'capture-slide-moved' | 'capture-embed-missing' | 'capture-embed-ambiguous' | 'capture-view-missing' }
export function slideSavedViewLines(text: string, slide: CaptureSlideRef, pageUrl: string): { managed: boolean; views: Array<{ image: string; alt: string }>; reason?: undefined } | { reason: 'capture-slide-missing' | 'capture-slide-ambiguous' | 'capture-embed-missing'; managed?: undefined; views?: undefined }
