// The reaction bar on the published audience page (ADR-0027 and its 2026-09-29 amendment; ticket
// "People react from the phone and laptop bar"). Three seams, each a function the page runtime
// embeds by `.toString()` (see audienceReactionsRuntimeSource), so every function here is
// self-contained: no module-level constants, no imports.
//
//  - reactionTap(marks, id)            pure: what one tap does to a slide's marks and what to send
//  - createReactionMarks(options)      the person's own marks, per talk and slide, on this device
//  - createAudienceReactions(options)  the bar itself: DOM, words then icons, notes, keyboard
//
// Sending is not here: the follow client owns the socket and the offline queue
// (createAudienceFollowClient.sendReaction in live-follow.js); the bar hands it `{reaction,
// slideId, tMs, withdrawn?}` and hears back through onReactionStatus.

/** The icons the bar draws: lucide bodies, checked against compiler/assets/icons/lucide.json by
 *  scripts/audience-reactions.test.mjs. */
export function audienceReactionIcons() {
  return {
    'pen-line': '<path d="M13 21h8"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
    frown: '<circle cx="12" cy="12" r="10"/><path d="M16 16s-1.5-2-4-2-4 2-4 2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/>',
    lightbulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
    bookmark: '<path d="M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z"/>',
    'bookmark-check': '<path d="M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z"/><path d="m9 10 2 2 4-4"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    'message-circle-question-mark': '<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    'circle-check': '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    'circle-x': '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
    'wifi-off': '<path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    'eye-off': '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
    'send-horizontal': '<path d="M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z"/><path d="M6 12h16"/>',
    'loader-circle': '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    'refresh-cw': '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    pause: '<rect x="14" y="3" width="5" height="18" rx="1"/><rect x="5" y="3" width="5" height="18" rx="1"/>',
    'undo-2': '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
    'thumbs-up': '<path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/><path d="M7 10v12"/>',
    'thumbs-down': '<path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/><path d="M17 14V2"/>',
    'message-circle-more': '<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/><path d="M8 12h.01"/><path d="M12 12h.01"/><path d="M16 12h.01"/>',
    snail: '<path d="M2 13a6 6 0 1 0 12 0 4 4 0 1 0-8 0 2 2 0 0 0 4 0"/><circle cx="10" cy="13" r="8"/><path d="M2 21h12c4.4 0 8-3.6 8-8V7a2 2 0 1 0-4 0v6"/><path d="M18 3 19.1 5.2"/><path d="M22 3 20.9 5.2"/>',
  }
}

/**
 * Whether a worker's /capabilities body takes reactions: protocol 2 and a build numbered 14 or later
 * (the build that added them was '14-reactions-questions'; worker/recovery-protocol.ts LIVE_WORKER_BUILD is later).
 * An older worker answers a reaction with a protocol error and never an ack, so the bar stays away.
 * @param {any} capabilities
 */
export function audienceReactionsSupported(capabilities) {
  const build = /^(\d+)/.exec(String(capabilities && capabilities.build))
  return Boolean(capabilities && capabilities.protocol === 2 && build && Number(build[1]) >= 14)
}

/**
 * Every registered reaction (ADR-0027 §2 and its 2026-09-29 amendment §6; surfaces-and-states §
 * Trigger-line token), in the order the Inspector offers them. The first three are the standard set
 * a slide carries when its Trigger line names none. `words` is what the phone and laptop bar say,
 * `short` what the Inspector and the presenter chip say, `icon` a lucide name. This is the one list:
 * the compiler (compiler/scripts/lib/reaction-sets.mjs), the Inspector and the presenter window read
 * it from here. Any other value on a slide's {reactions=…} is a custom label (`custom:<label>`).
 */
export function audienceReactionRegistry() {
  return {
    puzzled: { icon: 'frown', words: 'Puzzled by this', short: 'Puzzled by this', meaning: true },
    helped: { icon: 'lightbulb', words: 'Helped me understand', short: 'Helped me understand', meaning: true },
    bookmark: { icon: 'bookmark', on: 'bookmark-check', words: 'Bookmark: I need to return to this', short: 'Bookmark', meaning: false },
    agree: { icon: 'thumbs-up', words: 'Agree', short: 'Agree', meaning: true },
    disagree: { icon: 'thumbs-down', words: 'Disagree', short: 'Disagree', meaning: true },
    yes: { icon: 'check', words: 'Yes', short: 'Yes', meaning: true },
    no: { icon: 'x', words: 'No', short: 'No', meaning: true },
    more: { icon: 'message-circle-more', words: 'Tell me more', short: 'Tell me more', meaning: true },
    slower: { icon: 'snail', words: 'Slower, please', short: 'Slower, please', meaning: true },
  }
}

/**
 * What one slide's bar offers, from the list the compiler stamps on the slide (`data-reactions`:
 * registered ids and `custom:<label>` ids, `[]` for off) or `null` for the standard set. Unknown or
 * malformed entries are dropped, never shown. Each item: `{ id, words, icon | null, custom }`.
 * @param {any} list
 */
export function audienceSlideReactions(list) {
  const registry = audienceReactionRegistry()
  const ids = Array.isArray(list) ? list : ['puzzled', 'helped', 'bookmark']
  const items = []
  for (const raw of ids) {
    const id = String(raw)
    if (items.some((item) => item.id === id)) continue
    if (Object.prototype.hasOwnProperty.call(registry, id)) {
      items.push({ id, words: registry[id].words, icon: registry[id].icon, on: registry[id].on || null, custom: false })
    } else if (id.startsWith('custom:') && id.slice(7).trim()) {
      items.push({ id, words: id.slice(7).trim(), icon: null, on: null, custom: true })
    }
    if (items.length === 4) break
  }
  return items
}

/**
 * What the speaker's two switches leave on the bar (ADR-0027 amendment, 2026-09-29; ticket 05).
 * `switches` is `{ questionsAllowed, reactionsAllowed }` as the worker reports it; anything else
 * counts as on. Paused reactions hide the meaning reactions and keep Bookmark (it is the person's own
 * mark and the worker still takes it); paused questions hide Ask. The note is the one line the bar
 * shows while a switch is off; both off leaves Bookmark alone.
 * @param {any} switches
 */
export function audienceBarPlan(switches) {
  const reactions = !(switches && switches.reactionsAllowed === false)
  const questions = !(switches && switches.questionsAllowed === false)
  const note = !reactions && !questions ? 'The speaker has paused reactions and questions'
    : !reactions ? 'The speaker has paused reactions'
      : !questions ? 'The speaker is not taking questions right now' : ''
  return { meaning: reactions, bookmark: true, ask: questions, note }
}

/**
 * One tap on a slide's marks `{ r: meaning reaction id | null, b: bookmark held }`.
 * One meaning reaction per slide: another replaces it (one message; the worker replaces), the
 * selected one is withdrawn. The bookmark is independent. Returns the next marks, what happened,
 * and the message body to send (`withdrawn: true` for an undo).
 * @param {{ r: string | null, b: boolean }} marks @param {string} id
 */
export function reactionTap(marks, id) {
  const before = { r: marks && marks.r ? marks.r : null, b: Boolean(marks && marks.b) }
  if (id === 'bookmark') {
    const b = !before.b
    return { next: { r: before.r, b }, kind: b ? 'bookmark-on' : 'bookmark-off', reaction: 'bookmark', withdrawn: !b, replaced: null }
  }
  if (before.r === id) return { next: { r: null, b: before.b }, kind: 'undo', reaction: id, withdrawn: true, replaced: null }
  return { next: { r: id, b: before.b }, kind: before.r ? 'change' : 'select', reaction: id, withdrawn: false, replaced: before.r }
}

/**
 * What to put back on the device when a queued tap was refused (nothing was stored by the worker):
 * only the half the tap changed, and only if a later tap has not already moved that half. Returns the
 * patch for createReactionMarks.set, or null when nothing should change.
 * @param {{ r: string | null, b: boolean }} held the marks now on the device
 * @param {{ reaction: string, local?: { before: any, after: any } }} item the refused queue item
 */
export function reactionRevert(held, item) {
  const local = item && item.local
  if (!local) return null
  if (item.reaction === 'bookmark') return held.b === local.after.b ? { b: local.before.b } : null
  return held.r === local.after.r ? { r: local.before.r } : null
}

/**
 * The person's own reactions and bookmarks, kept on this device beside My Notes' key, per talk, per
 * live run and per slide. Stored shape (small on purpose):
 *   { v: 2, used: boolean, runs: { [sessionId]: { [slideId]: { r: reaction id | null, b: boolean } } } }
 * `used` is the words-then-icons flag for this talk on this device. A run is one live session; a later
 * run of the same talk starts with an empty bar and never overwrites or deletes an earlier run's marks,
 * which stay for My Notes to show per run. A slide with nothing held has no entry.
 * Every read and every write goes to storage afresh and a write changes only the half it names (`r`
 * or `b`) of one slide in one run, so two tabs of the same talk never overwrite each other from stale
 * memory. Blocked storage falls back to this page's own copy.
 * @param {{ storage?: any, key: string }} options
 */
export function createReactionMarks(options) {
  const storage = options.storage || null
  let memo = { v: 2, used: false, runs: {} }
  function read() {
    try {
      const saved = storage ? JSON.parse(storage.getItem(options.key) || 'null') : null
      if (saved && saved.v === 2 && saved.runs && typeof saved.runs === 'object' && !Array.isArray(saved.runs)) {
        const runs = {}
        for (const [sessionId, slides] of Object.entries(saved.runs)) {
          if (!slides || typeof slides !== 'object' || Array.isArray(slides)) continue
          const clean = {}
          for (const [slideId, mark] of Object.entries(slides)) {
            if (mark && typeof mark === 'object') clean[slideId] = { r: typeof mark.r === 'string' && mark.r ? mark.r : null, b: mark.b === true }
          }
          runs[sessionId] = clean
        }
        memo = { v: 2, used: saved.used === true, runs }
      }
    } catch { /* unreadable: keep this page's copy */ }
    return memo
  }
  function write(data) {
    memo = data
    try { if (storage) storage.setItem(options.key, JSON.stringify(data)) } catch { /* full or blocked: marks live for this page */ }
  }
  return {
    used() { return read().used },
    markUsed() { const data = read(); if (!data.used) write({ ...data, used: true }) },
    /** The marks the bar shows for this slide in this run. */
    get(slideId, sessionId) {
      const mark = (read().runs[sessionId] || {})[slideId]
      return mark ? { r: mark.r, b: mark.b } : { r: null, b: false }
    },
    /** Change the named half (`r`, `b` or both) of one slide's marks in one run. */
    set(slideId, sessionId, patch) {
      const data = read()
      const run = { ...(data.runs[sessionId] || {}) }
      const held = run[slideId] || { r: null, b: false }
      const next = { r: 'r' in patch ? patch.r || null : held.r, b: 'b' in patch ? patch.b === true : held.b }
      if (!next.r && !next.b) delete run[slideId]
      else run[slideId] = next
      const runs = { ...data.runs, [sessionId]: run }
      if (!Object.keys(run).length) delete runs[sessionId]
      write({ ...data, runs })
    },
    /** Every stored mark by run and slide, for My Notes to read later. */
    all() { return JSON.parse(JSON.stringify(read().runs)) },
  }
}

/**
 * The bar. `dock` is the page's #rxDock element. Options: document, dock, storage, storageKey,
 * getSlideId() → the slide the person is on, getSlideReactions(slideId) → the slide's own list
 * (`data-reactions`, see audienceSlideReactions) or null for the standard set, isPhone() → boolean,
 * isConnected() → boolean, sendReaction(item) → submissionId | false, onMarksChanged() (after a tap or
 * a refused tap changed the device's marks; My Notes redraws from it), now(), schedule(fn, ms). On a
 * phone the bar also carries Note (beside Ask) when onNote() is given: getNoteCount(slideId) → how many
 * notes this device holds for the slide (shown as a count on the button; refresh() redraws it).
 * @param {any} options
 */
export function createAudienceReactions(options) {
  const document = options.document
  const dock = options.dock
  const win = document.defaultView || (typeof window !== 'undefined' ? window : null)
  const icons = audienceReactionIcons()
  const marks = createReactionMarks({ storage: options.storage, key: options.storageKey })
  const now = options.now || (() => Date.now())
  const schedule = options.schedule || ((fn, ms) => setTimeout(fn, ms))
  const cancelSchedule = options.cancelSchedule || ((handle) => clearTimeout(handle))
  const pendingNotes = new Map()
  let sessionId = ''
  let visible = false
  let wanted = false
  let supported = false
  let note = null
  let noteTimer = null
  let plan = audienceBarPlan(null)
  let wordsSlide = null // the slide of the first tap: its words stay there, icons start on the next
  let built = false
  let builtSet = null // the ids the bar's buttons were last built for

  const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const svg = (name, extra) => '<svg class="lucide lucide-' + name + (extra || '') + '" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (icons[name] || '') + '</svg>'
  const phone = () => Boolean(options.isPhone && options.isPhone())
  const device = () => (phone() ? 'phone' : 'device')
  const slideId = () => String(options.getSlideId ? options.getSlideId() : '')
  const mode = () => (!marks.used() || wordsSlide === slideId() ? 'words' : 'icons')
  // The slide's own reactions (ticket 04): the standard three, a replacement set, custom labels, or
  // none. Read afresh on every render, so the bar follows the slide it is on.
  const items = () => audienceSlideReactions(options.getSlideReactions ? options.getSlideReactions(slideId()) : null)
  const itemOf = (id) => items().find((item) => item.id === id) || null
  // A reaction's words for a note: its registered words, or the custom label itself.
  const labelOf = (id) => {
    const item = audienceSlideReactions([id])[0]
    return item ? item.words : String(id)
  }

  // One button per reaction. A named reaction has its icon and words (words on first use, icons
  // after); a custom label has its words only, always. Labels are the author's text, set as text.
  function button(item) {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = item.custom ? 'rx rx-custom' : 'rx'
    el.setAttribute('data-rx', item.id)
    el.setAttribute('aria-pressed', 'false')
    el.setAttribute('aria-label', item.words)
    el.innerHTML = (item.custom ? '' : '<span class="rx-ico">' + svg(item.icon) + '</span>')
      + '<span class="rx-w"></span><span class="rx-tick" aria-hidden="true">' + svg('check') + '</span>'
      + (item.custom ? '' : '<span class="rx-tip" aria-hidden="true"></span>')
    el.querySelector('.rx-w').textContent = item.words
    if (!item.custom) el.querySelector('.rx-tip').textContent = item.words
    return el
  }
  function buildSet(list) {
    const bar = dock.querySelector('.rx-bar')
    for (const old of dock.querySelectorAll('.rx')) old.remove()
    const sep = dock.querySelector('.rx-sep')
    for (const item of list) bar.insertBefore(button(item), sep)
    bar.classList.toggle('no-reactions', list.length === 0)
    builtSet = list.map((item) => item.id).join('\n')
  }

  function build() {
    dock.innerHTML = '<div class="rx-wrap"><div class="rx-bar words" role="group" aria-label="React to this slide">'
      + '<span class="rx-sep" aria-hidden="true"></span>'
      // Note (phone only) opens the note sheet (createAudienceAsk.openNote) through options.onNote.
      + '<button type="button" class="rx-notebtn" aria-label="Write a note on this slide" aria-haspopup="dialog">' + svg('pen-line') + '<span class="rx-w">Note</span><span class="rx-count" aria-hidden="true" hidden></span></button>'
      // Ask opens the question box (createAudienceAsk); the bar only says so through options.onAsk.
      + '<button type="button" class="rx-ask" aria-label="Ask the speaker a question" aria-keyshortcuts="A" aria-haspopup="dialog">' + svg('message-circle-question-mark') + '<span>Ask</span><span class="rx-tip" aria-hidden="true">Ask the speaker<kbd>A</kbd></span></button>'
      + '<span class="rx-note" role="status" aria-live="polite"></span></div></div>'
    built = true
  }

  function render() {
    if (!visible) return
    if (!built) build()
    const bar = dock.querySelector('.rx-bar')
    const list = items()
    if (list.map((item) => item.id).join('\n') !== builtSet) buildSet(list)
    const current = marks.get(slideId(), sessionId)
    bar.classList.toggle('words', mode() === 'words')
    bar.classList.toggle('icons', mode() === 'icons')
    let shownButtons = 0
    for (const button of dock.querySelectorAll('.rx')) {
      const id = button.getAttribute('data-rx')
      const item = list.find((candidate) => candidate.id === id)
      const on = id === 'bookmark' ? current.b : current.r === id
      button.setAttribute('aria-pressed', on ? 'true' : 'false')
      const ico = button.querySelector('.rx-ico')
      if (ico && item) {
        const wanted = on && item.on ? item.on : item.icon
        if (ico.getAttribute('data-icon') !== wanted) { ico.innerHTML = svg(wanted); ico.setAttribute('data-icon', wanted) }
      }
      // Paused reactions keep the bookmark (the person's own mark) and hide the rest.
      button.hidden = !(plan.bookmark && id === 'bookmark') && !plan.meaning
      if (!button.hidden) shownButtons += 1
    }
    dock.querySelector('.rx-ask').hidden = !plan.ask
    dock.querySelector('.rx-sep').hidden = !plan.ask || shownButtons === 0
    bar.classList.toggle('no-ask', !plan.ask)
    // Note: a phone, and only when the page can open a note sheet. Its count is the slide's notes on this device.
    const withNote = phone() && Boolean(options.onNote)
    const noteButton = dock.querySelector('.rx-notebtn')
    noteButton.hidden = !withNote
    bar.classList.toggle('with-note', withNote)
    bar.classList.toggle('two-rows', withNote && Array.from(dock.querySelectorAll('.rx')).filter((button) => !button.hidden).length >= 2)
    if (withNote) {
      const count = Math.max(0, Math.floor(Number(options.getNoteCount ? options.getNoteCount(slideId()) : 0)) || 0)
      const badge = noteButton.querySelector('.rx-count')
      badge.hidden = !count
      badge.textContent = count ? String(count) : ''
      noteButton.setAttribute('aria-label', count ? 'Write a note on this slide, ' + count + (count === 1 ? ' note saved' : ' notes saved') : 'Write a note on this slide')
    }
    // Nothing to press (reactions off on this slide, or paused, questions paused, and no Note): no bar at all.
    setEmpty(shownButtons === 0 && !plan.ask && !withNote)
    // The pause line names only what this slide would have offered: a slide with no meaning
    // reaction of its own has no paused reactions to mention.
    const pausedReactions = !plan.meaning && list.some((item) => item.id !== 'bookmark')
    const pauseText = pausedReactions && !plan.ask ? 'The speaker has paused reactions and questions'
      : pausedReactions ? 'The speaker has paused reactions'
        : !plan.ask ? 'The speaker is not taking questions right now' : ''
    // A moment's note (sent, taken back, refused) wins over the standing pause line.
    const shown = note || (pauseText ? { tone: 'paused', icon: 'pause', text: pauseText } : null)
    const noteEl = dock.querySelector('.rx-note')
    const key = shown ? shown.icon + '|' + shown.text : ''
    noteEl.className = 'rx-note' + (shown ? ' ' + shown.tone : '')
    // Replaced only when it changes, so the live region announces each note once.
    if (noteEl.getAttribute('data-note') !== key) {
      noteEl.setAttribute('data-note', key)
      if (shown) { noteEl.innerHTML = svg(shown.icon) + '<span></span>'; noteEl.lastChild.textContent = shown.text } else noteEl.innerHTML = ''
    }
    fit()
    later()
  }

  // Laptop layout: the bar is as wide as the slide canvas, hugs the canvas's bottom edge, and the
  // page's own fitStage() has already refitted the slide above it. A canvas narrower than 860px turns
  // the words into tiles. On a phone the bar is the full row and none of this applies.
  function fit() {
    if (!visible || !built) return
    const wrap = dock.querySelector('.rx-wrap')
    const bar = dock.querySelector('.rx-bar')
    const stage = document.getElementById('stage')
    const box = document.getElementById('stageFit')
    if (phone() || !stage || !box) { wrap.style.width = ''; dock.style.transform = ''; bar.classList.remove('compact'); return }
    const canvas = stage.getBoundingClientRect()
    const width = Math.round(canvas.width)
    wrap.style.width = width + 'px'
    const slack = Math.max(0, Math.round((box.clientHeight - canvas.height) / 2))
    dock.style.transform = slack ? 'translateY(-' + slack + 'px)' : ''
    bar.classList.toggle('compact', width < 860 && bar.classList.contains('words'))
  }
  let refit = 0
  function later() {
    if (!win || !win.requestAnimationFrame || refit) return
    refit = win.requestAnimationFrame(() => { refit = win.requestAnimationFrame(() => { refit = 0; fit() }) })
  }

  function say(next, ms) {
    if (noteTimer !== null) cancelSchedule(noteTimer)
    noteTimer = null
    note = next
    render()
    // A note is for a moment; a queued one stays until it is sent.
    if (next && ms) noteTimer = schedule(() => { noteTimer = null; note = null; render() }, ms)
  }

  function noteFor(kind, reaction, both) {
    const label = labelOf(reaction)
    const where = device()
    if (kind === 'undo') return { tone: 'hint', icon: 'undo-2', text: phone() ? 'Reaction taken back. The speaker’s count went down by one.' : 'Taken back' }
    if (kind === 'change') return { tone: 'hint', icon: 'undo-2', text: 'Changed to ' + label + '. Tap it again to undo.' }
    if (kind === 'bookmark-off') return { tone: 'hint', icon: 'undo-2', text: 'Bookmark taken back' }
    if (kind === 'bookmark-on') {
      return both
        ? { tone: 'saved', icon: 'bookmark-check', text: 'Sent to the speaker. Bookmark saved on this ' + where + '.' }
        : { tone: 'saved', icon: 'bookmark-check', text: phone() ? 'Saved on this phone. Find it on the handout later.' : 'Bookmark saved on this device' }
    }
    return { tone: 'ok', icon: 'circle-check', text: mode() === 'words' || !phone() ? (phone() ? 'Sent to the speaker. Only they see it.' : 'Sent to the speaker') : label + ' · sent to the speaker' }
  }

  function refusal(error) {
    if (error === 'reactions_paused') return { tone: 'paused', icon: 'circle-x', text: 'The speaker has paused reactions' }
    if (error === 'participant_limit_reached' || error === 'reaction_limit_reached') return { tone: 'failed', icon: 'circle-x', text: 'Could not send. The most reactions allowed have been sent.' }
    return { tone: 'failed', icon: 'circle-x', text: 'Could not send that reaction. Try again later.' }
  }

  function tap(id) {
    const sid = slideId()
    // Only what this slide offers can be tapped (a stale button never sends).
    if (!sid || !sessionId || !itemOf(id)) return
    const before = marks.get(sid, sessionId)
    const result = reactionTap(before, id)
    const half = (marksNow) => (id === 'bookmark' ? { b: marksNow.b } : { r: marksNow.r })
    marks.set(sid, sessionId, half(result.next))
    if (options.onMarksChanged) options.onMarksChanged()
    const first = !marks.used()
    marks.markUsed()
    if (first) wordsSlide = sid
    const submissionId = options.sendReaction({
      reaction: result.reaction, slideId: sid, tMs: now(), ...(result.withdrawn ? { withdrawn: true } : {}),
      local: { before, after: result.next },
    })
    if (submissionId === false) {
      marks.set(sid, sessionId, half(before))
      if (options.onMarksChanged) options.onMarksChanged()
      say(refusal('unsent'), 6000)
      return
    }
    // The note that says it arrived waits for the ack; a tap made offline says it is waiting.
    pendingNotes.set(submissionId, noteFor(result.kind, result.reaction, result.next.r !== null))
    if (options.isConnected && !options.isConnected()) say({ tone: 'offline', icon: 'wifi-off', text: 'Will send when your ' + (phone() ? 'phone' : 'browser') + ' reconnects' }, 0)
    else render()
  }

  /** The follow client's answer for one queued reaction: `{ submissionId, status, error?, item }`. */
  function onReactionStatus(receipt) {
    const intent = pendingNotes.get(receipt.submissionId)
    pendingNotes.delete(receipt.submissionId)
    const item = receipt.item
    if (receipt.status === 'confirmed') {
      if (intent && item && item.slideId === slideId()) say(intent, 4000)
      return
    }
    // Refused: nothing was stored, so the half of the marks this tap changed must not stay on the
    // device, unless a later tap has already moved that half. The other half is never touched.
    if (item && sessionId) {
      const patch = reactionRevert(marks.get(item.slideId, sessionId), item)
      if (patch) { marks.set(item.slideId, sessionId, patch); if (options.onMarksChanged) options.onMarksChanged() }
    }
    say(refusal(receipt.error), 6000)
  }

  dock.addEventListener('click', (event) => {
    const button = event.target && event.target.closest ? event.target.closest('.rx') : null
    if (!button || !dock.contains(button)) return
    tap(button.getAttribute('data-rx'))
  })
  dock.addEventListener('click', (event) => {
    const ask = event.target && event.target.closest ? event.target.closest('.rx-ask') : null
    if (ask && dock.contains(ask) && options.onAsk) options.onAsk(ask)
  })
  dock.addEventListener('click', (event) => {
    const noteButton = event.target && event.target.closest ? event.target.closest('.rx-notebtn') : null
    if (noteButton && dock.contains(noteButton) && options.onNote) options.onNote(noteButton)
  })
  // Enter and Space belong to the focused button: they tap it and never reach the page's deck keys.
  dock.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
  })
  if (win) win.addEventListener('resize', () => render())
  const stageBox = document.getElementById('stageFit')
  if (win && win.ResizeObserver && stageBox) new win.ResizeObserver(() => later()).observe(stageBox)

  let empty = false
  let onBoard = false // a board slide (ADR-0032): the bar stays away, Ask stays available
  function sync() {
    dock.hidden = !visible || empty || onBoard
    if (document.body) document.body.classList.toggle('has-rx-bar', visible && !empty && !onBoard)
  }
  function setEmpty(next) {
    if (next === empty) return
    empty = next
    sync()
    later()
  }
  function apply() {
    visible = wanted && supported
    sync()
    if (visible) render()
  }

  return {
    startSession(id) { if (id !== sessionId) { sessionId = id; pendingNotes.clear(); note = null; plan = audienceBarPlan(null); render() } },
    /** The speaker's switches (`{ questionsAllowed, reactionsAllowed }`), from the worker's snapshot and switches.state. */
    setSwitches(next) { plan = audienceBarPlan(next); render() },
    /** Whether the speaker is taking questions (Ask is on the bar and the A key opens it). */
    questionsAllowed() { return plan.ask },
    reactionsAllowed() { return plan.meaning },
    /** Whether the bar should show (following live); it also needs a worker that takes reactions. */
    setVisible(next) { wanted = Boolean(next); apply() },
    /** Whether the worker reports a build that takes reactions (audienceReactionsSupported). */
    setSupported(next) { supported = Boolean(next); apply() },
    /** On a board slide the bar is hidden (reactions do not apply to a board), but Ask is still offered. */
    setBoardSlide(next) { onBoard = Boolean(next); sync(); later() },
    slideChanged() { if (noteTimer !== null) cancelSchedule(noteTimer); noteTimer = null; note = null; render() },
    end() { sessionId = ''; pendingNotes.clear(); note = null; plan = audienceBarPlan(null); wanted = false; supported = false; apply() },
    onReactionStatus,
    /** Whether the bar is showing: following a live talk on a worker that takes reactions. */
    isVisible() { return visible },
    /** A one-line note in the bar's own status line (for the question box to say what happened). */
    notify(next, ms) { say(next, ms) },
    /** Draw the bar again from what the device holds (My Notes removed a mark, or another tab changed one). */
    refresh() { render() },
    /** The person's own marks for a slide in the current session (for tests and My Notes). */
    marksFor(id) { return marks.get(id, sessionId) },
    allMarks() { return marks.all() },
  }
}

/** The bar's look: phone (699px and below, the page's own breakpoint) and laptop (700px and up). */
export const audienceReactionsStyles = `
.rx-dock{display:none;background:#fdfdfb;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.rx-dock[hidden]{display:none!important}
.rx-wrap{box-sizing:border-box;max-width:100%}
.rx-bar{display:flex;align-items:center;flex-wrap:wrap;box-sizing:border-box}
.rx,.rx-ask{position:relative;appearance:none;display:inline-flex;align-items:center;border:1px solid #d5d2c9;border-radius:9px;background:#fff;color:#17202a;cursor:pointer;touch-action:manipulation;font:600 14px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:-.005em;white-space:nowrap}
.rx .rx-ico{display:inline-flex}
.rx svg,.rx-ask svg{width:20px;height:20px;flex:none;color:#3d4753}
.rx-ask{border-color:#0f4bd866;color:#0f4bd8}
.rx-ask svg{color:#0f4bd8}
.rx[aria-pressed="true"]{background:#e8eefc;border-color:#0f4bd8;color:#0f4bd8;box-shadow:inset 0 0 0 1px #0f4bd8}
.rx[aria-pressed="true"] svg{color:#0f4bd8}
.rx .rx-tick{position:absolute;width:16px;height:16px;border-radius:50%;background:#0f4bd8;color:#fff;display:none;align-items:center;justify-content:center}
.rx .rx-tick svg{width:10px;height:10px;color:#fff;stroke-width:3}
.rx[aria-pressed="true"] .rx-tick{display:flex}
.rx:focus-visible,.rx-ask:focus-visible{outline:3px solid #0f4bd8;outline-offset:2px}
.rx-w{display:inline}
.rx-bar.icons .rx:not(.rx-custom) .rx-w{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.rx.rx-custom{justify-content:center;text-align:center}
.rx-note{display:inline-flex;align-items:center;gap:6px;color:#5b6572}
.rx-note:empty{display:none}
.rx-note svg{width:16px;height:16px;flex:none}
.rx-note.ok svg{color:#15803d}
.rx-note.saved svg{color:#0f4bd8}
.rx-note.hint svg,.rx-note.paused svg{color:#5b6572}
.rx-note.offline{color:#7a4d06}
.rx-note.offline svg{color:#b45309}
.rx-note.failed{color:#8c2a20}
.rx-note.failed svg{color:#8c2a20}
.rx-tip{display:none}
.rx[hidden],.rx-ask[hidden],.rx-sep[hidden],.rx-notebtn[hidden],.rx-count[hidden]{display:none!important}
.rx-notebtn{position:relative;appearance:none;display:inline-flex;align-items:center;border:1px solid #d5d2c9;border-radius:9px;background:#fff;color:#17202a;cursor:pointer;touch-action:manipulation;font:600 14px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:-.005em;white-space:nowrap}
.rx-notebtn svg{width:20px;height:20px;flex:none;color:#3d4753}
.rx-notebtn:focus-visible{outline:3px solid #0f4bd8;outline-offset:2px}
.rx-count{position:absolute;top:-6px;right:-6px;min-width:20px;height:20px;padding:0 5px;box-sizing:border-box;border-radius:10px;background:#0f4bd8;color:#fff;border:2px solid #fdfdfb;font:700 12px/16px system-ui,sans-serif;text-align:center}
.rx-bar.icons .rx-notebtn .rx-w{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

/* Phone: a bar docked under the slide, between the canvas and the slide's text. */
@media (max-width:699px){
  body.phone-detail-mode.has-rx-bar .share-shell{grid-template-rows:auto auto auto 1fr auto}
  body.phone-detail-mode .rx-dock:not([hidden]){display:block;border-top:1px solid #e3e2dc;border-bottom:1px solid #e3e2dc;padding:8px 10px}
  .rx-bar{align-items:stretch;gap:6px}
  .rx,.rx-ask,.rx-notebtn{border-color:#e3e2dc;border-radius:10px;font-size:12.5px}
  .rx-notebtn svg{width:22px;height:22px}
  .rx-ask{border-color:#0f4bd866}
  .rx svg,.rx-ask svg{width:22px;height:22px}
  .rx-sep{display:none}
  .rx-bar.words .rx,.rx-bar.words .rx-ask{flex:1 1 0;min-width:0;min-height:66px;flex-direction:column;justify-content:flex-start;gap:5px;padding:9px 4px 8px;text-align:center;white-space:normal}
  .rx-bar.words .rx-ask{flex:0 0 64px}
  .rx-bar.icons .rx:not(.rx-custom){flex:none;width:56px;height:48px;justify-content:center;padding:0}
  .rx-bar.icons .rx svg{width:24px;height:24px}
  .rx-bar.icons.no-ask .rx{flex:1 1 0;width:auto}
  .rx-bar.words .rx.rx-custom{justify-content:center}
  .rx-bar.icons .rx.rx-custom{flex:1 1 0;min-width:0;min-height:48px;padding:6px 6px;white-space:normal}
  .rx-bar.no-reactions .rx-ask{flex:1 1 auto;flex-direction:row;justify-content:center;gap:7px;min-height:48px;height:48px;margin-left:0;padding:0 18px;font-size:15px}
  .rx-bar.icons .rx-ask{margin-left:auto;gap:7px;height:48px;padding:0 18px;font-size:15px}
  /* Note beside Ask: words in two rows on first use, icons in one row after (the tiles give up width to fit 360px). */
  .rx-bar.words.with-note.two-rows{flex-wrap:wrap}
  .rx-bar.words.with-note.two-rows .rx{flex:1 1 28%}
  .rx-bar.words.with-note .rx-notebtn,.rx-bar.words.with-note .rx-ask{flex:1 1 42%;min-width:0;min-height:48px;height:48px;flex-direction:row;align-items:center;justify-content:center;gap:8px;padding:0 12px;font-size:15px}
  .rx-bar.words.with-note .rx-notebtn svg,.rx-bar.words.with-note .rx-ask svg{width:22px;height:22px}
  .rx-bar.icons.with-note .rx{flex:0 1 56px;width:auto;min-width:44px}
  .rx-bar.icons.with-note .rx-notebtn{flex:0 1 56px;min-width:44px;height:48px;margin-left:auto;justify-content:center;padding:0}
  .rx-bar.icons.with-note .rx-notebtn svg{width:24px;height:24px}
  .rx-bar.icons.with-note .rx-ask{margin-left:0;padding:0 14px;flex:none}
  .rx-bar.icons.with-note.no-ask .rx,.rx-bar.icons.with-note.no-ask .rx-notebtn{flex:1 1 0;width:auto;margin-left:0}
  .rx .rx-tick{top:4px;right:4px}
  .rx-bar.icons .rx .rx-tick{top:3px;right:3px}
  .rx-note{flex:1 0 100%;box-sizing:border-box;margin:1px 2px 0;font-size:12.5px;min-height:18px}
}

/* Laptop: one row under the slide, as wide as the slide canvas, and the slide refits above it. */
@media (min-width:700px){
  body.has-rx-bar .share-shell{grid-template-rows:minmax(0,1fr) auto auto}
  .rx-dock:not([hidden]){display:flex;justify-content:center;padding:6px 0 8px}
  .rx-bar{gap:8px;min-height:40px;padding:0 12px}
  .rx,.rx-ask{gap:8px;height:40px;padding:0 14px}
  .rx:hover,.rx-ask:hover{background:#f4f6fb;border-color:#aeb8cc}
  .rx-ask:hover{background:#e8eefc;border-color:#0f4bd8}
  .rx-sep{width:1px;height:24px;background:#d5d2c9;margin:0 4px;flex:none}
  .rx-bar.icons .rx:not(.rx-custom){width:48px;padding:0;justify-content:center}
  .rx-bar.icons .rx svg{width:22px;height:22px}
  .rx-bar.compact.words .rx{flex:1 1 0;min-width:0;height:auto;min-height:62px;align-self:stretch;flex-direction:column;justify-content:flex-start;gap:4px;padding:8px 4px 6px;text-align:center;white-space:normal;font-size:13px}
  .rx-bar.compact.words .rx-ask{height:auto;min-height:62px;align-self:stretch;flex-direction:column;justify-content:flex-start;gap:4px;padding:8px 14px 6px}
  .rx-bar.compact .rx-sep{display:none}
  .rx .rx-tick{top:-5px;right:-5px;border:1.5px solid #fdfdfb;box-sizing:content-box}
  .rx-note{margin-left:6px;font-size:13.5px;min-height:40px}
  .rx-bar.compact .rx-note{flex:1 0 100%;box-sizing:border-box;margin-left:0;padding-left:2px;min-height:22px}
  .rx-tip{position:absolute;left:0;bottom:calc(100% + 8px);z-index:30;padding:6px 10px;border-radius:7px;background:#17202a;color:#fff;font:500 13px/1.25 system-ui,-apple-system,"Segoe UI",sans-serif;white-space:nowrap;pointer-events:none;box-shadow:0 6px 18px #0004}
  .rx-tip::after{content:"";position:absolute;left:19px;top:100%;border:5px solid transparent;border-top-color:#17202a}
  .rx:hover .rx-tip,.rx-ask:hover .rx-tip,.rx:focus-visible .rx-tip,.rx-ask:focus-visible .rx-tip{display:block}
  .rx-tip kbd{display:inline-block;margin-left:8px;padding:1px 6px;border:1px solid #ffffff55;border-radius:4px;font:600 12px/1.3 ui-monospace,Menlo,monospace;color:#fff}
  .rx-bar.words .rx .rx-tip{display:none!important}
}
`

export function audienceReactionsRuntimeSource() {
  return [audienceReactionIcons, audienceReactionsSupported, audienceReactionRegistry, audienceSlideReactions, audienceBarPlan, reactionTap, reactionRevert, createReactionMarks, createAudienceReactions]
    .map((fn) => fn.toString()).join('\n')
}
