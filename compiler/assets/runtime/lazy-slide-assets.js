// Lazy slide assets for the published handout (index.html and <slug>.html). The publisher moves each
// heavy inline image or video out of the page into a content-hashed file (handout-lazy-assets.mjs) and
// leaves a placeholder of the same intrinsic size carrying data-lazy-src (a video's poster: data-lazy-poster). This module fetches them:
//
//  - live: the slide the speaker is on first, then the next two and the previous one, then slides the
//    person is looking at, then the rest at idle, one or two at a time. A new live slide jumps the queue.
//  - not live: slides on screen first (IntersectionObserver), then the rest at idle.
//  - a failed asset leaves the slide's text and a quiet Retry; it also retries itself, twice, later.
//
// Nothing else on the page waits for it: polls, reactions, Ask and boards run before any image lands.
// Each function is embedded in the page by `.toString()` (lazySlideAssetsRuntimeSource), so it is
// self-contained: no module-level constants, no imports.

/**
 * The pure priority queue. Assets are { url, slides: number[] }; each is pending, loading, loaded or
 * failed. take() hands out the best pending asset by tier, recomputed on every call, so a change of
 * current slide or visibility re-prioritises everything still pending.
 * Tiers: live → 0 current, 1 next two, 2 previous one, 3 visible, 4 the rest (idle);
 *        not live → 3 visible, 4 the rest (idle).
 * @param {Array<{ url: string, slides: number[] }>} assets
 */
export function createSlideAssetQueue(assets) {
  const items = assets.map((asset, order) => ({ url: asset.url, slides: asset.slides.slice(), order, state: 'pending' }))
  const byUrl = new Map(items.map((item) => [item.url, item]))
  const visible = new Set()
  let live = false
  let current = /** @type {number | null} */ (null)
  const slideTier = (slide) => {
    if (live && current !== null) {
      if (slide === current) return 0
      if (slide === current + 1 || slide === current + 2) return 1
      if (slide === current - 1) return 2
    }
    return visible.has(slide) ? 3 : 4
  }
  // Within a tier: the slides after the anchor in order, then the ones before it, nearest first.
  const anchor = () => (live && current !== null ? current : visible.size ? Math.min(...visible) : 0)
  const distance = (slide, from) => (slide >= from ? slide - from : 100000 + (from - slide))
  const rank = (item) => {
    const from = anchor()
    let tier = 5
    let near = Infinity
    for (const slide of item.slides) {
      const t = slideTier(slide)
      const d = distance(slide, from)
      if (t < tier || (t === tier && d < near)) { tier = t; near = d }
    }
    return { tier, near }
  }
  return {
    setLive(value) { live = Boolean(value) },
    setCurrent(slide) { current = Number.isInteger(slide) && slide >= 0 ? slide : null },
    setVisible(slide, on) { if (on) visible.add(slide); else visible.delete(slide) },
    /** A pending asset of the speaker's current slide, marked loading, or null. Never waits for a slot. */
    takeCurrent() {
      const item = items.find((candidate) => candidate.state === 'pending' && rank(candidate).tier === 0)
      if (!item) return null
      item.state = 'loading'
      return { url: item.url, slides: item.slides.slice(), urgent: true }
    },
    /** The best pending asset, marked loading; null when none, or when only idle work is left and !allowIdle. */
    take(allowIdle = true) {
      let best = null
      let bestRank = null
      for (const item of items) {
        if (item.state !== 'pending') continue
        const r = rank(item)
        if (!bestRank || r.tier < bestRank.tier || (r.tier === bestRank.tier && (r.near < bestRank.near || (r.near === bestRank.near && item.order < best.order)))) { best = item; bestRank = r }
      }
      if (!best || (!allowIdle && bestRank.tier >= 4)) return null
      best.state = 'loading'
      return { url: best.url, slides: best.slides.slice(), urgent: bestRank.tier < 4 }
    },
    /** True when a pending asset outranks idle work. */
    hasUrgent() { return items.some((item) => item.state === 'pending' && rank(item).tier < 4) },
    settle(url, ok) { const item = byUrl.get(url); if (item && item.state === 'loading') item.state = ok ? 'loaded' : 'failed' },
    requeue(url) { const item = byUrl.get(url); if (item && item.state === 'failed') item.state = 'pending' },
    state(url) { return byUrl.get(url)?.state ?? null },
    loading() { return items.filter((item) => item.state === 'loading').length },
    drained() { return items.every((item) => item.state === 'loaded' || item.state === 'failed') },
  }
}

/**
 * The DOM binding. `slides` are the deck's own <section> elements (index = slide number - 1). Clones of
 * a slide (phone list, overview, full screen, the home page's stage) carry the same data-lazy-src and
 * are filled when the asset lands; a clone made afterwards copies the real src.
 * @param {{ document: Document, window: Window & typeof globalThis, slides: Element[], liveConfigured: boolean,
 *   urgentLimit?: number, idleLimit?: number, settleMs?: number, retryDelays?: number[], videoTimeoutMs?: number }} options
 */
export function createLazySlideAssets(options) {
  const doc = options.document
  const win = options.window
  const urgentLimit = options.urgentLimit || 4
  const idleLimit = options.idleLimit || 2
  const retryDelays = options.retryDelays || [5000, 20000]
  const assetSlides = new Map()
  // An element's lazy files: its own (data-lazy-src) and, for a video, its poster (data-lazy-poster).
  const urlsOf = (el) => [el.getAttribute('data-lazy-src'), el.getAttribute('data-lazy-poster')].filter(Boolean)
  options.slides.forEach((slide, index) => {
    slide.querySelectorAll('[data-lazy-src],[data-lazy-poster]').forEach((el) => {
      urlsOf(el).forEach((url) => {
        if (!assetSlides.has(url)) assetSlides.set(url, new Set())
        assetSlides.get(url).add(index)
      })
    })
  })
  if (!assetSlides.size) return null
  const queue = createSlideAssetQueue([...assetSlides].map(([url, set]) => ({ url, slides: [...set] })))
  const attempts = new Map()
  // Until the page knows whether a session is live, nothing idle starts (a live phone wants the
  // speaker's slide first, not slide 1). A live page also waits briefly for the speaker's slide.
  let settled = !options.liveConfigured
  let live = false
  let holdForLiveSlide = false
  let idleScheduled = false
  const settleTimer = win.setTimeout(() => { settled = true; pump() }, options.settleMs || 3000)
  if (settled) win.clearTimeout(settleTimer)
  const lazyElements = (url) => Array.from(doc.querySelectorAll('[data-lazy-src],[data-lazy-poster]')).filter((el) => urlsOf(el).includes(url))
  const slideOf = (el) => {
    const section = el.closest('[data-share-index]')
    const n = section ? Number(section.getAttribute('data-share-index')) : NaN
    return Number.isInteger(n) ? n : -1
  }

  // Visibility: every lazy element, the slides' own and their clones, counts toward its slide.
  const onScreen = new Map()
  const markVisible = (el, on) => {
    const slide = slideOf(el)
    if (slide < 0) return
    const set = onScreen.get(slide) || new Set()
    if (on) set.add(el); else set.delete(el)
    onScreen.set(slide, set)
    queue.setVisible(slide, set.size > 0)
  }
  const observer = typeof win.IntersectionObserver === 'function'
    ? new win.IntersectionObserver((entries) => { entries.forEach((entry) => markVisible(entry.target, entry.isIntersecting)); pump() }, { rootMargin: '200px 0px' })
    : null
  const watch = (root) => {
    const found = root.matches && root.matches('[data-lazy-src],[data-lazy-poster]') ? [root] : []
    if (root.querySelectorAll) found.push(...root.querySelectorAll('[data-lazy-src],[data-lazy-poster]'))
    found.forEach((el) => {
      urlsOf(el).forEach((url) => {
        if (queue.state(url) === 'loaded') fill(el, url)
        else if (queue.state(url) === 'failed' && el.getAttribute('data-lazy-src') === url) addRetry(el, url)
      })
      if (observer && !urlsOf(el).every((url) => queue.state(url) === 'loaded')) observer.observe(el)
    })
  }
  watch(doc.body)
  if (typeof win.MutationObserver === 'function') {
    new win.MutationObserver((records) => {
      records.forEach((record) => record.addedNodes.forEach((node) => { if (node.nodeType === 1) watch(/** @type {Element} */ (node)) }))
    }).observe(doc.body, { childList: true, subtree: true })
  }

  function fill(el, url) {
    if (el.getAttribute('data-lazy-poster') === url && el.getAttribute('poster') !== url) el.setAttribute('poster', url)
    if (el.getAttribute('data-lazy-src') === url) {
      if (el.getAttribute('src') !== url) el.setAttribute('src', url)
      el.setAttribute('data-lazy-state', 'loaded')
      const retry = el.nextElementSibling
      if (retry && retry.classList.contains('lazy-retry')) retry.remove()
    }
    if (observer && urlsOf(el).every((u) => queue.state(u) === 'loaded')) observer.unobserve(el)
  }
  function addRetry(el, url) {
    el.setAttribute('data-lazy-state', 'failed')
    const next = el.nextElementSibling
    if (next && next.classList.contains('lazy-retry')) return
    const button = doc.createElement('button')
    button.type = 'button'
    button.className = 'lazy-retry'
    button.setAttribute('data-lazy-url', url)
    button.textContent = el.tagName === 'VIDEO' ? 'Video not loaded · Retry' : 'Image not loaded · Retry'
    el.insertAdjacentElement('afterend', button)
  }
  function finish(url, ok) {
    queue.settle(url, ok)
    // A poster that fails is retried quietly; only the picture or video itself gets a Retry.
    lazyElements(url).forEach((el) => (ok ? fill(el, url) : el.getAttribute('data-lazy-src') === url && addRetry(el, url)))
    if (!ok) {
      const n = attempts.get(url) || 0
      if (n < retryDelays.length) {
        attempts.set(url, n + 1)
        win.setTimeout(() => retry(url), retryDelays[n])
      }
    }
    pump()
  }
  function load(asset) {
    const els = lazyElements(asset.url)
    if (els.length && els.every((el) => el.tagName === 'VIDEO' && el.getAttribute('data-lazy-src') === asset.url)) {
      // A video streams when played: point it at the file and wait only for its metadata. An error
      // fails it (Retry, auto-retries); a server that never answers frees the slot after videoTimeoutMs.
      let done = false
      const end = (ok) => {
        if (done) return
        done = true
        win.clearTimeout(timer)
        els.forEach((el) => { el.removeEventListener('loadedmetadata', onMeta); el.removeEventListener('error', onError) })
        finish(asset.url, ok)
      }
      const onMeta = () => end(true)
      const onError = () => end(false)
      const timer = win.setTimeout(() => end(true), options.videoTimeoutMs || 20000)
      els.forEach((el) => {
        el.addEventListener('loadedmetadata', onMeta)
        el.addEventListener('error', onError)
        el.setAttribute('preload', 'metadata')
        el.setAttribute('data-lazy-state', 'loading')
        if (el.getAttribute('src') !== asset.url) el.setAttribute('src', asset.url)
        else if (typeof /** @type {HTMLVideoElement} */ (el).load === 'function') /** @type {HTMLVideoElement} */ (el).load()
      })
      return
    }
    const img = new win.Image()
    img.onload = () => finish(asset.url, true)
    img.onerror = () => finish(asset.url, false)
    img.src = asset.url
  }
  function retry(url) {
    if (queue.state(url) !== 'failed') return
    queue.requeue(url)
    lazyElements(url).forEach((el) => { if (el.getAttribute('data-lazy-src') === url) el.setAttribute('data-lazy-state', 'retrying') })
    pump()
  }
  function pump() {
    if (holdForLiveSlide) return
    // The speaker's current slide never waits for a slot: its assets start even when the limit is full.
    for (let asset = queue.takeCurrent(); asset; asset = queue.takeCurrent()) load(asset)
    while (queue.loading() < urgentLimit && queue.hasUrgent()) {
      const asset = queue.take(false)
      if (!asset) break
      load(asset)
    }
    if (settled && !idleScheduled && !queue.hasUrgent() && queue.loading() < idleLimit && !queue.drained()) {
      idleScheduled = true
      const run = () => {
        idleScheduled = false
        if (queue.hasUrgent()) { pump(); return }
        const asset = queue.loading() < idleLimit ? queue.take(true) : null
        if (asset) load(asset)
        pump()
      }
      if (typeof win.requestIdleCallback === 'function') win.requestIdleCallback(run, { timeout: 1500 })
      else win.setTimeout(run, 120)
    }
  }
  doc.addEventListener('click', (event) => {
    const button = event.target && /** @type {Element} */ (event.target).closest ? /** @type {Element} */ (event.target).closest('.lazy-retry') : null
    if (!button) return
    event.preventDefault()
    event.stopPropagation()
    const url = button.getAttribute('data-lazy-url')
    if (url) { attempts.set(url, 0); retry(url) }
  }, true)
  // Printing wants every picture: point every placeholder at its file (best effort).
  win.addEventListener('beforeprint', () => {
    doc.querySelectorAll('[data-lazy-src],[data-lazy-poster]').forEach((el) => {
      const src = el.getAttribute('data-lazy-src')
      const poster = el.getAttribute('data-lazy-poster')
      if (src && el.getAttribute('data-lazy-state') !== 'loaded') el.setAttribute('src', src)
      if (poster) el.setAttribute('poster', poster)
    })
  })
  pump()

  return {
    /** The live session started or ended. */
    setLive(value) {
      const was = live
      live = Boolean(value)
      queue.setLive(live)
      settled = true
      win.clearTimeout(settleTimer)
      if (!live) { holdForLiveSlide = false; queue.setCurrent(null) }
      else if (!was) {
        // Just went live: wait (briefly) for the speaker's slide before fetching anything.
        holdForLiveSlide = true
        win.setTimeout(() => { holdForLiveSlide = false; pump() }, options.settleMs || 3000)
      }
      pump()
    },
    /** The slide the speaker is on (index), from the live slide state. */
    setLiveSlide(index) {
      if (!Number.isInteger(index) || index < 0) return
      holdForLiveSlide = false
      queue.setCurrent(index)
      pump()
    },
    retry,
    queue,
  }
}

export function lazySlideAssetsRuntimeSource() {
  return [createSlideAssetQueue, createLazySlideAssets].map((fn) => fn.toString()).join('\n')
}

/** Placeholders look like an empty frame until their file lands; the retry sits quietly under it. */
export const lazySlideAssetsStyles = `
img[data-lazy-src]:not([data-lazy-state="loaded"]){background:rgba(127,127,127,.12)}
.lazy-retry{display:block;margin:12px auto 0;padding:6px 16px;border:1px solid rgba(127,127,127,.4);border-radius:999px;background:rgba(255,255,255,.85);color:#3b4250;font:500 22px/1.3 -apple-system,system-ui,"Segoe UI",sans-serif;cursor:pointer}
`
