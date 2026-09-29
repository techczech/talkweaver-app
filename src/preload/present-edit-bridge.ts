/// <reference lib="dom" />
// Edit bridge — TalkWeaver attaches this to a live deck window (the presenter view, via the recorder
// bridge; a plain presentation window, via present-edit.ts). ⌘E — or the pencil (a bottom-bar
// button in the presenter, a floating button elsewhere) — asks main to bring the editor window forward and jump to the slide currently on screen. It reads
// the slide the deck runtime already tracks: its ledger id (the URL hash) and its index among
// `.slide` elements. It never touches the vendored deck template; it only ADDS a control + a key,
// exactly like the recorder bridge.
//
// Why ⌘E and not plain E: the deck runtime binds plain `e`/`E` to its OWN in-browser editing mode,
// and it ignores any meta/ctrl/alt combo (09-output-builders.mjs) — so ⌘E is free and can't collide.

import { ipcRenderer } from 'electron'
import { dressPresenterButton, presenterControl, presenterIconSvg } from '../shared/presenter-controls.ts'
import { SHORTCUT_REGISTRY } from '../shared/shortcut-registry.ts'

// The slide on screen, by the two identifiers the editor can resolve: the ledger id the runtime
// keeps in the URL hash (stable across reorders) and the index among `.slide` elements (a fallback
// for a slide with no {id=…} yet). The editor prefers the id and falls back to the index.
function currentSlide(): { slideId: string; index: number } {
  const slideId = location.hash.startsWith('#') ? decodeURIComponent(location.hash.slice(1)) : ''
  const slides = Array.from(document.querySelectorAll('.slide'))
  const active = document.querySelector('.slide.active')
  const index = active ? slides.indexOf(active) : -1
  return { slideId, index }
}

function requestEdit(): void {
  void ipcRenderer.invoke('present:edit-slide', currentSlide())
}

// ⌘R's refresh-in-place, asked for from the presenter's More menu: main runs the same
// refreshDeckFromEditor the key runs (it refuses while recording and says so in the hint).
function requestRefresh(): void {
  void ipcRenderer.invoke('present:refresh-deck')
}

// The presenter window (?presenter=1) has a bottom bar with a slot for the pencil at its right end
// (ADR-0031 §4, presenter redesign ticket 05); a plain presentation window has none and keeps the
// floating pencil.
function presenterEditSlot(): HTMLElement | null {
  if (new URLSearchParams(location.search).get('presenter') !== '1') return null
  return document.getElementById('presenterEditSlot')
}

// In a plain presentation window: a single small icon button, bottom-right — quiet by default (45%
// opacity), full on hover. Icon only: lucide's pencil (the presenter chrome's icon set; the deck's
// highlighter is lucide's highlighter, so the two stay distinct). The name and ⌘E live in the
// tooltip, not on screen. In the presenter the pencil is a bottom-bar button and takes the bar's
// styles (presenter-bottom-bar.css); none of the floating rules below apply to it.
const EDIT_CSS = `
  #twedit-btn:not(.twedit-in-bar) { position:fixed; right:16px; bottom:16px; z-index:140; display:inline-flex;
    align-items:center; justify-content:center; width:34px; height:34px; padding:0; border-radius:9px;
    background:rgba(20,32,43,0.72); color:#c3d0dd; border:1px solid #ffffff1f; cursor:pointer;
    backdrop-filter:blur(3px); opacity:0.45; transition:opacity .18s ease, border-color .18s ease, background .18s ease, color .18s ease; }
  #twedit-btn:not(.twedit-in-bar):hover, #twedit-btn:not(.twedit-in-bar):focus-visible { opacity:1; border-color:#d98a2b; background:rgba(27,40,54,0.94); color:#f0d5a0; outline:none; }
  #twedit-btn:not(.twedit-in-bar) svg { width:16px; height:16px; display:block; margin:0; }
  #twedit-hint { position:fixed; right:16px; bottom:58px; z-index:141; max-width:320px; padding:9px 12px;
    border-radius:9px; background:#241f14ee; border:1px solid #7a5a22; border-left:3px solid #d98a2b;
    color:#f1e6cf; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; font-size:0.82rem;
    line-height:1.3; box-shadow:0 14px 40px rgba(0,0,0,0.5); opacity:0; transform:translateY(6px);
    pointer-events:none; transition:opacity .18s ease, transform .18s ease; }
  #twedit-hint.show { opacity:1; transform:translateY(0); }
  #twedit-hint svg { width:16px; height:16px; vertical-align:-3px; margin-right:6px; }
  #twedit-hint.ok { background:#122619ee; border-color:#2f6b45; border-left-color:#3fa066; color:#c9ecd6; }
`

function mountButton(): void {
  if (document.getElementById('twedit-btn')) return
  if (!document.getElementById('twedit-styles')) {
    const style = document.createElement('style')
    style.id = 'twedit-styles'
    style.textContent = EDIT_CSS
    document.head.appendChild(style)
  }
  const btn = document.createElement('button')
  btn.id = 'twedit-btn'
  btn.type = 'button'
  dressPresenterButton(btn, presenterControl('twedit-btn'), SHORTCUT_REGISTRY)
  btn.addEventListener('click', requestEdit)
  const slot = presenterEditSlot()
  if (slot) {
    // The presenter's own tooltip shows the name and ⌘E.
    btn.classList.add('twedit-in-bar')
    slot.appendChild(btn)
    return
  }
  // A plain presentation window has no presenter tooltip; the native title serves there.
  btn.title = `${btn.dataset.tip}  ${btn.dataset.key}`
  document.body.appendChild(btn)
}

// More → Refresh with latest edits (presenter only): the template leaves it hidden, because only
// TalkWeaver can refresh a deck; here it is shown and runs ⌘R's refresh.
function mountRefreshItem(): void {
  if (!presenterEditSlot()) return
  const item = document.getElementById('moreRefresh')
  if (!item || item.dataset.twedit) return
  item.dataset.twedit = '1'
  item.hidden = false
  const rule = document.getElementById('moreRefreshRule')
  if (rule) rule.hidden = false
  item.addEventListener('click', requestRefresh)
}

// ⌘E and ⌘R are on the presenter's ? sheet from the shortcut registry (presenter.edit,
// presenter.refresh), shown while this bridge's pencil is mounted (presenter redesign ticket 07).

// Brief non-blocking hint above the pencil (e.g. ⌘R refused while recording). Reuses one element.
let hintTimer: ReturnType<typeof setTimeout> | null = null
function flashHint(msg: string): void {
  let el = document.getElementById('twedit-hint')
  if (!el) {
    el = document.createElement('div')
    el.id = 'twedit-hint'
    document.body.appendChild(el)
  }
  // A success confirmation arrives as "✓ …" from main: drawn as lucide's circle-check, in green.
  const ok = msg.startsWith('✓')
  el.textContent = ok ? msg.replace(/^✓\s*/, '') : msg
  if (ok) el.insertAdjacentHTML('afterbegin', presenterIconSvg('circle-check'))
  el.classList.toggle('ok', ok) // green for a success confirmation, amber otherwise
  el.classList.add('show')
  if (hintTimer) clearTimeout(hintTimer)
  hintTimer = setTimeout(() => el?.classList.remove('show'), 2800)
}

export function mountEditBridge(): void {
  // ⌘E / Ctrl+E — capture phase so we act before the deck's own keymap; never while typing in a field.
  window.addEventListener(
    'keydown',
    (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      if (e.key !== 'e' && e.key !== 'E') return
      const t = e.target
      if (t instanceof HTMLElement && t.matches('input, textarea, select, [contenteditable="true"]')) return
      e.preventDefault()
      e.stopImmediatePropagation()
      requestEdit()
    },
    true
  )
  // Main sends a hint here when it declines a ⌘R refresh (recording armed, or the editor is closed).
  ipcRenderer.on('present:hint', (_e, msg: string) => flashHint(msg))
  mountButton()
  mountRefreshItem()
}
