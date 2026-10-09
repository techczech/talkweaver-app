// Shared talk, ticket 04: the colleague's page. Turns the share-no-notes handout into the LOCKED
// Margin design (docs/design/2026-09-28-shared-talk/LOCKED-colleague-page.html): slide list
// left, slide centre with Slide / Thumbnails, one right-hand margin with Note, Propose slide
// text, and the two outline proposals (delete, new slide with an optional new section).
//
// The handout runtime calls createSharedTalkPage once with a small host (its slides, go, render,
// the clone fitter) and tells it on every render which slide is current. The page is inert when
// the worker's config block (#tw-shared-talk-config) is absent, so a local build shows the
// plain handout. All wire and device logic lives in shared-talk-core.js behind the client.

import {
  sharedTalkLineDiff, sharedTalkSameText, sharedTalkFingerprint, sharedTalkNewItemId, sharedTalkCompareSlides,
  sharedTalkRelativeTime, sharedTalkClock, createSharedTalkStore, sharedTalkPermanentError, sharedTalkRetryDelay,
  createSharedTalkClient, sharedTalkEscape, sharedTalkInline, sharedTalkMarkdownSlide,
} from './shared-talk-core.js'
import { sharedTalkBrowserTransport } from './shared-talk-transport.js'

export const SHARED_TALK_ICON = {
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 9v6M9 12h6"/></svg>',
  slide: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="7" height="7"/><rect x="14" y="4" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
}

export function createSharedTalkPage(options) {
  const doc = options.document
  const win = options.window
  const host = options.host
  const configEl = doc.getElementById('tw-shared-talk-config')
  if (!configEl) return null
  let config = null
  try { config = JSON.parse(configEl.textContent || 'null') } catch {}
  if (!config || typeof config.shareId !== 'string' || typeof config.api !== 'string') return null
  const features = { proposals: true, ownerName: '', ...(options.features || {}) }
  let storage = options.storage
  if (storage === undefined) { try { storage = win.localStorage } catch { storage = null } }
  let session = null
  try { session = win.sessionStorage } catch {}
  const store = createSharedTalkStore(storage, config.shareId)
  const transport = options.transport || sharedTalkBrowserTransport(win, config)
  const now = options.now || (() => Date.now())
  const shell = doc.querySelector('.share-shell')
  const stageFit = doc.getElementById('stageFit')
  if (!shell || !stageFit) return null

  // ---- state ------------------------------------------------------------------------------
  const pristine = new Map()
  host.slides().forEach((slide, i) => pristine.set(slide.dataset.id || '', host.pristineHtml(i)))
  let talk = { revision: Number(config.revision) || 0, updatedAt: null, title: '', slides: [] }
  let textById = new Map()
  let talkLoaded = false
  let view = 'slide'
  try { if (session?.getItem('tw-st-view:' + config.shareId) === 'grid') view = 'grid' } catch {}
  let ghostFor = null
  let railSlideId = null
  let refreshing = false
  let refreshAgain = false
  let refreshTimer = null
  let lastUpdateAt = null

  const owner = features.ownerName || ownerFromTitleSlide() || 'the speaker'
  const ownerCap = owner.charAt(0).toUpperCase() + owner.slice(1)
  const ownerPossessive = owner + (/s$/i.test(owner) ? "'" : "'s")

  function ownerFromTitleSlide() {
    const who = doc.querySelector('.slide[data-role="opening"] .tp-who')
    const name = who ? (who.textContent || '').trim().split(/\s+/)[0] : ''
    return name && name.length <= 40 ? name : ''
  }

  // ---- small DOM helpers ------------------------------------------------------------------
  function el(tag, attrs, children) {
    const node = doc.createElement(tag)
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue
      if (key === 'class') node.className = value
      else if (key === 'text') node.textContent = value
      else if (key === 'html') node.innerHTML = value
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
      else node.setAttribute(key, value === true ? '' : String(value))
    }
    for (const child of [].concat(children || [])) if (child != null && child !== false) node.append(child)
    return node
  }
  const slidesNow = () => host.slides()
  const slideIdAt = (i) => slidesNow()[i]?.dataset.id || ''
  const indexOfId = (id) => slidesNow().findIndex((slide) => slide.dataset.id === id)
  const titleOf = (i) => {
    const slide = slidesNow()[i]
    const talkSlide = talk.slides.find((entry) => entry.slideId === slide?.dataset.id)
    return slide?.dataset.navLabel || slide?.dataset.navTitle || talkSlide?.title || slide?.querySelector('h1,h2')?.textContent || 'Untitled'
  }
  const currentId = () => slideIdAt(host.currentIndex())
  const proposable = (id) => features.proposals && textById.has(id)
  const fingerprintOf = (id) => sharedTalkFingerprint(pristine.get(id) || '')
  const updatedSince = (id) => store.hasBaseline() && store.seen(id) !== fingerprintOf(id)

  function itemsFor(id) {
    return store.items().filter((item) => item.slideId === id || item.afterSlideId === id)
  }
  function isLive(item) { return item.state === 'sent' && item.status !== 'dismissed' }

  // ---- regions ----------------------------------------------------------------------------
  const centreBg = el('div', { class: 'tw-st-centre-bg', 'aria-hidden': 'true' })
  const list = el('nav', { class: 'tw-st-list', 'aria-label': 'Slides' })
  const top = el('div', { class: 'tw-st-top', role: 'status', 'aria-live': 'polite' })
  const banner = el('div', { class: 'tw-st-banner', hidden: true })
  const grid = el('div', { class: 'tw-st-grid', hidden: true, 'aria-label': 'Thumbnails' })
  const ghostInner = el('div', { class: 'tw-st-ghostinner' })
  const ghostCanvas = el('div', { class: 'tw-st-ghostcanvas' }, [ghostInner])
  const ghostFit = el('div', { class: 'tw-st-ghostfit', hidden: true, 'aria-label': 'Your proposed new slide' }, [ghostCanvas])
  const rail = el('aside', { class: 'tw-st-rail', 'aria-label': 'Your comments' })
  const topText = el('span', { class: 'tw-st-toptext' })
  const liveDot = el('span', { class: 'tw-st-live', 'aria-hidden': 'true' })
  const slideBtn = el('button', { type: 'button', 'aria-pressed': 'true', html: SHARED_TALK_ICON.slide + 'Slide', onclick: () => setView('slide') })
  const gridBtn = el('button', { type: 'button', 'aria-pressed': 'false', html: SHARED_TALK_ICON.grid + 'Thumbnails', onclick: () => setView('grid') })
  top.append(liveDot, topText, el('div', { class: 'tw-st-viewtog', role: 'group', 'aria-label': 'View' }, [slideBtn, gridBtn]))
  const phonePos = el('span', { class: 'tw-st-ppos' })
  doc.getElementById('phoneBar')?.append(phonePos)

  shell.prepend(centreBg, list)
  stageFit.before(top, banner)
  stageFit.after(grid, ghostFit)
  shell.append(rail)
  doc.body.classList.add('tw-st')
  // Enter and Space on the page's own buttons must not also step the slides.
  for (const region of [list, top, grid, rail]) {
    region.addEventListener('keydown', (event) => {
      const tag = event.target?.tagName
      if (tag === 'BUTTON' && (event.key === 'Enter' || event.key === ' ')) event.stopPropagation()
    })
  }

  // ---- the client -------------------------------------------------------------------------
  const client = createSharedTalkClient({
    store,
    transport,
    now,
    revision: talk.revision,
    schedule: (fn, ms) => win.setTimeout(fn, ms),
    cancel: (id) => win.clearTimeout(id),
    onChange: (reason) => {
      renderTop()
      renderList()
      if (reason === 'online' && !talkLoaded) void loadTalk()
      if (reason !== 'online' && reason !== 'offline') { renderRail(true); renderGrid(); renderBanner() }
      else renderOffline()
    },
    onTalkUpdated: () => { void refreshTalk() },
  })

  // ---- talk.json and talk.updated ---------------------------------------------------------
  function applyTalkJson(json) {
    if (!json || !Array.isArray(json.slides)) return
    talk = { revision: Number(json.revision) || talk.revision, updatedAt: json.updatedAt ?? null, title: json.title || '', slides: json.slides }
    textById = new Map(json.slides.map((slide) => [slide.slideId, String(slide.text ?? '')]))
    talkLoaded = true
    if (Number.isFinite(json.updatedAt)) lastUpdateAt = json.updatedAt
    client.setRevision(talk.revision)
  }

  async function loadTalk() {
    try {
      applyTalkJson(await transport.fetchTalk())
    } catch { return }
    renderAll()
  }

  async function refreshTalk() {
    if (refreshing) { refreshAgain = true; return }
    refreshing = true
    let failed = false
    try {
      const [json, html] = await Promise.all([transport.fetchTalk(), transport.fetchPage()])
      const parsed = new win.DOMParser().parseFromString(html, 'text/html')
      const fresh = Array.from(parsed.querySelectorAll('section[data-share-index]'))
      const next = fresh.map((section) => ({ slideId: section.getAttribute('data-id') || '', html: section.outerHTML, section }))
      const previous = slidesNow().map((slide) => ({ slideId: slide.dataset.id || '', html: pristine.get(slide.dataset.id || '') || '' }))
      const { structural, changed } = sharedTalkCompareSlides(previous, next)
      if (structural) {
        // Slides were added, removed or moved: the handout's own list, overview and phone view
        // are built once, so load the new page. Drafts and items live on the device, the hash
        // keeps their slide, and the page opens with the fresh "Updated" line.
        try { session?.setItem('tw-st-view:' + config.shareId, view) } catch {}
        ;(options.reload || (() => win.location.reload()))()
        return
      }
      for (const id of changed) {
        const target = slidesNow()[indexOfId(id)]
        const source = next.find((entry) => entry.slideId === id)
        if (!target || !source) continue
        for (const attr of Array.from(target.attributes)) target.removeAttribute(attr.name)
        for (const attr of Array.from(source.section.attributes)) target.setAttribute(attr.name, attr.value)
        target.replaceChildren(...Array.from(source.section.childNodes, (node) => doc.importNode(node, true)))
        pristine.set(id, source.html)
      }
      applyTalkJson(json)
      lastUpdateAt = now()
      if (changed.length) host.render()
      if (changed.includes(currentId())) store.markSeen(currentId(), fingerprintOf(currentId()))
      railSlideId = null
      renderAll()
    } catch {
      failed = true
    } finally {
      refreshing = false
      if (refreshAgain) { refreshAgain = false; void refreshTalk() }
      else if (failed && refreshTimer == null) refreshTimer = win.setTimeout(() => { refreshTimer = null; void refreshTalk() }, 5000)
    }
  }

  // ---- top bar, banner --------------------------------------------------------------------
  function renderTop() {
    const status = client.status()
    liveDot.className = 'tw-st-live' + (status.closed ? ' stopped' : status.offline ? ' off' : '')
    if (status.closed) topText.textContent = 'Sharing has stopped. What you wrote is kept on this device.'
    else if (status.offline) topText.textContent = (lastUpdateAt ? 'Last update ' + sharedTalkClock(lastUpdateAt) + ' · ' : '') + 'waiting for the connection'
    else topText.textContent = (lastUpdateAt ? 'Updated ' + sharedTalkRelativeTime(lastUpdateAt, now()) + ' · ' : '') + 'following ' + ownerPossessive + ' saves'
    slideBtn.setAttribute('aria-pressed', String(view === 'slide'))
    gridBtn.setAttribute('aria-pressed', String(view === 'grid'))
    phonePos.textContent = (host.currentIndex() + 1) + ' / ' + slidesNow().length
  }

  function renderBanner() {
    const id = currentId()
    banner.hidden = true
    banner.className = 'tw-st-banner'
    if (view !== 'slide') return
    if (ghostFor && ghostFor === id) {
      const draft = store.draft('insert:' + id) || {}
      const section = draft.sectionOn && String(draft.section || '').trim()
      banner.className = 'tw-st-banner new'
      banner.innerHTML = SHARED_TALK_ICON.plus
      banner.append('Draft · your proposed new slide, after slide ' + (host.currentIndex() + 1) + (section ? ', opening the section “' + section + '”' : ''))
      banner.hidden = false
      return
    }
    const deletion = store.items().filter((item) => item.kind === 'delete' && item.slideId === id && item.state !== 'failed').pop()
    if (!deletion || deletion.status === 'dismissed') return
    banner.innerHTML = SHARED_TALK_ICON.trash
    if (deletion.status === 'accepted') banner.append(ownerCap + ' accepted deleting this slide. It goes from the talk with the next save.')
    else banner.append('You proposed deleting this slide. It stays in ' + ownerPossessive + ' talk until ' + owner + ' accepts.')
    banner.hidden = false
  }

  // ---- the draft new slide in the centre --------------------------------------------------
  function renderGhost() {
    const id = currentId()
    const draft = ghostFor === id ? store.draft('insert:' + id) : null
    const show = Boolean(draft && draft.open && view === 'slide')
    ghostFit.hidden = !show
    stageFit.hidden = show || view === 'grid'
    if (!show) { host.setCount?.(null); return }
    const preview = sharedTalkMarkdownSlide(draft.text || '', draft.sectionOn ? draft.section : '')
    const section = el('section', { class: 'slide active', 'data-layout': 'list', 'data-role': 'content', html: preview.html })
    ghostInner.replaceChildren(section)
    host.setCount?.('draft after ' + (host.currentIndex() + 1))
    fitGhost()
    win.requestAnimationFrame?.(() => { fitGhost(); host.fitClone(section) })
  }
  function fitGhost() {
    const w = ghostFit.clientWidth - 4
    const h = (ghostFit.clientHeight || Math.round(ghostFit.clientWidth * 9 / 16)) - 4
    const scale = Math.min(w / 1280, h / 720)
    if (!(scale > 0)) return
    ghostCanvas.style.width = Math.round(1280 * scale) + 'px'
    ghostCanvas.style.height = Math.round(720 * scale) + 'px'
    ghostCanvas.style.left = Math.max(0, Math.round((w - 1280 * scale) / 2)) + 'px'
    ghostCanvas.style.top = Math.max(0, Math.round((h - 720 * scale) / 2)) + 'px'
    ghostInner.style.transform = 'scale(' + scale + ')'
  }

  // ---- marks shared by the list and the grid ----------------------------------------------
  function marksFor(id, detailed) {
    const marks = []
    const items = itemsFor(id)
    if (updatedSince(id)) marks.push({ cls: 'upd', text: 'updated' })
    const deletion = items.find((item) => item.kind === 'delete' && item.state === 'sent')
    if (deletion) marks.push({ cls: 'del', text: deletion.status === 'accepted' ? 'deletion accepted' : 'deletion sent' })
    const sent = items.filter((item) => item.kind !== 'delete' && item.state === 'sent')
    if (detailed) {
      const count = (kind, label) => {
        const n = sent.filter((item) => item.kind === kind).length
        if (n) marks.push({ cls: 'sent', text: n + ' ' + label + (n === 1 ? '' : 's') + ' sent' })
      }
      count('note', 'note'); count('replace', 'edit'); count('insert', 'new slide')
    } else if (sent.length) marks.push({ cls: 'sent', text: sent.length + ' sent' })
    const kept = items.filter((item) => item.state === 'queued').length
    if (kept) marks.push({ cls: 'kept', text: kept + ' kept on device' })
    if (detailed) {
      if (String(store.draft('note:' + id)?.text || '').trim()) marks.push({ cls: 'draft', text: 'draft note' })
      const replace = store.draft('replace:' + id)
      if (replace && !sharedTalkSameText(replace.text, textById.get(id) ?? replace.baseText)) marks.push({ cls: 'draft', text: 'draft edit' })
      if (store.draft('delete:' + id)?.open) marks.push({ cls: 'draft', text: 'draft deletion' })
    }
    return marks
  }
  function markEls(marks) { return marks.map((mark) => el('span', { class: 'tw-st-mk ' + mark.cls, text: mark.text })) }
  function insertDraftAfter(id) {
    const draft = store.draft('insert:' + id)
    return draft && draft.open ? draft : null
  }

  // ---- left list ----------------------------------------------------------------------------
  function renderList() {
    const cur = host.currentIndex()
    const rows = [
      el('h2', { class: 'tw-st-title', text: talk.title || doc.querySelector('meta[name="deck-title"]')?.getAttribute('content') || doc.title }),
      el('div', { class: 'tw-st-by', text: ownerCap + ' · shared for comments' }),
    ]
    slidesNow().forEach((slide, i) => {
      const id = slide.dataset.id || ''
      const onReal = i === cur && ghostFor !== id
      rows.push(el('button', {
        type: 'button', class: 'tw-st-row' + (onReal ? ' on' : ''), 'data-slide-id': id, 'aria-current': onReal ? 'true' : null,
        onclick: () => { ghostFor = null; host.go(i); if (view === 'slide') renderAllForSlide() },
      }, [el('span', { class: 'n', text: String(i + 1) }), el('span', { class: 't', text: titleOf(i) }), el('span', { class: 'tw-st-marks' }, markEls(marksFor(id, false)))]))
      const draft = insertDraftAfter(id)
      if (draft) {
        if (draft.sectionOn && String(draft.section || '').trim()) rows.push(el('div', { class: 'tw-st-sec', text: 'New section · ' + draft.section.trim() }))
        const title = sharedTalkMarkdownSlide(draft.text || '').title || 'New slide'
        rows.push(el('button', {
          type: 'button', class: 'tw-st-row ghost' + (ghostFor === id && i === cur ? ' on' : ''), 'data-ghost-after': id,
          onclick: () => { ghostFor = id; setView('slide'); host.go(i); renderAllForSlide() },
        }, [el('span', { class: 'n', text: '＋' }), el('span', { class: 't', text: title }), el('span', { class: 'tw-st-marks' }, [el('span', { class: 'tw-st-mk draft', text: 'draft' })])]))
      }
    })
    rows.push(el('div', { class: 'tw-st-foot', text: 'Comments go to ' + owner + ', each one shown against the slide it belongs to.' }))
    list.replaceChildren(...rows)
    // The phone list is the handout's own; give its rows the same marks.
    doc.querySelectorAll('#phoneList .pslide-row').forEach((row) => {
      const id = slideIdAt(Number(row.dataset.index))
      const label = row.querySelector('.pslide-label')
      if (!label) return
      label.querySelector('.tw-st-pslide-marks')?.remove()
      const marks = marksFor(id, false)
      if (marks.length) label.append(el('span', { class: 'tw-st-pslide-marks' }, markEls(marks)))
    })
  }

  // ---- thumbnails grid (the handout's Overview thumbnails, with their marks) ----------------
  function thumbCanvas(content) {
    const inner = el('div', { class: 'tw-st-tinner' }, [content])
    return el('div', { class: 'tw-st-canvas' }, [inner])
  }
  function cloneForThumb(slide) {
    const clone = slide.cloneNode(true)
    clone.classList.add('active')
    clone.removeAttribute('id')
    clone.querySelectorAll('iframe, video, audio, .notes').forEach((node) => node.remove())
    return clone
  }
  function renderGrid() {
    grid.hidden = view !== 'grid'
    if (view !== 'grid') return
    const cur = host.currentIndex()
    const tiles = []
    slidesNow().forEach((slide, i) => {
      const id = slide.dataset.id || ''
      const clone = cloneForThumb(slide)
      tiles.push(el('div', { class: 'tw-st-tile' + (i === cur ? ' sel' : ''), 'data-slide-id': id }, [
        el('button', { type: 'button', class: 'tw-st-tbtn', 'aria-label': 'Slide ' + (i + 1) + ': ' + titleOf(i), onclick: () => { ghostFor = null; host.go(i) } }, [
          thumbCanvas(clone),
          el('div', { class: 'tw-st-tcap' }, [el('span', { class: 'n', text: String(i + 1) }), el('span', { text: titleOf(i) })]),
        ]),
        el('div', { class: 'tw-st-tmarks' }, markEls(marksFor(id, true))),
        proposable(id) ? el('button', {
          type: 'button', class: 'tw-st-slot', 'data-slot-after': id, 'aria-label': 'Propose a new slide after slide ' + (i + 1),
          onclick: () => openInsert(i),
        }, [el('i', { text: '+' }), el('span', { class: 'tip', text: 'New slide after ' + (i + 1) })]) : null,
      ]))
      const draft = insertDraftAfter(id)
      if (draft) {
        const preview = sharedTalkMarkdownSlide(draft.text || '', draft.sectionOn ? draft.section : '')
        const section = el('section', { class: 'slide active', 'data-layout': 'list', html: preview.html })
        tiles.push(el('div', { class: 'tw-st-tile ghost', 'data-ghost-after': id }, [
          el('button', { type: 'button', class: 'tw-st-tbtn', onclick: () => { ghostFor = id; setView('slide'); host.go(i); renderAllForSlide() } }, [
            thumbCanvas(section),
            el('div', { class: 'tw-st-tcap' }, [el('span', { class: 'n', text: '＋' }), el('span', { text: preview.title || 'New slide' })]),
          ]),
          draft.sectionOn && String(draft.section || '').trim() ? el('div', { class: 'tw-st-tsec', text: 'New section · ' + draft.section.trim() }) : null,
          el('div', { class: 'tw-st-tmarks' }, [el('span', { class: 'tw-st-mk draft', text: 'draft · new slide' })]),
        ]))
      }
    })
    grid.replaceChildren(...tiles)
    scaleThumbs()
    win.requestAnimationFrame?.(() => {
      scaleThumbs()
      grid.querySelectorAll('.tw-st-tinner > .slide').forEach((slide) => host.fitClone(slide))
    })
  }
  function scaleThumbs() {
    grid.querySelectorAll('.tw-st-canvas').forEach((canvas) => {
      const w = canvas.clientWidth
      if (w) canvas.firstChild.style.transform = 'scale(' + (w / 1280) + ')'
    })
  }
  if (win.ResizeObserver) new win.ResizeObserver(() => { scaleThumbs(); fitGhost() }).observe(shell)

  function setView(next) {
    if (view === next) { renderTop(); return }
    view = next
    try { session?.setItem('tw-st-view:' + config.shareId, view) } catch {}
    if (view === 'grid') { stageFit.hidden = true; ghostFit.hidden = true }
    else stageFit.hidden = false
    renderTop(); renderGrid(); renderBanner(); renderGhost(); host.fitStage()
  }

  // ---- the margin ---------------------------------------------------------------------------
  function receipt(item) {
    const index = indexOfId(item.kind === 'insert' ? item.afterSlideId : item.slideId)
    const where = index < 0 ? 'a slide since removed' : (item.kind === 'insert' ? 'after slide ' : 'slide ') + (index + 1)
    let cls = 'tw-st-receipt' + (item.kind === 'delete' ? ' del' : '')
    let meta
    if (item.state === 'queued') {
      const status = client.status()
      cls += ' kept'
      meta = status.offline ? 'Kept on this device · sends when the connection is back' : 'Sending…'
    } else if (item.state === 'failed') {
      cls += ' failed'
      meta = 'Not sent: ' + (item.error === 'share_full' ? 'this share takes no more comments' : item.error === 'item_too_large' ? 'too long' : 'the share refused it') + ' · kept on this device'
    } else {
      const sentAt = '✓ Sent ' + sharedTalkClock(item.sentAt || item.createdAt) + ' · ' + where + ' · '
      if (item.status === 'accepted') { cls += ' accepted'; meta = sentAt + 'accepted by ' + owner + (item.statusAt ? ' ' + sharedTalkClock(item.statusAt) : '') }
      else if (item.status === 'dismissed') { cls += ' dismissed'; meta = 'Sent ' + sharedTalkClock(item.sentAt || item.createdAt) + ' · ' + where + ' · dismissed by ' + owner }
      else if (item.status === 'done') { cls += ' done'; meta = sentAt + 'marked done by ' + owner }
      else meta = sentAt + (item.kind === 'note' ? 'kept if you close this tab' : 'waiting for ' + owner)
    }
    const body = []
    if (item.kind === 'note') body.push(el('div', { class: 'rt', text: item.text }))
    else if (item.kind === 'replace') {
      const lines = String(item.text || '').split('\n').filter((line) => line.trim()).length
      body.push(el('div', { class: 'rt', text: 'Your rewording of this slide, ' + lines + ' line' + (lines === 1 ? '' : 's') + '.' }))
    } else if (item.kind === 'delete') {
      body.push(el('div', { class: 'rt', html: '<b>Delete this slide</b>' }))
      if (item.reason) body.push(el('div', { class: 'rr', text: 'Reason: ' + item.reason }))
    } else {
      const title = sharedTalkMarkdownSlide(item.text).title
      body.push(el('div', { class: 'rt', html: '<b>New slide after this one</b>' + (title ? ' · ' + sharedTalkEscape(title) : '') }))
      if (item.section) body.push(el('div', { class: 'rr', text: 'Opens the section “' + item.section + '”' }))
    }
    body.push(el('div', { class: 'rm', text: meta }))
    return el('div', { class: cls, 'data-item-id': item.itemId, 'data-kind': item.kind, 'data-state': item.state, 'data-status': item.status }, body)
  }

  function saveDraftOnInput(node, key, shape) {
    node.addEventListener('input', () => {
      const value = shape(node.value)
      store.setDraft(key, value)
      afterDraftInput(key)
    })
  }
  function afterDraftInput(key) {
    if (key.startsWith('insert:')) { renderGhost(); renderBanner() }
    renderList()
    if (view === 'grid') renderGrid()
  }

  function nameBlock() {
    const input = el('input', { type: 'text', placeholder: 'optional', autocomplete: 'name', 'data-focus-key': 'name', maxlength: '80', 'aria-label': 'Your name' })
    input.value = store.name()
    const hint = el('div', { class: 'tw-st-namehint' })
    const hintText = () => {
      const name = input.value.trim()
      hint.textContent = 'Shown to ' + owner + ' as “' + (name || 'Colleague') + '”. Remembered on this device.'
    }
    hintText()
    input.addEventListener('input', () => { store.setName(input.value); hintText(); renderSentAs() })
    return el('div', { class: 'tw-st-name-wrap' }, [el('label', { class: 'tw-st-namef' }, ['Your name ', input]), hint])
  }
  const sentAsLine = el('div', { class: 'tw-st-small tw-st-phone-only', style: 'margin-top:8px' })
  function renderSentAs() {
    const name = store.name().trim()
    sentAsLine.replaceChildren('Sent as “' + (name || 'Colleague') + '”. ', el('button', {
      type: 'button', class: 'tw-st-link', text: name ? 'Change your name' : 'Add your name',
      onclick: () => { rail.classList.add('name-open'); rail.querySelector('[data-focus-key="name"]')?.focus() },
    }))
  }

  function noteSection(id, i) {
    const sent = store.items().filter((item) => item.kind === 'note' && item.slideId === id)
    const ta = el('textarea', { class: 'tw-st-ta note', 'data-focus-key': 'note:' + id, 'aria-label': 'Note for ' + owner + ' about slide ' + (i + 1), placeholder: sent.length ? 'Add another note…' : 'Add a note…', rows: '2' })
    ta.value = store.draft('note:' + id)?.text || ''
    const send = el('button', { type: 'button', class: 'tw-st-send tw-st-note-send', text: 'Send note' })
    const sync = () => { send.disabled = !ta.value.trim(); send.hidden = !ta.value.trim() && !win.matchMedia?.('(max-width: 699px)').matches }
    sync()
    saveDraftOnInput(ta, 'note:' + id, (value) => (value ? { text: value } : null))
    ta.addEventListener('input', sync)
    send.addEventListener('click', () => {
      const text = ta.value.trim()
      if (!text) return
      store.setDraft('note:' + id, null)
      client.send({ kind: 'note', slideId: id, text })
    })
    return el('div', { class: 'tw-st-sec3 tw-st-note-sec' }, [
      el('h3', {}, ['Note ', el('span', { text: 'for ' + owner + ', about this slide' })]),
      ...sent.map(receipt), ta, send,
    ])
  }

  function replaceSection(id) {
    const sent = store.items().filter((item) => item.kind === 'replace' && item.slideId === id)
    const current = textById.get(id) ?? ''
    const draft = store.draft('replace:' + id)
    const children = [el('h3', {}, ['Propose slide text ', el('span', { text: 'a proposal, not a change' })]), ...sent.map(receipt)]
    const editorOpen = !sent.length || Boolean(draft)
    if (!editorOpen) {
      children.push(el('button', { type: 'button', class: 'tw-st-link', text: 'Propose another wording', onclick: () => {
        store.setDraft('replace:' + id, { text: current, baseText: current, baseRevision: talk.revision, open: true })
        renderRail(true)
        rail.querySelector('[data-focus-key="replace:' + id + '"]')?.focus()
      } }))
      return el('div', { class: 'tw-st-sec3' }, children)
    }
    const baseText = draft ? draft.baseText : current
    const ta = el('textarea', { class: 'tw-st-ta md', 'data-focus-key': 'replace:' + id, spellcheck: 'true', 'aria-label': 'Your proposed text for this slide', rows: String(Math.min(14, Math.max(4, baseText.split('\n').length + 1))) })
    ta.value = draft ? draft.text : current
    const below = el('div', {})
    const paint = () => {
      const text = ta.value
      const dirty = !sharedTalkSameText(text, baseText)
      const parts = []
      if (draft && draft.baseRevision < talk.revision && !sharedTalkSameText(baseText, current)) {
        parts.push(el('div', { class: 'tw-st-flag', text: ownerCap + ' has changed this slide since you started. Your text is kept, and ' + owner + ' sees it against both versions.' }))
      }
      if (!dirty) {
        parts.push(el('div', { class: 'tw-st-small', style: 'margin-top:6px', text: 'No changes yet. Edit the text to see the diff ' + owner + ' will get.' }))
        if (draft) parts.push(el('div', { class: 'tw-st-row2' }, [el('button', { type: 'button', class: 'tw-st-send ghost', text: 'Cancel', onclick: resetReplace })]))
      } else {
        const diff = el('div', { class: 'tw-st-diff', 'aria-label': 'Changes against the slide' })
        for (const line of sharedTalkLineDiff(baseText, text)) {
          if (line.op === 'del') diff.append(el('div', { class: 'd' }, [el('span', { text: line.text })]))
          else if (line.op === 'add') diff.append(el('div', { class: 'a', text: line.text }))
          else diff.append(el('div', { class: 'c', text: line.text }))
        }
        parts.push(el('div', { class: 'tw-st-diffcap', text: 'What ' + owner + ' will see against the slide:' }), diff,
          el('div', { class: 'tw-st-row2' }, [
            el('button', { type: 'button', class: 'tw-st-send', text: 'Send proposal', 'data-action': 'send-replace', onclick: () => {
              const value = ta.value.replace(/\s+$/, '')
              if (!value.trim()) return
              const baseRevision = draft ? draft.baseRevision : talk.revision
              store.setDraft('replace:' + id, null)
              client.send({ kind: 'replace', slideId: id, baseRevision: Math.max(1, baseRevision), text: value })
            } }),
            el('button', { type: 'button', class: 'tw-st-send ghost', text: 'Reset to the slide’s text', onclick: resetReplace }),
          ]),
          el('div', { class: 'tw-st-small', style: 'margin-top:7px', text: ownerCap + ' accepts it or leaves it. The slide does not change until then.' }))
      }
      below.replaceChildren(...parts)
    }
    function resetReplace() { store.setDraft('replace:' + id, null); renderRail(true); afterDraftInput('replace:' + id) }
    ta.addEventListener('input', () => {
      const value = ta.value
      const existing = store.draft('replace:' + id)
      const base = existing ? existing.baseText : current
      const baseRevision = existing ? existing.baseRevision : talk.revision
      // An untouched editor keeps no draft, so his next save flows straight into it.
      store.setDraft('replace:' + id, sharedTalkSameText(value, base) && !(existing && existing.open) ? null : { text: value, baseText: base, baseRevision, open: existing?.open || false })
      if (!existing !== !store.draft('replace:' + id)) { renderRail(true); return }
      paint()
      afterDraftInput('replace:' + id)
    })
    paint()
    children.push(ta, below)
    return el('div', { class: 'tw-st-sec3' }, children)
  }

  function outlineSection(id, i) {
    const children = [el('h3', {}, ['Change the outline ', el('span', { text: 'also proposals' })])]
    const deletions = store.items().filter((item) => item.kind === 'delete' && item.slideId === id)
    children.push(...deletions.map(receipt))
    const liveDeletion = deletions.some((item) => item.state !== 'failed' && item.status !== 'dismissed')
    const delDraft = store.draft('delete:' + id)
    if (!liveDeletion) {
      if (delDraft?.open) {
        const ta = el('textarea', { class: 'tw-st-ta', 'data-focus-key': 'delete:' + id, placeholder: 'Why? (optional)', rows: '2', 'aria-label': 'Reason for deleting this slide, optional' })
        ta.value = delDraft.reason || ''
        saveDraftOnInput(ta, 'delete:' + id, (value) => ({ open: true, reason: value }))
        children.push(el('div', { class: 'tw-st-box del', 'data-box': 'delete' }, [
          el('div', { class: 'tw-st-boxh', html: SHARED_TALK_ICON.trash + 'Propose deleting this slide' }),
          el('div', { class: 'tw-st-small', style: 'margin-top:8px', text: 'Reason, optional' }), ta,
          el('div', { class: 'tw-st-row2' }, [
            el('button', { type: 'button', class: 'tw-st-send', text: 'Send proposal', 'data-action': 'send-delete', onclick: () => {
              const reason = ta.value.trim()
              store.setDraft('delete:' + id, null)
              client.send({ kind: 'delete', slideId: id, baseRevision: Math.max(1, talk.revision), ...(reason ? { reason } : {}) })
            } }),
            el('button', { type: 'button', class: 'tw-st-send ghost', text: 'Cancel', onclick: () => { store.setDraft('delete:' + id, null); renderRail(true); afterDraftInput('delete:' + id) } }),
          ]),
        ]))
      } else {
        children.push(el('button', { type: 'button', class: 'tw-st-rowbtn', 'data-action': 'open-delete', html: SHARED_TALK_ICON.trash + 'Propose deleting this slide<span class="chev">›</span>', onclick: () => {
          store.setDraft('delete:' + id, { open: true, reason: '' })
          renderRail(true); afterDraftInput('delete:' + id)
          rail.querySelector('[data-focus-key="delete:' + id + '"]')?.focus()
        } }))
      }
    }
    children.push(...store.items().filter((item) => item.kind === 'insert' && item.afterSlideId === id).map(receipt))
    const insDraft = store.draft('insert:' + id)
    if (insDraft?.open) children.push(insertBox(id, i, insDraft))
    else children.push(el('button', { type: 'button', class: 'tw-st-rowbtn', 'data-action': 'open-insert', html: SHARED_TALK_ICON.plus + 'Propose a new slide after this one<span class="chev">›</span>', onclick: () => openInsert(i) }))
    return el('div', { class: 'tw-st-sec3' }, children)
  }

  function headingMarker(id) {
    const match = String(textById.get(id) || '').match(/^(#{1,6})\s/m)
    return match ? match[1] + ' ' : ''
  }
  function openInsert(i) {
    const id = slideIdAt(i)
    if (!proposable(id)) return
    if (!store.draft('insert:' + id)?.open) store.setDraft('insert:' + id, { open: true, text: headingMarker(id), sectionOn: false, section: '' })
    ghostFor = id
    if (host.currentIndex() !== i) host.go(i)
    railSlideId = null
    renderAllForSlide()
    rail.classList.add('more-open')
    const ta = rail.querySelector('[data-focus-key="insert:' + id + '"]')
    if (ta) { ta.focus(); ta.setSelectionRange?.(ta.value.length, ta.value.length) }
  }

  function insertBox(id, i, draft) {
    const toggle = el('button', { type: 'button', class: 'tw-st-tog', role: 'switch', 'aria-checked': String(Boolean(draft.sectionOn)), 'aria-label': 'Start a new section', 'data-focus-key': 'insert-section-on:' + id })
    const sectionInput = el('input', { type: 'text', 'data-focus-key': 'insert-section:' + id, maxlength: '200', placeholder: 'Section title', 'aria-label': 'Section title' })
    sectionInput.value = draft.section || ''
    const ta = el('textarea', { class: 'tw-st-ta md', 'data-focus-key': 'insert:' + id, rows: '6', 'aria-label': 'The new slide, in Markdown', placeholder: '## Title of the new slide\n- a point\n- another point' })
    ta.value = draft.text || ''
    const read = () => ({ open: true, text: ta.value, sectionOn: toggle.getAttribute('aria-checked') === 'true', section: sectionInput.value })
    const field = el('label', { class: 'tw-st-field', hidden: !draft.sectionOn }, ['Section title ', sectionInput])
    const send = el('button', { type: 'button', class: 'tw-st-send', text: 'Send proposal', 'data-action': 'send-insert' })
    const sync = () => { send.disabled = !ta.value.replace(/^#+\s*$/, '').trim() || (toggle.getAttribute('aria-checked') === 'true' && !sectionInput.value.trim()) }
    toggle.addEventListener('click', () => {
      const on = toggle.getAttribute('aria-checked') !== 'true'
      toggle.setAttribute('aria-checked', String(on))
      field.hidden = !on
      store.setDraft('insert:' + id, read()); sync(); afterDraftInput('insert:' + id)
      if (on) sectionInput.focus()
    })
    for (const input of [ta, sectionInput]) {
      input.addEventListener('input', () => { store.setDraft('insert:' + id, read()); sync(); afterDraftInput('insert:' + id) })
      input.addEventListener('focus', () => { if (ghostFor !== id) { ghostFor = id; renderGhost(); renderBanner(); renderList() } })
    }
    send.addEventListener('click', () => {
      const value = read()
      const text = value.text.replace(/\s+$/, '')
      if (!text.replace(/^#+\s*$/, '').trim()) return
      const section = value.sectionOn ? value.section.trim() : ''
      if (value.sectionOn && !section) return
      store.setDraft('insert:' + id, null)
      ghostFor = null
      client.send({ kind: 'insert', afterSlideId: id, baseRevision: Math.max(1, talk.revision), text, ...(section ? { section } : {}) })
      renderGhost(); renderBanner()
    })
    sync()
    return el('div', { class: 'tw-st-box', 'data-box': 'insert' }, [
      el('div', { class: 'tw-st-boxh', html: SHARED_TALK_ICON.plus + 'Propose a new slide after this one' }),
      el('div', { class: 'tw-st-swrow tw-st-tog-wrap' }, ['Start a new section', toggle]), field,
      el('div', { class: 'tw-st-small', style: 'margin-top:10px', text: 'The new slide, in Markdown' }), ta,
      el('div', { class: 'tw-st-small tw-st-desk-only', style: 'margin-top:6px', text: 'Shown beside, as it will look.' }),
      el('div', { class: 'tw-st-row2' }, [send, el('button', { type: 'button', class: 'tw-st-send ghost', text: 'Cancel', onclick: () => {
        store.setDraft('insert:' + id, null); ghostFor = null; renderRail(true); renderGhost(); renderBanner(); afterDraftInput('insert:' + id)
      } })]),
    ])
  }

  const offlineNote = el('div', { class: 'tw-st-offline', role: 'status', hidden: true })
  function renderOffline() {
    const status = client.status()
    offlineNote.hidden = !(status.offline && !status.closed)
    offlineNote.textContent = 'You are offline. Your notes are saved here and nothing is lost; they reach ' + owner + ' as soon as the link reconnects.'
    rail.querySelectorAll('.tw-st-receipt.kept .rm').forEach((meta) => {
      meta.textContent = status.offline ? 'Kept on this device · sends when the connection is back' : 'Sending…'
    })
  }

  /** Rebuild the margin; the focused field, its caret and the scroll position survive. */
  function renderRail(force) {
    const i = host.currentIndex()
    const id = slideIdAt(i)
    if (!force && railSlideId === id) return
    const active = doc.activeElement
    const focusKey = active && rail.contains(active) ? active.getAttribute('data-focus-key') : null
    const selection = focusKey && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null
    const scroll = rail.scrollTop
    const sameSlide = railSlideId === id
    railSlideId = id
    const more = [
      proposable(id) ? replaceSection(id) : null,
      proposable(id) ? outlineSection(id, i) : null,
      el('div', { class: 'tw-st-propline', html: '<b>Every one of these is a proposal.</b> ' + sharedTalkEscape(ownerPossessive) + ' outline does not change until one is accepted; you see here which ones were taken.' }),
    ]
    if (!sameSlide) rail.classList.remove('more-open', 'name-open')
    renderSentAs()
    rail.replaceChildren(...[
      el('div', { class: 'tw-st-mr-h tw-st-desk-only', text: 'Your comments · slide ' + (i + 1) }),
      el('div', { class: 'tw-st-mr-t tw-st-desk-only', text: titleOf(i) }),
      el('div', { class: 'tw-st-mr-h tw-st-phone-only', text: 'Note on slide ' + (i + 1) }),
      el('div', { class: 'tw-st-desk-only' }, [nameBlock()]),
      noteSection(id, i),
      sentAsLine,
      el('div', { class: 'tw-st-phone-only' }, [nameBlock()]),
      offlineNote,
      features.proposals && proposable(id) ? el('button', { type: 'button', class: 'tw-st-plink', onclick: () => rail.classList.toggle('more-open') }, [el('span', { text: 'Propose slide text instead' }), el('span', { text: '›' })]) : null,
      el('div', { class: 'tw-st-more' }, more.filter(Boolean)),
    ].filter(Boolean))
    renderOffline()
    if (sameSlide) rail.scrollTop = scroll
    if (focusKey) {
      const target = Array.from(rail.querySelectorAll('[data-focus-key]')).find((node) => node.getAttribute('data-focus-key') === focusKey && node.offsetParent !== null)
      if (target) {
        target.focus({ preventScroll: true })
        if (selection && target.setSelectionRange) { try { target.setSelectionRange(selection[0], selection[1]) } catch {} }
      }
    }
  }

  function renderAllForSlide() {
    renderTop(); renderList(); renderBanner(); renderGhost(); renderRail(false); if (view === 'grid') renderGrid()
  }
  function renderAll() {
    renderTop(); renderList(); renderBanner(); renderGhost(); renderRail(true); renderGrid()
  }

  // ---- start ------------------------------------------------------------------------------
  if (!store.hasBaseline()) store.setBaseline(slidesNow().map((slide) => [slide.dataset.id || '', fingerprintOf(slide.dataset.id || '')]))
  if (view === 'grid') stageFit.hidden = true
  win.setInterval(renderTop, 20000)
  win.addEventListener('online', () => client.retry())
  win.addEventListener('offline', () => client.wentOffline())
  win.addEventListener('resize', () => { if (railSlideId != null) renderOffline() })
  renderAll()
  void loadTalk()
  client.start()

  return {
    /** The handout calls this from render(): the current slide changed or was re-rendered. */
    slideChanged() {
      const id = currentId()
      if (ghostFor && ghostFor !== id) ghostFor = null
      if (id) store.markSeen(id, fingerprintOf(id))
      renderAllForSlide()
    },
    client,
    store,
  }
}

/** Everything the handout needs, as source text injected inside its runtime IIFE. */
export function sharedTalkRuntimeSource() {
  const helpers = [
    sharedTalkLineDiff, sharedTalkSameText, sharedTalkFingerprint, sharedTalkNewItemId, sharedTalkCompareSlides,
    sharedTalkRelativeTime, sharedTalkClock, createSharedTalkStore, sharedTalkPermanentError, sharedTalkRetryDelay,
    createSharedTalkClient, sharedTalkEscape, sharedTalkInline, sharedTalkMarkdownSlide,
    sharedTalkBrowserTransport, createSharedTalkPage,
  ]
  return 'const SHARED_TALK_ICON = ' + JSON.stringify(SHARED_TALK_ICON) + ';\n'
    + helpers.map((fn) => fn.toString()).join('\n')
}
