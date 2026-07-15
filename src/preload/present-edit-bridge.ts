/// <reference lib="dom" />
// Edit bridge — TalkWeaver attaches this to a live deck window (the presenter view, via the recorder
// bridge; a plain presentation window, via present-edit.ts). ⌘E — or the injected "Edit" pill —
// asks main to bring the editor window forward and jump to the slide currently on screen. It reads
// the slide the deck runtime already tracks: its ledger id (the URL hash) and its index among
// `.slide` elements. It never touches the vendored deck template; it only ADDS a control + a key,
// exactly like the recorder bridge.
//
// Why ⌘E and not plain E: the deck runtime binds plain `e`/`E` to its OWN in-browser editing mode,
// and it ignores any meta/ctrl/alt combo (09-output-builders.mjs) — so ⌘E is free and can't collide.

import { ipcRenderer } from 'electron'

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

// A single small icon button, bottom-right — quiet by default (45% opacity), full on hover. Icon
// only: an inline "edit pencil" SVG (a nib-down pencil over a baseline), deliberately distinct from
// the deck's highlighter so the two aren't confused. The ⌘E hint lives in the tooltip, not on screen.
const EDIT_CSS = `
  #twedit-btn { position:fixed; right:16px; bottom:16px; z-index:140; display:inline-flex;
    align-items:center; justify-content:center; width:34px; height:34px; padding:0; border-radius:9px;
    background:rgba(20,32,43,0.72); color:#c3d0dd; border:1px solid #ffffff1f; cursor:pointer;
    backdrop-filter:blur(3px); opacity:0.45; transition:opacity .18s ease, border-color .18s ease, background .18s ease, color .18s ease; }
  #twedit-btn:hover, #twedit-btn:focus-visible { opacity:1; border-color:#d98a2b; background:rgba(27,40,54,0.94); color:#f0d5a0; outline:none; }
  #twedit-btn svg { width:17px; height:17px; display:block; }
  #twedit-hint { position:fixed; right:16px; bottom:58px; z-index:141; max-width:320px; padding:9px 12px;
    border-radius:9px; background:#241f14ee; border:1px solid #7a5a22; border-left:3px solid #d98a2b;
    color:#f1e6cf; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; font-size:0.82rem;
    line-height:1.3; box-shadow:0 14px 40px rgba(0,0,0,0.5); opacity:0; transform:translateY(6px);
    pointer-events:none; transition:opacity .18s ease, transform .18s ease; }
  #twedit-hint.show { opacity:1; transform:translateY(0); }
  #twedit-hint.ok { background:#122619ee; border-color:#2f6b45; border-left-color:#3fa066; color:#c9ecd6; }
`

// A distinct edit-pencil (angled pencil + underline), not the deck's highlighter mark.
const PENCIL_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M14.5 5.5l4 4"/><path d="M4 20l4.5-1 9-9-3.5-3.5-9 9L4 20z"/><path d="M3.5 21.5h17"/></svg>'

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
  btn.setAttribute('aria-label', 'Edit this slide in TalkWeaver (Command E)')
  btn.title = 'Edit this slide in TalkWeaver (⌘E)'
  btn.innerHTML = PENCIL_SVG
  btn.addEventListener('click', requestEdit)
  document.body.appendChild(btn)
}

// The deck's "?" cheat-sheet rebuilds its body on each open, so re-append an Edit row whenever it
// opens (same MutationObserver pattern the recorder bridge uses) — keyboard/parity documentation.
function injectCheatSheet(): void {
  const sheet = document.getElementById('twShortcuts')
  if (!sheet) return
  const inject = (): void => {
    const body = document.getElementById('twShortcutsBody')
    if (!body || body.querySelector('.twedit-sheet-row')) return
    const mk = (keys: string, text: string): HTMLElement => {
      const row = document.createElement('div')
      row.className = 'tw-shortcuts-row twedit-sheet-row'
      const k = document.createElement('kbd')
      k.className = 'tw-shortcuts-keys'
      k.textContent = keys
      const l = document.createElement('span')
      l.textContent = text
      row.append(k, l)
      return row
    }
    body.prepend(
      mk('⌘ E', 'Edit this slide in TalkWeaver'),
      mk('⌘ R', 'Refresh this deck with your latest edits')
    )
  }
  new MutationObserver(() => { if (!sheet.hidden) inject() })
    .observe(sheet, { attributes: true, attributeFilter: ['hidden'] })
}

// Brief non-blocking hint above the pencil (e.g. ⌘R refused while recording). Reuses one element.
let hintTimer: ReturnType<typeof setTimeout> | null = null
function flashHint(msg: string): void {
  let el = document.getElementById('twedit-hint')
  if (!el) {
    el = document.createElement('div')
    el.id = 'twedit-hint'
    document.body.appendChild(el)
  }
  el.textContent = msg
  el.classList.toggle('ok', msg.startsWith('✓')) // green for a success confirmation, amber otherwise
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
  injectCheatSheet()
}
