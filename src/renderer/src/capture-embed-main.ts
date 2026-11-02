// The Capture embed window's page (src/main/live-page-capture-window.ts). App-owned, no preload, no
// IPC: main polls `__twLivePageSlot()` for where the live page goes and what the person pressed, as it
// does a presenter deck's (live-page-policy.ts validateSlotReport, strict), and calls back with fixed
// functions and JSON only: __twCaptureEmbedInit (the slide, page and the views already on the slide),
// __twLivePageState (the page loading / live / failed), __twLivePageCaptured (a press's answer, or a
// saved view to add to the list), __twLivePageViews (the slide's saved views as the talk's text has
// them now, after any surface saved or removed one) and __twLivePageInteract(false) (Esc in the page
// gave the keys back).
// Nothing the page shows is ever read back from the web page itself.
import './capture-embed.css'

type View = { src: string | null; alt: string; mode?: 'view' | 'page'; fresh?: boolean }
type Init = { slideId: string; pageUrl: string; title: string; host: string; views: Array<{ image: string; src: string | null; alt: string }> }

type Win = typeof window & {
  __twLivePageSlot?: () => unknown
  __twLivePageState?: (json: string) => void
  __twLivePageCaptured?: (json: string) => void
  __twLivePageInteract?: (on: boolean) => void
  __twLivePageGallery?: (json: string) => void
  __twLivePageViews?: (json: string) => void
  __twCaptureEmbedInit?: (json: string) => void
}
const w = window as Win

let init: Init | null = null
let captureSeq = 0
let reloadSeq = 0
let mode: 'view' | 'page' = 'view'
let interact = true
let capturing = false
let pageState = 'loading'
const views: View[] = []

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] => {
  const node = Object.assign(document.createElement(tag), props)
  for (const child of children) node.append(child)
  return node
}

const root = document.getElementById('root')!
const title = el('h1', { className: 'ce-title', textContent: 'Capture embed' })
const host = el('div', { className: 'ce-host' })
const viewButton = el('button', { type: 'button', className: 'ce-mode', textContent: 'Visible view' })
const pageButton = el('button', { type: 'button', className: 'ce-mode', textContent: 'Entire page' })
const modes = el('div', { className: 'ce-modes', role: 'radiogroup' }, viewButton, pageButton)
modes.setAttribute('aria-label', 'What Capture takes')
const captureButton = el('button', { type: 'button', className: 'ce-capture', textContent: 'Capture' })
const useButton = el('button', { type: 'button', className: 'ce-quiet', textContent: 'Use the page', hidden: true })
const reloadButton = el('button', { type: 'button', className: 'ce-quiet', textContent: 'Reload page' })
const closeButton = el('button', { type: 'button', className: 'ce-quiet', textContent: 'Close' })
const status = el('p', { className: 'ce-status', role: 'status' })
const hint = el('p', { className: 'ce-hint' })
const live = el('div', { className: 'ce-live' }, el('p', { className: 'ce-live-wait', textContent: 'Opening the page…' }))
const listHeading = el('h2', { className: 'ce-list-heading' })
const list = el('ol', { className: 'ce-list' })
const empty = el('p', { className: 'ce-empty', textContent: 'No saved views on this slide yet. Scroll the page to what you want to keep and press Capture.' })
root.append(
  el('header', { className: 'ce-bar' },
    el('div', { className: 'ce-what' }, title, host),
    modes, captureButton, useButton, reloadButton, closeButton),
  el('div', { className: 'ce-notes' }, status, hint),
  el('main', { className: 'ce-body' }, live, el('aside', { className: 'ce-side' }, listHeading, empty, list))
)

const HINT = {
  view: 'Visible view keeps what the page shows in this window now.',
  page: 'Entire page keeps the whole page as far as it has loaded, from the top. Parts that load only when scrolled to may be blank; pages taller than 16,384 pixels are cut there.'
} as const

function renderControls(): void {
  for (const [button, value] of [[viewButton, 'view'], [pageButton, 'page']] as const) {
    button.setAttribute('role', 'radio')
    button.setAttribute('aria-checked', String(mode === value))
    button.classList.toggle('is-on', mode === value)
  }
  hint.textContent = HINT[mode]
  const ready = !!init && (pageState === 'live' || pageState === 'slow')
  captureButton.disabled = !ready || capturing
  captureButton.textContent = capturing ? 'Capturing…' : 'Capture'
  useButton.hidden = interact
}

function renderList(): void {
  const n = views.length
  listHeading.textContent = n === 0 ? 'Saved views on this slide' : `Saved views on this slide (${n})`
  empty.hidden = n > 0
  list.replaceChildren(...views.map((view, index) => {
    const caption = el('div', { className: 'ce-caption' }, el('span', { textContent: `${index + 1}. ${view.alt || (view.mode === 'page' ? 'Entire page' : 'Saved view')}` }))
    if (view.fresh) caption.append(el('span', { className: 'ce-new', textContent: 'New' }))
    const body = view.src
      ? el('div', { className: 'ce-picture' }, el('img', { src: view.src, alt: view.alt || 'Saved view' }))
      : el('p', { className: 'ce-no-picture', textContent: 'Not shown here (the picture is missing or the list is long). It still shows in the presentation if the picture is in the talk.' })
    return el('li', { className: 'ce-item' }, caption, body)
  }))
}

w.__twCaptureEmbedInit = (json) => {
  let value: Init
  try { value = JSON.parse(json) } catch { return }
  if (!value || typeof value.slideId !== 'string' || typeof value.pageUrl !== 'string') return
  init = value
  title.textContent = value.title || 'Capture embed'
  host.textContent = value.host
  document.title = `Capture embed — ${value.title || value.host}`
  views.length = 0
  for (const v of Array.isArray(value.views) ? value.views : []) {
    views.push({ src: typeof v.src === 'string' && v.src.startsWith('data:image/jpeg;base64,') ? v.src : null, alt: String(v.alt ?? ''), mode: /^Entire page/.test(String(v.alt)) ? 'page' : 'view' })
  }
  renderList()
  renderControls()
}

w.__twLivePageSlot = () => {
  if (!init) return null
  const r = live.getBoundingClientRect()
  return {
    v: 1, slideId: init.slideId, url: init.pageUrl,
    rect: { x: r.left, y: r.top, w: r.width, h: r.height },
    visible: true, interact, reloadSeq, layoutWidth: null,
    captureSeq, gallery: { on: false, index: 0 }, captureMode: mode
  }
}

const STATE_TEXT: Record<string, string> = {
  loading: 'Opening the page…', live: '', slow: 'The page is slow to load.', failed: 'The page could not be shown.', blocked: 'This page cannot be shown.'
}
w.__twLivePageState = (json) => {
  let s: { state?: unknown; message?: unknown }
  try { s = JSON.parse(json) } catch { return }
  pageState = typeof s.state === 'string' ? s.state : 'failed'
  const words = typeof s.message === 'string' && s.message ? s.message : (STATE_TEXT[pageState] ?? '')
  const wait = live.querySelector('.ce-live-wait')
  if (wait) wait.textContent = words || 'Opening the page…'
  if (pageState !== 'live' && words) status.textContent = words
  else if (pageState === 'live' && !capturing && status.dataset.kind !== 'answer') status.textContent = 'Scroll the page, then press Capture.'
  renderControls()
}

w.__twLivePageCaptured = (json) => {
  let a: { ok?: unknown; message?: unknown; add?: { src?: unknown; capturedAt?: unknown; mode?: unknown } }
  try { a = JSON.parse(json) } catch { return }
  if (a.add) {
    const src = typeof a.add.src === 'string' && a.add.src.startsWith('data:image/jpeg;base64,') ? a.add.src : null
    const m = a.add.mode === 'page' ? 'page' : 'view'
    const at = new Date(String(a.add.capturedAt))
    const when = Number.isNaN(at.getTime()) ? '' : `, ${at.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`
    views.push({ src, alt: `${m === 'page' ? 'Entire page' : 'Saved view'}${when}`, mode: m, fresh: true })
    renderList()
    list.lastElementChild?.scrollIntoView({ block: 'nearest' })
    return
  }
  capturing = false
  status.dataset.kind = 'answer'
  status.classList.toggle('is-error', a.ok === false)
  status.textContent = typeof a.message === 'string' ? a.message : (a.ok ? 'Saved.' : 'The view was not saved.')
  renderControls()
}

// <- main: the slide's saved views now ({slideId, url, views}); views null: the slide's views are still
// the ones recorded before the markup, and the list keeps what it showed. "New" stays on the views
// saved from this window.
w.__twLivePageViews = (json) => {
  let a: { slideId?: unknown; url?: unknown; views?: unknown }
  try { a = JSON.parse(json) } catch { return }
  if (!init || a.slideId !== init.slideId || !Array.isArray(a.views)) return
  const fresh = new Set(views.filter((v) => v.fresh && v.src).map((v) => v.src))
  views.length = 0
  for (const v of a.views.slice(0, 60) as Array<{ src?: unknown; alt?: unknown; mode?: unknown }>) {
    const src = typeof v?.src === 'string' && v.src.startsWith('data:image/jpeg;base64,') ? v.src : null
    views.push({ src, alt: String(v?.alt ?? '').slice(0, 200), mode: v?.mode === 'page' ? 'page' : 'view', ...(src && fresh.has(src) ? { fresh: true } : {}) })
  }
  renderList()
}

w.__twLivePageInteract = (on) => { interact = on === true; renderControls() }
w.__twLivePageGallery = () => { /* this window never shows saved views in place of the page */ }

viewButton.addEventListener('click', () => { mode = 'view'; renderControls() })
pageButton.addEventListener('click', () => { mode = 'page'; renderControls() })
captureButton.addEventListener('click', () => {
  if (captureButton.disabled) return
  capturing = true
  delete status.dataset.kind
  status.classList.remove('is-error')
  status.textContent = mode === 'page' ? 'Capturing the entire page…' : 'Capturing this view…'
  captureSeq++
  renderControls()
})
useButton.addEventListener('click', () => { interact = true; renderControls() })
reloadButton.addEventListener('click', () => { reloadSeq++; pageState = 'loading'; renderControls() })
closeButton.addEventListener('click', () => window.close())

renderList()
renderControls()
