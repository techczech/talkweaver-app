/// <reference lib="dom" />
// The Guide in the presenter (onboarding 0.38.1 ticket 10; locked drawing state 07; the owner's words:
// "the guide should be a sidebar next to the other sidebars so that nothing is covered - it will
// expand the geometry not over the right bar").
//
// Mounted by the edit bridge in the presenter window TalkWeaver opens (?presenter=1). Nothing here is
// in the compiled deck: a deck opened on its own, the audience, venue, handout and live-follow pages
// never carry the chip, the column, its styles or its key.
//
//   • The button, in the bottom bar at the left beside Outline: "Guide · Present 13 of 47". Its key is C
//     (0.38.2 release notes; owner check 10 Oct had dropped it). A small × beside it, shown on hover and on keyboard focus, hides it: it turns
//     off the same Settings switch ("Show the Guide button in the sidebar") through main. It shows only
//     while main sends a view (the Guide button is on in TalkWeaver, lock decision 8).
//   • The column: the Present chapter as the main window shows it (sub-groups, tried and untried
//     rows, the practice talk line, the live commands listed apart). It is a column of its own beside
//     Next and Notes, never over them: the presenter root gives up the column's width
//     (clamp(320px, 24vw, 400px)) and its gap on its right, the top and bottom bars extend over it,
//     and the stage, Next and Notes reflow by their existing rules into what is left. The window is
//     never resized or moved (review round 1). Main only records that the column is open
//     (guide:present-column), so a reload brings it back.
//   • The button, C and the palette's "Guide: Present chapter" toggle it. "All chapters" at the top of the
//     column asks main (one-way, no payload) to bring the TalkWeaver window forward with the Guide open
//     on the chapter list; no other chapter's data reaches this window.
//
// The column renders only while open; a progress push while closed updates the chip's count only.
// Every string from main is set as text, never as markup; icons are the generated lucide bodies.
import { ipcRenderer } from 'electron'
import { GUIDE_TEXT } from '../shared/guide.ts'
import {
  GUIDE_COLUMN_CSS_WIDTH, GUIDE_COLUMN_GAP, GUIDE_COMMAND_RAN_EVENT, guideChipCount, isPresentGuideView,
  type PresentGuideView
} from '../shared/guide-present.ts'
import { dressPresenterButton, presenterControl, presenterIconSvg } from '../shared/presenter-controls.ts'
import { SHORTCUT_REGISTRY } from '../shared/shortcut-registry.ts'

const CHIP_ID = 'twguide-chip'
const COLUMN_ID = 'twguide-col'
const STYLE_ID = 'twguide-styles'
const CHAPTER = 'Present'
const WRAP_ID = 'twguide-chipwrap'
const HIDE_ID = 'twguide-hide'

// The column's look, drawn in state 07 (dark presenter chrome: the panels' #1a2530 and hairline).
const GUIDE_CSS = `
  #presenterRoot[data-tw-guide="open"] { padding-right: calc(var(--tw-guide-pad) + var(--tw-guide-w) + ${GUIDE_COLUMN_GAP}px); }
  #presenterRoot[data-tw-guide="open"] > header,
  #presenterRoot[data-tw-guide="open"] > .presenter-controls { margin-right: calc(-1 * (var(--tw-guide-w) + ${GUIDE_COLUMN_GAP}px)); }
  #${COLUMN_ID} { position: fixed; right: var(--tw-guide-pad); width: var(--tw-guide-w); top: var(--tw-guide-top, 80px); bottom: var(--tw-guide-bottom, 80px);
    box-sizing: border-box; display: grid; grid-template-rows: auto minmax(0, 1fr); z-index: 2; min-width: 0;
    background: #1a2530; border: 1px solid #ffffff1c; border-radius: 8px; color: #f7f3ea;
    font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  #${COLUMN_ID} svg { width: 14px; height: 14px; flex: none; }
  .twg-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid #ffffff14; }
  .twg-head b { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; }
  .twg-x { display: inline-flex; padding: 4px; border: 0; border-radius: 6px; background: transparent; color: #a3b3c2; cursor: pointer; }
  .twg-x:hover, .twg-x:focus-visible { background: #ffffff14; color: #f7f3ea; outline: none; }
  .twg-scroll { overflow: auto; padding: 12px 14px 16px; display: grid; gap: 10px; align-content: start; }
  .twg-title { display: flex; align-items: center; gap: 12px; }
  .twg-title b { display: block; font-size: 16px; }
  .twg-title small { display: block; color: #8ec3ff; font-size: 12.5px; }
  .twg-cic { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 8px; background: #243445; color: #c9d6e2; }
  .twg-cic svg { width: 18px; height: 18px; }
  .twg-bar { height: 4px; border-radius: 2px; background: #ffffff1a; overflow: hidden; }
  .twg-bar u { display: block; height: 100%; background: #3b82f6; }
  .twg-note { padding: 6px 10px; border-left: 3px solid #ffffff33; background: #ffffff08; color: #c9d6e2; font-size: 12.5px; }
  .twg-note b { color: #f7f3ea; }
  .twg-card { border: 1px solid #ffffff1c; border-radius: 8px; overflow: hidden; }
  .twg-card-h { display: flex; justify-content: space-between; padding: 8px 12px; background: #ffffff0a; border-bottom: 1px solid #ffffff14; }
  .twg-card-h span, .twg-gd { color: #a3b3c2; font-variant-numeric: tabular-nums; }
  .twg-cg + .twg-cg { border-top: 1px solid #ffffff10; }
  .twg-cg-h { display: flex; width: 100%; align-items: center; gap: 8px; padding: 7px 12px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .twg-cg-h:hover, .twg-cg-h:focus-visible { background: #ffffff0a; outline: none; }
  .twg-cg-h b { flex: 1; }
  .twg-tw { width: 10px; color: #71849a; font-size: 10px; }
  .twg-row { display: flex; align-items: center; gap: 10px; padding: 5px 12px 5px 28px; }
  .twg-row .twg-name { flex: 1; min-width: 0; color: #c9d6e2; }
  .twg-tick { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid #71849a; box-sizing: border-box; flex: none; }
  .twg-row.is-tried .twg-tick { border-color: #22c55e; background: #22c55e; color: #0d141c; }
  .twg-row.is-tried .twg-tick svg { width: 11px; height: 11px; stroke-width: 3; }
  .twg-row.is-flash { background: #14532d66; box-shadow: inset 3px 0 0 #22c55e; }
  .twg-row.is-flash .twg-name { color: #f7f3ea; font-weight: 600; }
  .twg-row kbd, .twg-chip-key { padding: 1px 6px; border: 1px solid #ffffff2e; border-radius: 4px; color: #c9d6e2; font: 500 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; white-space: nowrap; }
  .twg-nokey { color: #71849a; font-size: 12px; }
  .twg-live { display: flex; gap: 8px; padding: 10px 12px; border: 1px dashed #ffffff2e; border-radius: 8px; color: #a3b3c2; font-size: 12.5px; }
  .twg-live b { color: #f7f3ea; }
  #${WRAP_ID} { display: inline-flex; align-items: center; gap: 2px; margin-left: 8px; }
  #${HIDE_ID} { display: inline-flex; padding: 3px; border: 0; border-radius: 6px; background: transparent; color: #a3b3c2; cursor: pointer; opacity: 0; transition: opacity .12s; }
  #${HIDE_ID} svg { width: 12px; height: 12px; }
  #${WRAP_ID}:hover #${HIDE_ID}, #${WRAP_ID}:focus-within #${HIDE_ID} { opacity: 1; }
  #${HIDE_ID}:hover, #${HIDE_ID}:focus-visible { background: #ffffff14; color: #f7f3ea; outline: none; }
  .twg-all { display: inline-flex; align-items: center; gap: 4px; justify-self: start; padding: 4px 10px 4px 6px; border: 1px solid #3b82f6aa; border-radius: 6px; background: #1d3552; color: #8ec3ff; font: 600 12.5px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; cursor: pointer; }
  .twg-all:hover, .twg-all:focus-visible { background: #25456b; color: #f7f3ea; outline: none; }
  #${CHIP_ID} { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border: 1px solid #3b82f6aa; border-radius: 6px;
    background: #1d3552; color: #8ec3ff; font: 500 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; cursor: pointer; white-space: nowrap; }
  #${CHIP_ID}[aria-pressed="true"] { background: #25456b; border-color: #8ec3ff; }
  #${CHIP_ID} b { color: #f7f3ea; font-variant-numeric: tabular-nums; }
  #${CHIP_ID} svg { width: 14px; height: 14px; }
`

function icon(name: string): Element {
  const holder = document.createElement('span')
  holder.innerHTML = presenterIconSvg(name)
  return holder.firstElementChild as Element
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Reports a presenter command to the Guide through the bridge entry point (present-edit-bridge.ts). */
export function reportGuideCommand(id: string): void {
  try { window.dispatchEvent(new CustomEvent(GUIDE_COMMAND_RAN_EVENT, { detail: id })) } catch { /* a report never fails a command */ }
}

export function mountPresenterGuide(): void {
  const root = document.getElementById('presenterRoot')
  if (!root || document.getElementById(CHIP_ID) || root.dataset.twGuideMounted) return
  root.dataset.twGuideMounted = '1'
  let view: PresentGuideView | null = null
  let open = false
  let chip: HTMLButtonElement | null = null
  let column: HTMLElement | null = null
  let observer: ResizeObserver | null = null
  let shownTried: Set<string> | null = null
  let flashTimer: ReturnType<typeof setTimeout> | null = null
  const toggled = new Map<string, boolean>()

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = GUIDE_CSS
    document.head.appendChild(style)
  }

  function mountChip(): HTMLButtonElement {
    if (chip) return chip
    const button = el('button')
    button.type = 'button'
    button.id = CHIP_ID
    button.setAttribute('aria-pressed', 'false')
    button.setAttribute('aria-controls', COLUMN_ID)
    dressPresenterButton(button, presenterControl(CHIP_ID), SHORTCUT_REGISTRY)
    button.append(el('span', 'twg-chip-word', `${GUIDE_TEXT.button} · ${CHAPTER}`), el('b'))
    button.addEventListener('click', () => toggle())
    // The easy remove: the same Settings switch the sidebar's Guide button follows, turned off through main.
    const hide = el('button')
    hide.type = 'button'
    hide.id = HIDE_ID
    hide.setAttribute('aria-label', 'Hide the Guide button')
    hide.dataset.tip = 'Hide the Guide button (Settings brings it back)'
    hide.append(icon('x'))
    hide.addEventListener('click', () => { void ipcRenderer.invoke('guide:present-hide-button').catch(() => {}) })
    const wrap = el('span')
    wrap.id = WRAP_ID
    wrap.append(button, hide)
    // Bottom bar, left, next to Outline.
    const outline = document.getElementById('outlineBtn')
    if (outline) outline.after(wrap)
    else (document.querySelector('#presenterBottomBar .tw-nav-left') ?? document.getElementById('presenterBottomBar'))?.append(wrap)
    chip = button
    return button
  }

  function unmountChip(): void {
    document.getElementById(WRAP_ID)?.remove()
    chip = null
  }

  function updateChip(): void {
    if (!view) return
    const button = mountChip()
    const count = button.querySelector('b')
    if (count) count.textContent = guideChipCount(view)
    button.setAttribute('aria-pressed', String(open))
  }

  // ── geometry ──
  function place(): void {
    if (!column || !root) return
    const header = root.querySelector(':scope > header')
    const bar = document.getElementById('presenterBottomBar')
    const top = header ? header.getBoundingClientRect().bottom + GUIDE_COLUMN_GAP : GUIDE_COLUMN_GAP
    const bottom = bar ? window.innerHeight - bar.getBoundingClientRect().top + GUIDE_COLUMN_GAP : GUIDE_COLUMN_GAP
    column.style.setProperty('--tw-guide-top', `${Math.round(top)}px`)
    column.style.setProperty('--tw-guide-bottom', `${Math.round(Math.max(GUIDE_COLUMN_GAP, bottom))}px`)
  }

  function openColumn(): void {
    if (!view || !root || open) return
    open = true
    // The root's own right padding stays the column's margin from the window edge.
    root.style.setProperty('--tw-guide-pad', getComputedStyle(root).paddingRight || '18px')
    root.style.setProperty('--tw-guide-w', GUIDE_COLUMN_CSS_WIDTH)
    root.dataset.twGuide = 'open'
    renderColumn()
    observer = new ResizeObserver(place)
    observer.observe(root)
    const header = root.querySelector(':scope > header')
    if (header) observer.observe(header)
    const bar = document.getElementById('presenterBottomBar')
    if (bar) observer.observe(bar)
    place()
    updateChip()
    // Main records that it is open (for a reload); it never touches the window.
    void ipcRenderer.invoke('guide:present-column', true).catch(() => {})
  }

  function closeColumn(): void {
    if (!open || !root) return
    open = false
    observer?.disconnect()
    observer = null
    column?.remove()
    column = null
    shownTried = null
    delete root.dataset.twGuide
    root.style.removeProperty('--tw-guide-w')
    root.style.removeProperty('--tw-guide-pad')
    updateChip()
    void ipcRenderer.invoke('guide:present-column', false).catch(() => {})
  }

  function toggle(): void {
    if (open) closeColumn()
    else openColumn()
  }

  // ── the column (rendered only while open) ──
  function renderColumn(): void {
    if (!view || !root) return
    const v = view
    const tried = new Set(v.subgroups.flatMap((g) => g.rows.filter((r) => r.tried).map((r) => r.id)))
    const fresh = shownTried ? [...tried].filter((id) => !shownTried!.has(id)) : []
    shownTried = tried
    if (!column) {
      column = el('aside')
      column.id = COLUMN_ID
      column.setAttribute('aria-label', GUIDE_TEXT.button)
      // In the document after Next, Then and Notes (reading order); fixed, so it takes no grid cell.
      const side = root.querySelector(':scope > .presenter-side')
      if (side) side.after(column)
      else root.append(column)
    }
    const head = el('div', 'twg-head')
    const title = el('b')
    title.append(icon('graduation-cap'), document.createTextNode(GUIDE_TEXT.button))
    const close = el('button', 'twg-x')
    close.type = 'button'
    close.setAttribute('aria-label', 'Close the Guide')
    close.dataset.tip = 'Close the Guide'
    close.append(icon('x'))
    close.addEventListener('click', () => closeColumn())
    head.append(title, close)

    const scroll = el('div', 'twg-scroll')
    // The way to the other chapters: they are in the TalkWeaver window, not here.
    const all = el('button', 'twg-all')
    all.type = 'button'
    all.dataset.guideAllChapters = ''
    all.append(icon('chevron-left'), document.createTextNode(GUIDE_TEXT.chapters.allChapters))
    all.dataset.tip = 'Open the Guide in TalkWeaver, on the list of chapters'
    all.addEventListener('click', () => { void ipcRenderer.invoke('guide:present-all-chapters').catch(() => {}) })
    scroll.append(all)
    const chapterTitle = el('div', 'twg-title')
    const cic = el('span', 'twg-cic')
    cic.append(icon('presentation'))
    const names = el('div')
    names.append(el('b', '', CHAPTER), el('small', '', v.status))
    names.lastElementChild?.setAttribute('data-guide-status', '')
    chapterTitle.append(cic, names)
    const bar = el('div', 'twg-bar')
    bar.setAttribute('role', 'progressbar')
    bar.setAttribute('aria-valuemin', '0')
    bar.setAttribute('aria-valuemax', String(v.total))
    bar.setAttribute('aria-valuenow', String(v.tried))
    const fill = el('u')
    fill.style.width = `${v.total ? Math.round((v.tried / v.total) * 100) : 0}%`
    bar.append(fill)
    const note = el('div', 'twg-note')
    note.append(el('b', '', `${GUIDE_TEXT.chapters.practiceTalk}:`), document.createTextNode(` ${v.practice.talk}${v.practice.openNow ? ` (${GUIDE_TEXT.chapters.openNow})` : ''}, section “${v.practice.section}”.`))

    const card = el('div', 'twg-card')
    const cardHead = el('div', 'twg-card-h')
    cardHead.append(el('b', '', GUIDE_TEXT.chapters.thisChapter), el('span', '', guideChipCount(v)))
    card.append(cardHead)
    const firstOpen = v.subgroups.find((g) => g.tried < g.total)?.name
    for (const group of v.subgroups) {
      const isOpen = toggled.get(group.name) ?? (group.name === firstOpen || group.rows.some((r) => fresh.includes(r.id)))
      const cg = el('div', 'twg-cg')
      cg.dataset.subgroup = group.name
      const h = el('button', 'twg-cg-h')
      h.type = 'button'
      h.setAttribute('aria-expanded', String(isOpen))
      h.append(el('span', 'twg-tw', isOpen ? '▾' : '▸'), el('b', '', group.name), el('span', 'twg-gd', `${group.tried} of ${group.total}`))
      h.addEventListener('click', () => { toggled.set(group.name, !isOpen); renderColumn() })
      cg.append(h)
      if (isOpen) {
        for (const row of group.rows) {
          const line = el('div', `twg-row${row.tried ? ' is-tried' : ''}${fresh.includes(row.id) ? ' is-flash' : ''}`)
          line.dataset.commandRow = row.id
          line.dataset.ticked = String(row.tried)
          const tick = el('span', 'twg-tick')
          tick.setAttribute('aria-hidden', 'true')
          if (row.tried) tick.append(icon('check'))
          line.append(tick, el('span', 'twg-name', row.label))
          for (const key of row.keys) line.append(el('kbd', '', key))
          if (row.noKey) line.append(el('span', 'twg-nokey', GUIDE_TEXT.chapters.noKey))
          cg.append(line)
        }
      }
      card.append(cg)
    }
    scroll.append(chapterTitle, bar, note, card)
    if (v.live > 0) {
      const live = el('div', 'twg-live')
      live.dataset.guideLive = ''
      const words = GUIDE_TEXT.chapters.liveNote(v.live)
      const text = el('span')
      text.append(el('b', '', words.lead), document.createTextNode(words.rest))
      live.append(icon('radio'), text)
      scroll.append(live)
    }
    const keepScroll = column.querySelector('.twg-scroll')?.scrollTop ?? 0
    column.replaceChildren(head, scroll)
    scroll.scrollTop = keepScroll
    if (fresh.length) {
      if (flashTimer) clearTimeout(flashTimer)
      flashTimer = setTimeout(() => { column?.querySelectorAll('.twg-row.is-flash').forEach((n) => n.classList.remove('is-flash')) }, 1800)
    }
  }

  // ── what main says ──
  function apply(reply: unknown): void {
    const r = reply as { view?: unknown; open?: unknown } | null
    if (!r || !isPresentGuideView(r.view)) {
      view = null
      closeColumn()
      unmountChip()
      return
    }
    view = r.view
    updateChip()
    if (open) renderColumn()
    // The page reloaded (⌘R) with the column open: main recorded it, so the column comes back.
    else if (r.open === true) openColumn()
  }

  // The presenter keeps the person's rebinds in this store, keyed by registry id, as { chord, entryId }
  // (compiler/assets/runtime/presenter-shortcuts.js). Read at each press, so a rebind applies at once.
  function guideKeyRebound(): boolean {
    try {
      const saved = JSON.parse(window.localStorage.getItem('talkweaver:presenter:shortcuts') || '{}') as Record<string, { chord?: unknown } | null> | null
      const chord = saved?.['presenter.guide']?.chord
      return typeof chord === 'string' && chord !== ''
    } catch {
      return false
    }
  }

  // C toggles the column (presenter.guide): the same toggle() the button runs. Not with a modifier, not on
  // a repeat, not while typing or in a dialog or the command palette, and not without the chip (the Guide
  // button is off): then C does nothing. A key typed inside an embedded page never reaches this document.
  // A rebound Guide key is run by the presenter's own key handler (compiler/assets/runtime/presenter-shortcuts.js),
  // so when the person has rebound it, this literal C listener stands aside and the old key does nothing.
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if (!chip || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat) return
    if (event.key !== 'c' && event.key !== 'C') return
    if (guideKeyRebound()) return
    const target = event.target
    if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), dialog')) return
    const palette = document.getElementById('presenterCommandPalette')
    if (palette && !palette.hidden) return
    event.preventDefault()
    event.stopImmediatePropagation()
    toggle()
    reportGuideCommand('presenter.guide')
  }, true)
  // The button and the palette entry run the same toggle; the template reports their presses (presenter.guide).

  ipcRenderer.on('guide:present-chapter-changed', (_event, reply: unknown) => apply(reply))
  void ipcRenderer.invoke('guide:present-chapter').then(apply).catch(() => {})
}
