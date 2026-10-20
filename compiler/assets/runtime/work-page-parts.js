// The participant work page's small parts (work-files ticket 15; ADR-0040 decision 4): what the page
// may load, what a step's slide reads as on a phone, the words that change with the phase, and the
// Worker's status as the page reads it. The screens are work-page.js.
//
// Every function here is one the page embeds by `.toString()` (see workPagePartsSource), so each is
// self-contained: no module-level constants of its own, and any function it calls is in that list.

/** The icons the page adds to the 0.37 form's set (lucide 1.x paths). */
export function workPageIcons() {
  return {
    video: '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
    'pencil-line': '<path d="M13 21h8"/><path d="m15 5 4 4"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
    gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
    'file-text': '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    'arrow-up-right': '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
    send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    'wifi-off': '<path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  }
}

/**
 * Whether `url` is a video player the compiler draws and the page may load in a frame: YouTube's
 * no-cookie player or Vimeo's, over https, with a video id. The same rule as the step sanitiser's
 * (src/shared/work-step-html.ts) and the page's frame-src.
 * @param {unknown} url
 */
export function workPagePlayerUrl(url) {
  return typeof url === 'string' && /^https:\/\/(?:(?:www\.)?youtube-nocookie\.com\/embed\/[\w-]{11}|player\.vimeo\.com\/video\/\d+)(?:[?#][^\s"'<>]*)?$/.test(url)
}

/**
 * A step's slide made ready on the page: an allowed video player's `data-src` becomes its `src`; any
 * other frame is taken out (the sanitiser already allows no other, this is the page's own rule). Only
 * `src` is ever set, and only from `data-src`.
 * @param {any} root
 */
export function workPageActivateMedia(root) {
  if (!root || !root.querySelectorAll) return
  for (const frame of Array.from(root.querySelectorAll('iframe'))) {
    const src = frame.getAttribute('data-src')
    if (frame.getAttribute('data-embed-video') === '1' && workPagePlayerUrl(src)) {
      if (frame.getAttribute('src') !== src) frame.setAttribute('src', src)
    } else {
      frame.remove()
    }
  }
}

/**
 * Mermaid diagrams in a step: the source is the `data-mmd-src` text, given to Mermaid as text; Mermaid
 * runs with strict security (set where the page starts it). Its SVG is parsed in an inert template and
 * walked before it is placed: no script, foreignObject, frame or animation element, no event handler
 * and no address but a #fragment survives, in an attribute or in the diagram's CSS (`url()` in its
 * <style> or a style attribute) (the page's script policy is the second defence). A diagram
 * that will not draw shows its source as text.
 * @param {any} root @param {any} mermaid @param {any} document
 */
export function workPageRenderMermaid(root, mermaid, document) {
  if (!root || !root.querySelectorAll || !mermaid || typeof mermaid.render !== 'function') return
  // CSS in the diagram (its <style>, a style attribute) may name only #fragments: any other url() becomes
  // `none`, and CSS that could still reach out (an escape, @import, expression) is dropped whole.
  const fragmentsOnly = (css) => String(css).replace(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (whole, _q, ref) => (String(ref).trim().startsWith('#') ? whole : 'none'))
  const cssSafe = (css) => !/\\|@import|expression\s*\(|javascript\s*:|-moz-binding|behavior\s*:/i.test(css)
    && !/url\s*\(/i.test(css.replace(/url\(\s*(['"]?)#[^)'"]*\1\s*\)/gi, ''))
  const clean = (svg) => {
    const holder = document.createElement('template')
    holder.innerHTML = svg
    for (const node of Array.from(holder.content.querySelectorAll('*'))) {
      const tag = String(node.localName || '').toLowerCase()
      if (/^(script|foreignobject|iframe|object|embed|animate|animatemotion|animatetransform|set|use|image|a)$/.test(tag)) { node.remove(); continue }
      if (tag === 'style') {
        const css = fragmentsOnly(node.textContent || '')
        if (!cssSafe(css)) { node.remove(); continue }
        node.textContent = css
      }
      for (const attr of Array.from(node.attributes)) {
        const name = attr.name.toLowerCase()
        if (name.startsWith('on') || ((name === 'href' || name === 'xlink:href' || name === 'src') && !attr.value.trim().startsWith('#'))) { node.removeAttribute(attr.name); continue }
        if (name === 'style' || /url\s*\(/i.test(attr.value)) {
          const css = fragmentsOnly(attr.value)
          if (!cssSafe(css)) node.removeAttribute(attr.name)
          else if (css !== attr.value) node.setAttribute(attr.name, css)
        }
      }
    }
    return holder.content
  }
  for (const host of Array.from(root.querySelectorAll('.mermaid-mm:not([data-mmd-done])'))) {
    host.setAttribute('data-mmd-done', '1')
    const src = host.getAttribute('data-mmd-src') || ''
    Promise.resolve().then(() => mermaid.render('wpmmd' + Math.random().toString(36).slice(2), src)).then((result) => {
      host.textContent = ''
      if (result && typeof result.svg === 'string') host.appendChild(clean(result.svg))
    }, () => {
      host.textContent = ''
      const pre = document.createElement('pre')
      pre.className = 'wp-mmd-source'
      pre.textContent = src
      host.appendChild(pre)
    })
  }
}

/**
 * What a slide says, as a phone reads it under its picture: list items and paragraphs, in order, as
 * plain strings (textContent only). A numbered list is `ordered`. The compiler's own number badges
 * (`.fl-num`) are left out, since the list numbers itself.
 * @param {any} slide
 * @returns {{ text: string, item: boolean, ordered: boolean }[]}
 */
export function workPageSlideLines(slide) {
  const lines = []
  if (!slide || !slide.querySelectorAll) return lines
  const scope = slide.querySelector('.slide-content') || slide
  for (const node of Array.from(scope.querySelectorAll('li, p'))) {
    if (node.closest('.notes, aside, figure, .slide-head, .poll-frame, template')) continue
    if (node.tagName === 'P' && node.closest('li')) continue
    if (node.tagName === 'LI' && node.parentElement && node.parentElement.closest('li')) continue
    const copy = node.cloneNode(true)
    for (const nested of Array.from(copy.querySelectorAll('ul, ol, .fl-num, .fl-icon'))) nested.remove()
    const text = String(copy.textContent || '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const list = node.tagName === 'LI' ? node.parentElement : null
    const ordered = Boolean(list && (list.tagName === 'OL' || (list.classList && list.classList.contains('fl-numbered'))))
    lines.push({ text, item: node.tagName === 'LI', ordered })
    if (lines.length >= 40) break
  }
  return lines
}

/**
 * The words that change between pre-work and post-work (ADR-0040 decision 4: the same page, headed
 * "After the session" for post-work).
 * @param {'pre'|'post'} phase
 */
export function workPageWords(phase) {
  const post = phase === 'post'
  return {
    post,
    name: post ? 'Post-work' : 'Pre-work',
    lower: post ? 'post-work' : 'pre-work',
    eyebrow: post ? 'After the session' : '',
    heading: post ? 'After the session' : 'Before the session',
    closesWord: post ? 'open until' : 'closes',
    askHint: post
      ? 'Not sure what is meant? Ask here. The speaker reads your question. Nobody else sees it.'
      : 'Stuck, or not sure what is meant? Ask here. The speaker reads questions before the session and answers them in it. Nobody else sees yours.',
    taskHint: post
      ? 'When you have done it, mark it done. Stuck? Ask about it: the speaker reads every question.'
      : 'When you have done it, mark it done. Stuck? Ask about it: the speaker reads questions before the session.',
    saved: 'Saved. You can change it until ' + (post ? 'post-work' : 'pre-work') + ' closes.',
    checkSaved: post ? 'Saved. You can change it until post-work closes.' : 'Saved. You will see how everyone answered in the session.',
    // Where an answer goes (2026-10-19 prework-responses design, mockups 02 to 04).
    sentTitle: 'Sent to the speaker',
    sentBody: post
      ? 'They read your answer after the session. They see it without your name. Some answers may be shown on a slide, still without names.'
      : 'They read your answer before the session. They see it without your name. Some answers may be shown on a slide, still without names.',
    localTitle: 'Only on this phone',
    localBody: 'The speaker will not see this. It is just for you.',
    thanks: post ? 'The speaker reads every answer.' : 'The speaker reads your answers before the session; some will be on the slides on the day.',
    notYet: post ? 'Post-work opens after the session.' : 'Pre-work has not opened yet.',
  }
}

/**
 * The Worker's status for this page, or null when the answer is not one. A status for the other phase
 * (an id from another page) reads as not available.
 * @param {unknown} value @param {'pre'|'post'} phase
 * @returns {{ state: 'not_yet'|'open'|'closed'|'unavailable', opensAt: number, closesAt: number, people?: number } | null}
 */
export function workPageStatus(value, phase) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const state = value.state
  if (state !== 'not_yet' && state !== 'open' && state !== 'closed') return null
  if (!Number.isSafeInteger(value.opensAt) || !Number.isSafeInteger(value.closesAt)) return null
  if (value.phase !== undefined && value.phase !== (phase === 'post' ? 'post' : 'pre')) return { state: 'unavailable', opensAt: 0, closesAt: 0 }
  const status = { state, opensAt: value.opensAt, closesAt: value.closesAt }
  if (Number.isSafeInteger(value.people) && value.people >= 0) status.people = value.people
  return status
}

/**
 * Ask the Worker for this page's status. Resolves { status } (null when the answer could not be read)
 * or { unavailable: true } (withdrawn or unknown: "This page is not available") or { unreachable: true }.
 * @param {any} fetchImpl @param {{ workerBaseUrl: string, preworkId: string, phase: 'pre'|'post' }} config
 */
export function workPageFetchStatus(fetchImpl, config) {
  const url = String(config.workerBaseUrl || '').replace(/\/+$/, '') + '/prework/' + encodeURIComponent(String(config.preworkId || ''))
  return Promise.resolve().then(() => fetchImpl(url, { cache: 'no-store', credentials: 'omit' })).then((response) => {
    if (response.status === 404 || response.status === 410) return { unavailable: true }
    if (!response.ok) return { unreachable: true }
    return response.json().then((body) => {
      const status = workPageStatus(body, config.phase)
      return status ? (status.state === 'unavailable' ? { unavailable: true } : { status }) : { unreachable: true }
    }, () => ({ unreachable: true }))
  }, () => ({ unreachable: true }))
}

/**
 * A link the page may show for the session handout: an http(s) address or a path on the same site;
 * '' for anything else.
 * @param {unknown} value
 */
export function workPageHandoutHref(value) {
  if (typeof value !== 'string' || value.length > 2000) return ''
  if (/^https?:\/\/[^\s"'<>\\]+$/i.test(value)) return value
  if (/^(?:\/(?!\/)|\.\.?\/)[^\s"'<>\\:]*$/.test(value)) return value
  return ''
}

/** The handout's address as the rail shows it: without the scheme. @param {string} href */
export function workPageShownAddress(href) {
  return String(href || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '')
}

export function workPagePartsSource() {
  return [workPageIcons, workPagePlayerUrl, workPageActivateMedia, workPageRenderMermaid, workPageSlideLines, workPageWords, workPageStatus,
    workPageFetchStatus, workPageHandoutHref, workPageShownAddress].map((fn) => fn.toString()).join('\n')
}
