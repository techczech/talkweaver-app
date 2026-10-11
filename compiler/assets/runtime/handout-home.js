// The handout home page (locked design 2026-10-07, "Handout 4b": the navy band holds the actions). The
// page people reach from the QR code and the short link is the handout bundle itself built in home mode
// (buildShareHtml({ home })): the same slides, the same live client (createAudienceFollowRuntime), the
// same poll card, board, reaction bar, Ask and My Notes storage. This module only picks which of the
// page's three layouts shows and puts the shared pieces in it:
//
//  - before: as far as the page knows the talk has not started (a planned start is ahead, or there is no
//    start time and the Run has pre-work). The band asks the person to get ready;
//  - live: a session is live. No switch to the handout: the band shrinks to the title and "Live now",
//    and the page is the speaker's slide with the reactions, Note and Ask straight under it, then the
//    poll or board (beside it from 1200px). The person can step back and forward through the slides and
//    return to the speaker's slide (live-step.js decides; Dominik 2026-10-08), and put the slide full
//    screen;
//  - handout: everything else, and always once a session this page saw has ended. The first slide as the
//    cover, what the person kept ("From your session"), the links, the download.
//
// A live session moves the page to "live" and its end moves it to "handout", without a reload.
//
// The function is embedded in the page by `.toString()` (handoutHomeRuntimeSource), so it is
// self-contained: no module-level constants, no imports. The stylesheet is handout-home-styles.js.

/**
 * @param {{ document: Document, slideCount: number, titleHtml: (index: number) => string,
 *   startsAt?: number | null, now?: () => number, liveConfigured?: boolean,
 *   openMyNotes?: () => void, onShowLive?: () => void, onShowCover?: () => void,
 *   onStageShown?: (showing: boolean) => void (the live layout, which holds the running stage, came or went),
 *   gatherNotes?: () => { groups: Array<{ items: Array<{ kind: string }> }> },
 *   parts?: { stage?: HTMLElement | null, poll?: Element | null, board?: Element | null, reactions?: Element | null },
 *   lookAhead?: boolean (the talk lets people step past the speaker's slide; default true),
 *   steps?: { view: Function, target: Function, caption: Function } (live-step.js's liveStepView, liveStepTarget, liveStepCaption),
 *   onStep?: (index: number) => void (show this slide; the page stops following the speaker),
 *   onReturnToSpeaker?: () => void (follow the speaker again),
 *   onFullScreen?: (on: boolean) => void (the slide went full screen or came back) }} options
 */
export function createHandoutHome(options) {
  const doc = options.document
  const root = doc.getElementById('handoutHome')
  if (!root) return null
  const win = doc.defaultView || globalThis
  const livePane = doc.getElementById('hhLive')
  const page = doc.getElementById('hhPage')
  const stageSlot = doc.getElementById('hhStageSlot')
  const coverSlot = doc.getElementById('hhCoverSlot')
  const liveCol = doc.getElementById('hhLiveCol')
  const caption = doc.getElementById('hhSlideNum')
  const title = doc.getElementById('hhSlideTitle')
  const announce = doc.getElementById('hhAnnounce')
  const session = doc.getElementById('hhSession')
  const notesBadge = doc.getElementById('hhNotesCount')
  const notesButton = doc.getElementById('hhMyNotes')
  const slideBox = doc.getElementById('hhSlideBox')
  const capLine = doc.getElementById('hhCap')
  const rxSlot = doc.getElementById('hhRxSlot')
  const backButton = doc.getElementById('hhStepBack')
  const forwardButton = doc.getElementById('hhStepForward')
  const toSpeaker = doc.getElementById('hhToSpeaker')
  const fullButton = doc.getElementById('hhFull')
  const fullWord = doc.getElementById('hhFullWord')
  const steps = options.steps || null
  const lookAhead = options.lookAhead !== false
  const now = options.now || (() => Date.now())
  const parts = options.parts || {}
  const stage = parts.stage || null
  const hasPrework = root.dataset.prework === 'yes'
  // The slides view's own pieces, moved (not copied): the bar straight under the slide, then one poll card
  // and one board.
  if (parts.reactions && (rxSlot || liveCol)) (rxSlot || liveCol).appendChild(parts.reactions)
  for (const node of [parts.poll, parts.board]) if (liveCol && node) liveCol.appendChild(node)

  let live = false
  // A session this page saw: once it ends the talk has been given, whatever the planned start says.
  let beenLive = false
  // Whether the page has heard if a session is live. Until then the cover slide stays undrawn, so a
  // phone that is about to go live fetches the speaker's slide first, not slide 1 (lazy-slide-assets.js).
  let known = !options.liveConfigured
  let shown = ''
  let coverDrawn = false
  // Live stepping: the speaker's slide (null until the live service names one), whether the page follows
  // the speaker, and the slide on screen.
  let speaker = null
  let following = true
  let viewer = 0
  let full = false
  // Whether the live layout (the only one where a page on the stage's slide runs) showed at the last paint.
  let stageShown = null

  function upcoming() { return typeof options.startsAt === 'number' && Number.isFinite(options.startsAt) && now() < options.startsAt }
  function layout() {
    if (live) return 'live'
    const before = typeof options.startsAt === 'number' ? upcoming() : hasPrework
    return before && !beenLive ? 'before' : 'handout'
  }
  // What the person kept on this device, counted from My Notes' own read model.
  function kept() {
    let groups = []
    try { groups = (options.gatherNotes && options.gatherNotes().groups) || [] } catch { groups = [] }
    const has = (group, kind) => group.items.some((item) => item.kind === kind)
    return {
      slides: groups.length,
      notes: groups.filter((group) => has(group, 'note')).length,
      bookmarks: groups.filter((group) => has(group, 'bookmark')).length,
      questions: groups.reduce((sum, group) => sum + group.items.filter((item) => item.kind === 'question').length, 0),
    }
  }
  function paintKept(next) {
    const counts = kept()
    if (notesBadge) { notesBadge.hidden = !counts.slides; notesBadge.textContent = counts.slides ? String(counts.slides) : '' }
    if (notesButton) {
      if (counts.slides) notesButton.setAttribute('aria-label', 'My notes, ' + counts.slides + (counts.slides === 1 ? ' slide' : ' slides'))
      else notesButton.removeAttribute('aria-label')
    }
    if (!session) return
    const words = { notes: counts.notes + (counts.notes === 1 ? ' slide' : ' slides'), bookmarks: String(counts.bookmarks), questions: String(counts.questions) }
    let any = false
    session.querySelectorAll('[data-hh-kept]').forEach((row) => {
      const kind = row.getAttribute('data-hh-kept')
      const on = counts[kind] > 0
      row.hidden = !on
      any = any || on
      const count = row.querySelector('[data-hh-count]')
      if (count) count.textContent = on ? words[kind] : ''
    })
    session.hidden = next !== 'handout' || !any
  }
  function paint() {
    const next = layout()
    root.dataset.layout = next
    root.querySelectorAll('[data-hh-for]').forEach((el) => { el.hidden = !String(el.getAttribute('data-hh-for')).split(' ').includes(next) })
    if (livePane) livePane.hidden = next !== 'live'
    if (page) page.hidden = next === 'live'
    paintKept(next)
    // One stage: the speaker's slide while live, the cover (slide 1) on the handout, nothing before the talk.
    const host = next === 'live' ? stageSlot : coverSlot
    if (stage && host && stage.parentNode !== host) host.appendChild(stage)
    const cover = next === 'handout' && known
    if (stage) stage.hidden = !(next === 'live' || cover)
    const changed = next !== shown
    if (changed && shown && announce) {
      announce.textContent = next === 'live' ? 'The talk is live. This page now shows the slide the speaker is on.'
        : shown === 'live' ? 'The live session has ended. This page is the handout again.' : ''
    }
    shown = next
    if (changed && next !== 'live') setFull(false)
    if (changed && next === 'live') options.onShowLive?.()
    if (cover && (changed || !coverDrawn)) options.onShowCover?.()
    coverDrawn = cover
    const liveShowing = next === 'live'
    if (liveShowing !== stageShown) { stageShown = liveShowing; options.onStageShown?.(liveShowing) }
  }
  function setLive(next) {
    known = true
    live = Boolean(next)
    if (live) beenLive = true
    paint()
    paintStep()
  }
  // What stepping shows, from live-step.js. Without it (an old page) the page only follows.
  function stepView() {
    const input = { speaker, viewer, following, slideCount: options.slideCount, lookAhead }
    if (steps) return steps.view(input)
    return { shown: viewer, following: true, speaker: null, canBack: false, canForward: false, ahead: false, behind: false }
  }
  function paintStep() {
    // On screen: the slide the page has. "Following" is the live client's word, or the speaker's own slide.
    const view = stepView()
    const shownView = { ...view, shown: viewer, following: view.speaker === null || following || viewer === view.speaker }
    if (caption) caption.textContent = steps ? steps.caption(shownView, options.slideCount) : 'Slide ' + (viewer + 1) + ' of ' + options.slideCount + ' · moves with the speaker'
    if (capLine) capLine.classList.toggle('hh-away', !shownView.following)
    const stepping = Boolean(steps && view.speaker !== null && live)
    const allowed = stepping ? steps.view({ speaker, viewer, following: false, slideCount: options.slideCount, lookAhead }) : null
    if (backButton) { backButton.hidden = !stepping; backButton.disabled = !(allowed && allowed.canBack) }
    if (forwardButton) {
      forwardButton.hidden = !stepping
      forwardButton.disabled = !(allowed && allowed.canForward)
      forwardButton.title = allowed && !allowed.canForward && !lookAhead && viewer >= (speaker ?? 0) ? 'This talk shows the slides as the speaker reaches them' : 'Next slide (right arrow)'
    }
    if (toSpeaker) toSpeaker.hidden = !(stepping && !shownView.following)
  }
  function slideChanged(index) {
    const at = Math.max(0, Number(index) || 0)
    viewer = at
    paintStep()
    // The compiler's renderer built this title HTML (escaped, no links); nothing else reaches innerHTML.
    if (title) title.innerHTML = options.titleHtml(at) || ''
  }
  // The live client's follow state changed: the speaker's slide (an index, or null) and whether it follows.
  // A talk with looking ahead off never leaves a person past the speaker; a person the speaker reaches is
  // following again.
  let correcting = false
  function followChanged(state) {
    speaker = state && Number.isInteger(state.speaker) && state.speaker >= 0 ? state.speaker : null
    following = !state || state.following !== false
    if (!live || speaker === null || correcting) { paintStep(); return }
    const view = stepView()
    correcting = true
    try {
      if (view.following && !following) options.onReturnToSpeaker?.()
      else if (view.shown !== viewer) options.onStep?.(view.shown)
    } finally { correcting = false }
    paintStep()
  }
  function step(delta) {
    if (!steps || !live || speaker === null) return
    const target = steps.target(steps.view({ speaker, viewer, following: false, slideCount: options.slideCount, lookAhead }), delta)
    if (!target) return
    if (target.follow) options.onReturnToSpeaker?.()
    else options.onStep?.(target.to)
  }
  // Full screen: the slide and its step bar fill the window (and the screen, where the browser allows it).
  // Esc or the same button leave it. A poll or board that opens takes the person out of it, to answer.
  function setFull(next) {
    next = Boolean(next) && live
    if (next === full) return
    full = next
    if (slideBox) slideBox.classList.toggle('hh-full', full)
    if (doc.body) doc.body.classList.toggle('hh-full-open', full)
    if (fullButton) { fullButton.setAttribute('aria-pressed', full ? 'true' : 'false'); fullButton.title = full ? 'Leave full screen (Esc)' : 'Full screen (Esc leaves it)' }
    if (fullWord) fullWord.textContent = full ? 'Exit full screen' : 'Full screen'
    const page = doc.documentElement
    try {
      if (full && page && page.requestFullscreen && !doc.fullscreenElement) { const pending = page.requestFullscreen(); if (pending && pending.catch) pending.catch(() => {}) }
      if (!full && doc.fullscreenElement && doc.exitFullscreen) { const pending = doc.exitFullscreen(); if (pending && pending.catch) pending.catch(() => {}) }
    } catch { /* the window-filling view stands without the browser's full screen */ }
    options.onFullScreen?.(full)
    if (fullButton && full) fullButton.focus?.()
  }
  doc.addEventListener('fullscreenchange', () => { if (!doc.fullscreenElement && full) setFull(false) })
  backButton?.addEventListener('click', () => step(-1))
  forwardButton?.addEventListener('click', () => step(1))
  toSpeaker?.addEventListener('click', () => options.onReturnToSpeaker?.())
  fullButton?.addEventListener('click', () => setFull(!full))
  const typing = (target) => Boolean(target && target.closest && target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))
  doc.addEventListener('keydown', (event) => {
    if (!live || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === 'Escape' && full) { event.preventDefault(); setFull(false); return }
    if (typing(event.target) || doc.querySelector('.ask-panel, .mynotes-panel.open')) return
    if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1) }
    else if (event.key === 'ArrowRight') { event.preventDefault(); step(1) }
  })
  // The poll card or the board coming up: out of full screen.
  const PanelObserver = win.MutationObserver
  if (PanelObserver) {
    const showing = (node) => Boolean(node && !node.hidden && node.childElementCount)
    let had = showing(parts.poll) || showing(parts.board)
    const watch = new PanelObserver(() => {
      const has = showing(parts.poll) || showing(parts.board)
      if (has && !had && full) setFull(false)
      had = has
    })
    for (const node of [parts.poll, parts.board]) if (node) watch.observe(node, { attributes: true, attributeFilter: ['hidden'], childList: true })
  }

  doc.querySelectorAll('[data-hh-my-notes]').forEach((button) => button.addEventListener('click', () => options.openMyNotes?.()))
  // A live service that never answers: the cover is drawn after a short wait all the same.
  if (!known) win.setTimeout?.(() => { if (!known) { known = true; paint() } }, 3000)
  // A page left open past the planned start is no longer "before the talk".
  if (upcoming()) {
    const timer = win.setInterval?.(() => { paint(); if (!upcoming() && timer) win.clearInterval(timer) }, 30000)
  }
  slideChanged(0)
  paint()
  return { setLive, slideChanged, followChanged, step, setFullScreen: setFull, isFullScreen: () => full, refresh: paint, layout: () => shown, isLive: () => live }
}

export function handoutHomeRuntimeSource() {
  return [createHandoutHome].map((fn) => fn.toString()).join('\n')
}
