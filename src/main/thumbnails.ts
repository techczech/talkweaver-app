import { BrowserWindow } from 'electron'
import type { NativeImage } from 'electron'
import { join } from 'path'
import { tmpdir } from 'os'
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs'
import { createHash, randomBytes } from 'crypto'
import { markSlidePreviewHtml } from '../shared/slide-preview'

export interface RenderThumbnailsOptions {
  /** Full compiled single-file presentation HTML (the presenter-popup runtime). */
  fullHtml: string
  /** Ordered slides — one per ProjectionRow, in presentation order. key is the cache key;
   *  layout (when a multi-part one) drives per-part sub-thumbnail capture. */
  slides: Array<{ key: string; cacheKey?: string; layout?: string }>
  /** Absolute directory to write PNGs into. Created if missing. */
  cacheDir: string
}

// ADR-0022: per-part sub-thumbnails are captured ONLY for a CAROUSEL — a slide whose rendered
// content carries `.card-gallery[data-exclusive]` (stepped full-bleed sub-slides from #### cards or
// {carousel}). Each sub-slide is captured as its own full-frame thumbnail. The old layout-name
// PART_SELECTORS map (cards/columns/contrast/image-grid → many thumbnails) is retired: static
// multi-part layouts (columns, contrast, image-grid, cards-grid, gallery) now get exactly ONE
// thumbnail. The carousel marker on the active slide is the only trigger.
const CAROUSEL_SELECTOR = '.card-gallery[data-exclusive]'

// Persistent hidden render window. Every edit pause used to spawn a fresh BrowserWindow (and
// tear it down) just to re-capture the one slide that changed — window creation plus a cold
// renderer per keystroke-pause. Keep ONE hidden window alive across calls, keyed by a hash of
// the loaded deck HTML so an unchanged deck (e.g. a manual refresh) skips the reload entirely.
// Idle-destroyed after a minute so a long-running app doesn't pin a multi-MB deck in memory.
let renderWin: BrowserWindow | null = null
let renderWinHtmlKey: string | null = null
let renderWinIdleTimer: NodeJS.Timeout | null = null
// Calls are serialized: two overlapping runs would fight over the shared window's active slide.
let renderQueue: Promise<unknown> = Promise.resolve()

const RENDER_WIN_IDLE_MS = 60_000

function destroyRenderWin(): void {
  if (renderWinIdleTimer) { clearTimeout(renderWinIdleTimer); renderWinIdleTimer = null }
  if (renderWin && !renderWin.isDestroyed()) renderWin.destroy()
  renderWin = null
  renderWinHtmlKey = null
}

async function ensureDeckLoaded(fullHtml: string): Promise<BrowserWindow> {
  fullHtml = markSlidePreviewHtml(fullHtml)
  const key = createHash('sha256').update(fullHtml).digest('hex')
  if (renderWin && !renderWin.isDestroyed() && renderWinHtmlKey === key) return renderWin
  let win = renderWin
  if (!win || win.isDestroyed()) {
    // A real (not offscreen) hidden window — offscreen rendering is unreliable for capturePage.
    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 720,
      webPreferences: { offscreen: false }
    })
    win.on('closed', () => { renderWin = null; renderWinHtmlKey = null })
    renderWin = win
  }
  renderWinHtmlKey = null // not valid until the load below succeeds
  // Large HTML loads far more reliably from a temp file than a data: URL. The deck is fully
  // self-contained (assets inlined), so the file can be deleted as soon as the load finishes.
  const tmpHtmlPath = join(tmpdir(), `talk-weaver-thumb-${randomBytes(8).toString('hex')}.html`)
  try {
    writeFileSync(tmpHtmlPath, fullHtml, 'utf8')
    const finished = new Promise<void>((resolve, reject) => {
      win.webContents.once('did-finish-load', () => resolve())
      win.webContents.once('did-fail-load', (_e, code, desc) =>
        reject(new Error(`did-fail-load ${code}: ${desc}`))
      )
    })
    await win.loadFile(tmpHtmlPath)
    await finished
    renderWinHtmlKey = key
    return win
  } catch (err) {
    destroyRenderWin()
    throw err
  } finally {
    try {
      if (existsSync(tmpHtmlPath)) unlinkSync(tmpHtmlPath)
    } catch {
      /* best-effort temp cleanup */
    }
  }
}

/**
 * Render one PNG thumbnail per slide of a compiled presentation.
 *
 * Slides are addressed by index. The runtime renders exactly the slide carrying the
 * `.slide.active` class (`.slide.active { display: grid }`; all others `display:none`)
 * inside `#stage`, where `stage.querySelectorAll('.slide')` is the ordered slide list —
 * the same order as the projections array. We drive navigation by setting
 * `location.hash = '#' + slide.dataset.id` and dispatching a `hashchange` event, which the
 * runtime listens for and routes through its own `goTo()` → `renderAudience()` (applying
 * autofit, fragments, zoom). A direct `.active` toggle by index is used as a fallback when
 * hash routing is a no-op (e.g. the hash already matches the target slide).
 *
 * Returns a map of slide key → absolute PNG path. Cache-keyed by `key`: if the PNG already
 * exists it is reused and the slide is not re-rendered. On error, whatever was rendered so
 * far is returned (partial beats nothing).
 */
export async function renderThumbnails(
  opts: RenderThumbnailsOptions
): Promise<Record<string, string>> {
  // Serialize via the shared-window queue; each call still resolves to its own result.
  const run = renderQueue.then(() => renderThumbnailsSerialized(opts))
  renderQueue = run.catch(() => {})
  return run
}

async function renderThumbnailsSerialized(
  opts: RenderThumbnailsOptions
): Promise<Record<string, string>> {
  const { fullHtml, slides, cacheDir } = opts
  const result: Record<string, string> = {}

  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true })

  // Decide up front which slides actually need rendering; if all are cached, skip the window.
  const pending: Array<{ index: number; key: string; cacheKey: string; layout?: string; pngPath: string }> = []
  slides.forEach((slide, index) => {
    const cacheKey = slide.cacheKey ?? slide.key
    const pngPath = join(cacheDir, `${cacheKey}.png`)
    if (existsSync(pngPath)) {
      result[slide.key] = pngPath
      // Re-attach any cached sub-thumbnails (subslides) for this slide.
      let i = 0
      while (existsSync(join(cacheDir, `${cacheKey}__${i}.png`))) {
        result[`${slide.key}__${i}`] = join(cacheDir, `${cacheKey}__${i}.png`)
        i += 1
      }
    } else {
      pending.push({ index, key: slide.key, cacheKey, layout: slide.layout, pngPath })
    }
  })

  if (pending.length === 0) return result

  if (renderWinIdleTimer) { clearTimeout(renderWinIdleTimer); renderWinIdleTimer = null }

  try {
    const win = await ensureDeckLoaded(fullHtml)

    for (const item of pending) {
      try {
        await navigateToSlide(win, item.index)
        const { pending: stillPending } = await settle(win)
        // DETERMINISM: never persist an INCOMPLETE render. A large image (e.g. an 8MP paste) can
        // miss settle's decode window under load — capturing a blank. Caching that blank made it
        // STICK (the cache key is the slide model, stable until the slide changes), so the preview
        // stayed blank while Present/handout — fresh, uncached — were fine. If any image is still
        // unloaded, skip the cache write: the slide stays uncached and the next compile re-renders
        // it (and succeeds once the machine is idle). A transient blank can no longer become permanent.
        if (stillPending > 0) {
          console.warn(`[thumbnails] slide ${item.index} (${item.key}): ${stillPending} image(s) not loaded in time — NOT caching (will retry next compile)`)
          continue
        }
        // RIGHT-SLIDE GUARANTEE: re-assert the target as the SOLE active slide immediately before
        // capture. The image-settle wait above can be long, and the runtime can async re-navigate
        // (autofit / a pending hashchange rAF) during it — leaving a DIFFERENT slide showing, so the
        // screenshot captured the wrong slide (e.g. slide 44's thumbnail showed slide 1). That wrong
        // capture has loaded images, so the "don't cache blank" guard above does NOT catch it, and it
        // got cached → the scrambled strip with no recovery. We re-toggle + verify; if the target is
        // not the sole active slide we DON'T cache (skip), so a wrong capture can never persist.
        const onTarget = await forceActiveSlide(win, item.index)
        if (!onTarget) {
          console.warn(`[thumbnails] slide ${item.index} (${item.key}): could not isolate it as the active slide — NOT caching (will retry)`)
          continue
        }
        const img: NativeImage = await win.webContents.capturePage()
        writeFileSync(item.pngPath, img.toPNG())
        result[item.key] = item.pngPath

        // ADR-0022: ONLY a carousel (the active slide carries .card-gallery[data-exclusive]) gets
        // per-sub-slide thumbnails — one full-frame capture per stepped full-bleed sub-slide.
        if (await activeSlideHasCarousel(win)) {
          const parts = await captureCarouselSubSlides(win)
          for (let i = 0; i < parts.length; i += 1) {
            const p = join(cacheDir, `${item.cacheKey}__${i}.png`)
            writeFileSync(p, parts[i].toPNG())
            result[`${item.key}__${i}`] = p
          }
        }
      } catch (err) {
        // Partial is better than none — log and keep going.
        console.error(`[thumbnails] failed to render slide ${item.index} (${item.key}):`, err)
      }
    }
  } catch (err) {
    console.error('[thumbnails] render aborted:', err)
  } finally {
    // Keep the window for the next pause; drop it (and the deck it pins in memory) when idle.
    if (renderWinIdleTimer) clearTimeout(renderWinIdleTimer)
    renderWinIdleTimer = setTimeout(destroyRenderWin, RENDER_WIN_IDLE_MS)
  }

  return result
}

/**
 * Drive the deck to slide `index` using its own hash-based navigation, falling back to a
 * direct `.active` toggle if the hash route does not move the deck.
 */
async function navigateToSlide(win: BrowserWindow, index: number): Promise<void> {
  await win.webContents.executeJavaScript(
    `(() => {
      const stage = document.getElementById('stage');
      const slides = stage ? Array.from(stage.querySelectorAll('.slide')) : [];
      const target = slides[${index}];
      if (!target) return false;
      const id = target.dataset.id || '';
      if (id && location.hash !== '#' + id) {
        location.hash = '#' + id;
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      }
      // Fallback / guarantee: ensure the target is the one visible slide.
      slides.forEach((s, i) => s.classList.toggle('active', i === ${index}));
      return true;
    })()`,
    true
  )
}

/**
 * Re-assert that ONLY slide `index` is active, immediately before capture, and verify it. The
 * image-settle wait can be long enough for the runtime to async re-navigate (autofit / a pending
 * hashchange rAF), leaving a different slide showing — so the screenshot would capture the wrong
 * slide (the "scrambled strip" bug). This forces the target active again WITHOUT re-dispatching a
 * hashchange (so the runtime isn't re-triggered), waits a frame, and returns true only when the
 * target is the single active slide. A false result tells the caller to skip caching.
 */
async function forceActiveSlide(win: BrowserWindow, index: number): Promise<boolean> {
  return win.webContents.executeJavaScript(
    `new Promise((resolve) => {
      const stage = document.getElementById('stage');
      const slides = stage ? Array.from(stage.querySelectorAll('.slide')) : [];
      const target = slides[${index}];
      if (!target) { resolve(false); return; }
      slides.forEach((s, i) => s.classList.toggle('active', i === ${index}));
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const active = stage.querySelectorAll('.slide.active');
        resolve(active.length === 1 && active[0] === target);
      }));
    })`,
    true
  )
}

/**
 * Wait for the active slide to be paintable: wait for every <img> on it to finish decoding
 * (base64-embedded images are NOT painted on the first frame, so a bare double-rAF captured blank
 * thumbnails), then a double requestAnimationFrame for layout. Returns the number of images STILL
 * not loaded when the cap fires (0 = fully painted) so the caller can refuse to cache an incomplete
 * render. The cap is generous (10s) because a large paste (e.g. 8MP) decodes slowly under load; the
 * "don't cache incomplete" guard means an over-cap slide simply retries rather than caching blank.
 */
async function settle(win: BrowserWindow): Promise<{ pending: number }> {
  return win.webContents.executeJavaScript(
    `new Promise((resolve) => {
      // ONLY the VISIBLE images on the slide being captured. The old selector was
      // '.slide.active img, #stage img' — the '#stage img' part grabbed images from EVERY slide
      // (hundreds of hidden, inlined base64 images on inactive slides) that never decode while
      // display:none, so the "don't cache incomplete" guard skipped every slide → blank strip.
      // Scope to '.slide.active img' and drop hidden ones (e.g. inactive carousel sub-cards).
      const isVisible = (i) => { try { return i.checkVisibility ? i.checkVisibility() : (i.offsetParent !== null || i.offsetWidth > 0 || i.offsetHeight > 0); } catch { return true; } };
      const collect = () => Array.from(document.querySelectorAll('.slide.active img')).filter(isVisible);
      const stillPending = () => collect().filter((i) => !(i.complete && i.naturalWidth > 0)).length;
      // A clip paints its POSTER (a data: jpeg) until played; it's a <video poster> attribute, not an
      // <img>, so decode it explicitly before capture or the strip thumbnail is a blank frame (ADR-0028).
      const posterDecodes = Array.from(document.querySelectorAll('.slide.active video')).filter(isVisible).map((v) => {
        const src = v.getAttribute('poster'); if (!src) return Promise.resolve();
        const im = new Image(); im.src = src; return im.decode ? im.decode().catch(() => {}) : Promise.resolve();
      });
      const done = () => Promise.all(posterDecodes).then(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve({ pending: stillPending() }))));
      const imgs = collect();
      const pending = imgs.filter((i) => !(i.complete && i.naturalWidth > 0));
      if (pending.length === 0) { done(); return; }
      let left = pending.length;
      let finished = false;
      const tick = () => { if (finished) return; left -= 1; if (left <= 0) { finished = true; done(); } };
      pending.forEach((i) => {
        // Count each image AT MOST ONCE — load/error/decode can all fire for the same image, and
        // double-counting drops the counter to 0 before later images load → a blank/partial capture.
        let counted = false;
        const one = () => { if (counted) return; counted = true; tick(); };
        i.addEventListener('load', one, { once: true });
        i.addEventListener('error', one, { once: true });
        if (typeof i.decode === 'function') { i.decode().then(one).catch(one); }
      });
      setTimeout(() => { if (!finished) { finished = true; done(); } }, 10000);
    })`,
    true
  )
}

/** True when the active slide's rendered content is a CAROUSEL (ADR-0022) — i.e. it carries a
 *  `.card-gallery[data-exclusive]` stepping container of full-bleed sub-slides. */
async function activeSlideHasCarousel(win: BrowserWindow): Promise<boolean> {
  return win.webContents.executeJavaScript(
    `(() => {
      const stage = document.getElementById('stage');
      const active = (stage && stage.querySelector('.slide.active')) || document.querySelector('.slide.active');
      return Boolean(active && active.querySelector(${JSON.stringify(CAROUSEL_SELECTOR)}));
    })()`,
    true
  )
}

/**
 * ADR-0022: capture each full-bleed CAROUSEL sub-slide as its own full-frame thumbnail. A sub-slide
 * (`.card-gallery[data-exclusive] > .card.carousel-subslide`) is a real slide — only the one
 * carrying `.active-card` is painted (the rest are display:none). So we step the `active-card` class
 * across the sub-slides one at a time, let each settle (images decode + layout), and capturePage the
 * whole frame — exactly how each sub-slide looks when stepped to in Present. Restores the original
 * active sub-slide afterwards so the slide's own thumbnail/state is unchanged.
 */
async function captureCarouselSubSlides(win: BrowserWindow): Promise<NativeImage[]> {
  const count: number = await win.webContents.executeJavaScript(
    `(() => {
      const stage = document.getElementById('stage');
      const active = (stage && stage.querySelector('.slide.active')) || document.querySelector('.slide.active');
      const gallery = active && active.querySelector(${JSON.stringify(CAROUSEL_SELECTOR)});
      if (!gallery) return 0;
      return gallery.querySelectorAll(':scope > .card.carousel-subslide').length;
    })()`,
    true
  )
  const imgs: NativeImage[] = []
  for (let i = 0; i < count; i += 1) {
    await win.webContents.executeJavaScript(
      `(() => {
        const stage = document.getElementById('stage');
        const active = (stage && stage.querySelector('.slide.active')) || document.querySelector('.slide.active');
        const gallery = active && active.querySelector(${JSON.stringify(CAROUSEL_SELECTOR)});
        if (!gallery) return false;
        const subs = Array.from(gallery.querySelectorAll(':scope > .card.carousel-subslide'));
        subs.forEach((s, idx) => s.classList.toggle('active-card', idx === ${i}));
        return true;
      })()`,
      true
    )
    await settle(win)
    try {
      imgs.push(await win.webContents.capturePage())
    } catch {
      /* skip a sub-slide that fails to capture */
    }
  }
  // Restore the first sub-slide as the shown one (the runtime's arrival default).
  await win.webContents.executeJavaScript(
    `(() => {
      const stage = document.getElementById('stage');
      const active = (stage && stage.querySelector('.slide.active')) || document.querySelector('.slide.active');
      const gallery = active && active.querySelector(${JSON.stringify(CAROUSEL_SELECTOR)});
      if (!gallery) return false;
      const subs = Array.from(gallery.querySelectorAll(':scope > .card.carousel-subslide'));
      subs.forEach((s, idx) => s.classList.toggle('active-card', idx === 0));
      return true;
    })()`,
    true
  )
  return imgs
}
