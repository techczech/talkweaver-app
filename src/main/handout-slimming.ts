// Slimming a published handout so each file stays under Cloudflare Pages' 25 MiB per-file limit
// (spec docs/plans/cloudflare-setup-in-app, D11). It works on the page's text in memory only: the
// talk, its pictures and the handout saved on this computer are never touched.
//
// Pictures are re-encoded with `sharp`, which ships with the app on every platform. Earlier versions
// called two programs found on the machine, `cwebp` and `sips`; where they were missing (always, on
// Windows) the page was returned unchanged and a heavy handout was then refused by Cloudflare. Both
// calls are gone. scripts/test-handout-slimming.mjs pins the sizes that path produced on macOS for
// four pictures and shows this one gives the same size or smaller for each, at every quality step.
//
// What it does, in order, stopping as soon as the page fits:
//   1. videos inlined at more than 8 MB become a "plays in the live presentation" note;
//   2. every inlined picture over 120 KB (png, jpeg, webp) is re-encoded as WebP, first near-lossless,
//      then at three falling qualities and sizes. Each step starts again from the ORIGINAL pictures,
//      so quality is never lost twice. A picture that would come out no smaller is left as it was;
//   3. only if the lowest step still does not fit, smaller and smaller videos become the note.
// Most talks fit at the first step and keep every video. A picture `sharp` cannot read is left as it
// was: slimming never fails a publish.
//
// No Electron import and erasable TypeScript only: scripts/test-handout-slimming.mjs imports this
// file as it is. `sharp` is loaded when the first picture needs it, so a test of the video rules
// (and a page with nothing to slim) never loads the native module.

/** About 1 MiB under Cloudflare Pages' 25 MiB per-file limit. */
export const SLIM_TARGET_BYTES = 24 * 1024 * 1024
/** Pictures smaller than this are left alone. */
export const SLIM_MIN_IMAGE_BYTES = 120 * 1024

export type ImageStep = { nearLossless: boolean; quality: number; maxDimension: number }

/** The quality steps, best first. The first is what almost every talk stops at. */
export const IMAGE_STEPS: readonly ImageStep[] = [
  { nearLossless: true, quality: 60, maxDimension: 2400 },
  { nearLossless: false, quality: 84, maxDimension: 2000 },
  { nearLossless: false, quality: 80, maxDimension: 1700 },
  { nearLossless: false, quality: 74, maxDimension: 1500 },
]

/**
 * A picture that is NOT scaled is encoded by the same WebP encoder with the same settings as before,
 * and comes out byte for byte the same size. A picture that IS scaled went through cwebp's own
 * scaler before; sharp's default scaler keeps more fine detail, which costs up to 12% more bytes. So
 * scaling uses the softer `linear` kernel, and a scaled picture at a lossy step is encoded two
 * points lower. With both, every step's total over the test's four pictures is smaller than before.
 */
export const SCALING_KERNEL = 'linear'
export const SCALED_QUALITY_DROP = 2

export const VIDEO_PLACEHOLDER =
  '<figure class="slide-figure slide-video video-placeholder"><div class="video-placeholder-note"><span class="vp-glyph" aria-hidden="true">▶</span><span>Video plays in the live presentation</span></div></figure>'

/** Every inlined video larger than `limit` bytes becomes the note. */
export function stripVideos(html: string, limit: number): string {
  return html.replace(/<figure class="slide-figure slide-video"[^>]*>[\s\S]*?<\/figure>/g, (figure) => {
    if (/video-placeholder/.test(figure)) return figure
    if (/\sdata-lazy-src="/.test(figure)) return figure // published beside the page (handout-lazy-assets.mjs): not inline
    const data = figure.match(/src="data:video\/[^;]+;base64,([A-Za-z0-9+/=]+)"/)
    const bytes = data ? Math.floor(data[1].length * 0.75) : Infinity
    if (bytes <= limit) return figure
    // A {play-on-next} video stays a step of its slide (0.38 ticket 05): the placeholder keeps the
    // mark, so the venue screen counts the slide's steps as the projector does. It has nothing to play.
    return /^<figure class="slide-figure slide-video" data-play-on-next[\s>]/.test(figure)
      ? VIDEO_PLACEHOLDER.replace('<figure class="slide-figure slide-video video-placeholder"', '<figure class="slide-figure slide-video video-placeholder" data-play-on-next')
      : VIDEO_PLACEHOLDER
  })
}

type Sharp = typeof import('sharp').default // sharp 0.35 types the module's named exports; the callable is `default`
let loaded: Promise<Sharp> | null = null
function loadSharp(): Promise<Sharp> {
  loaded ??= import('sharp').then((module) => (module as unknown as { default: Sharp }).default ?? (module as unknown as Sharp))
  return loaded
}

/**
 * One picture, re-encoded as WebP at one quality step: the new bytes, or null when the picture
 * cannot be read or would not come out smaller. The picture is scaled down only when its longer
 * side is over the step's limit; it is never turned or enlarged, and a picture with several frames
 * keeps them.
 */
export async function slimImage(bytes: Buffer, step: ImageStep): Promise<Buffer | null> {
  try {
    const sharp = await loadSharp()
    // `animated`: every frame of a moving picture is kept. `failOn: 'none'`: a slightly damaged file is still read.
    const image = sharp(bytes, { animated: true, failOn: 'none' })
    const { width = 0, height = 0, pageHeight } = await image.metadata()
    const tall = pageHeight ?? height // a moving picture's `height` is all its frames stacked
    const scaled = Math.max(width, tall) > step.maxDimension
    const resized = scaled
      ? image.resize({ ...(width >= tall ? { width: step.maxDimension } : { height: step.maxDimension }), kernel: SCALING_KERNEL })
      : image
    const quality = scaled && !step.nearLossless ? step.quality - SCALED_QUALITY_DROP : step.quality
    const out = await resized
      .webp(step.nearLossless ? { nearLossless: true, quality, effort: 4 } : { quality, effort: 4 })
      .toBuffer()
    return out.length < bytes.length ? out : null // never grow a file
  } catch {
    return null
  }
}

const INLINE_IMAGE = /data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)/g

/** Re-encode every inlined picture over the minimum size at one step. Pictures are done one at a time: a page can hold hundreds. */
export async function compressImages(html: string, step: ImageStep): Promise<string> {
  const parts: string[] = []
  let from = 0
  const done = new Map<string, string>() // the same picture inlined twice is encoded once
  for (const match of html.matchAll(INLINE_IMAGE)) {
    const base64 = match[2]
    if (Buffer.byteLength(base64, 'base64') < SLIM_MIN_IMAGE_BYTES) continue
    let replacement = done.get(match[0])
    if (replacement === undefined) {
      const slimmed = await slimImage(Buffer.from(base64, 'base64'), step)
      replacement = slimmed ? `data:image/webp;base64,${slimmed.toString('base64')}` : match[0]
      done.set(match[0], replacement)
    }
    parts.push(html.slice(from, match.index), replacement)
    from = match.index + match[0].length
  }
  if (!parts.length) return html
  parts.push(html.slice(from))
  return parts.join('')
}

/** The page, slimmed until it fits `target` bytes; the best effort when nothing makes it fit. */
export async function slimHandoutHtml(html: string, target: number = SLIM_TARGET_BYTES): Promise<string> {
  // Videos first, as before: only clips over 8 MB go, and picture quality alone is lowered.
  const base = stripVideos(html, 8 * 1024 * 1024)
  let last = base
  for (const step of IMAGE_STEPS) {
    const out = await compressImages(base, step)
    if (Buffer.byteLength(out, 'utf8') <= target) return out
    last = out
  }
  // Pictures are at the lowest step and the page is still too big: smaller and smaller videos go.
  const lowest = IMAGE_STEPS[IMAGE_STEPS.length - 1]
  for (const megabytes of [4, 2, 1]) {
    const out = await compressImages(stripVideos(html, megabytes * 1024 * 1024), lowest)
    if (Buffer.byteLength(out, 'utf8') <= target) return out
    last = out
  }
  return last
}
