// The handout home page, live first (design 2026-10-02, direction B "Live takes over"). The page people
// reach from the QR code and the short link is the handout bundle itself built in home mode
// (buildShareHtml({ home })): the same slides, the same live client (createAudienceFollowRuntime), the
// same poll card, reaction bar, Ask and My Notes storage. This module only arranges them:
//
//  - not live: the handout home (title, meta, Open slides / My Notes / Download, pre-work, links, QR),
//    with a quiet "Not live yet" line while a planned start time is ahead;
//  - live: a Live | Handout switch that opens on Live. Live shows the deck's own stage (the slide the
//    speaker is on), the poll surface and the reaction dock, moved here from the slides view;
//  - a person who picks Handout during the talk stays there; an answerable poll then marks the Live tab;
//  - when the session ends the switch goes and the page is the handout again, without a reload.
//
// Each function is embedded in the page by `.toString()` (handoutHomeRuntimeSource), so it is
// self-contained: no module-level constants, no imports.

/**
 * @param {{ document: Document, slideCount: number, titleHtml: (index: number) => string,
 *   startsAt?: number | null, now?: () => number, openMyNotes?: () => void, onShowLive?: () => void,
 *   onStageShown?: (showing: boolean) => void (the Live pane, which holds the stage, came or went),
 *   parts?: { stage?: Element | null, poll?: Element | null, board?: Element | null, reactions?: Element | null } }} options
 */
export function createHandoutHome(options) {
  const doc = options.document
  const root = doc.getElementById('handoutHome')
  if (!root) return null
  const tabs = doc.getElementById('hhTabs')
  const livePane = doc.getElementById('hhLive')
  const handoutPane = doc.getElementById('hhHandout')
  const liveTab = doc.getElementById('hhTabLive')
  const handoutTab = doc.getElementById('hhTabHandout')
  const badge = doc.getElementById('hhPollBadge')
  const quiet = doc.getElementById('hhNotLive')
  const caption = doc.getElementById('hhSlideNum')
  const title = doc.getElementById('hhSlideTitle')
  const now = options.now || (() => Date.now())
  const parts = options.parts || {}
  // The slides view's own pieces, moved (not copied) into the Live pane: one stage, one poll card, one bar.
  const slot = (id, node) => { const host = doc.getElementById(id); if (host && node) host.appendChild(node) }
  slot('hhStageSlot', parts.stage)
  slot('hhPollSlot', parts.poll)
  slot('hhPollSlot', parts.board)
  slot('hhRxSlot', parts.reactions)
  const pollMount = parts.poll || null
  const boardMount = parts.board || null

  let live = false
  let view = 'handout'
  // What the person chose during this session; cleared when the session ends.
  let chosen = null
  let slideIndex = 0
  // A full-screen instant slide the speaker put up; held back while the person is on Handout.
  let instant = false
  // Whether the Live pane (and so the stage inside it) was showing at the last paint.
  let stageShown = null

  function pollShowing() { return Boolean(pollMount && !pollMount.hidden && pollMount.querySelector('.poll-card')) }
  function pollAnswerable() { return Boolean(pollShowing() && pollMount.querySelector('.poll-submit')) }
  function boardShowing() { return Boolean(boardMount && !boardMount.hidden) }
  // What the Live tab says while the person is on Handout: an answerable poll, an open board, a new instant slide.
  function badgeText() {
    if (pollAnswerable()) return 'Poll open \u2014 answer'
    if (instant) return 'New on screen'
    if (boardShowing()) return 'Board open \u2014 add a card'
    return ''
  }
  function upcoming() { return typeof options.startsAt === 'number' && Number.isFinite(options.startsAt) && now() < options.startsAt }
  function sameDay(a, b) { const x = new Date(a), y = new Date(b); return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate() }
  function paintQuiet() {
    if (!quiet) return
    const show = !live && upcoming()
    quiet.hidden = !show
    if (!show) return
    const text = quiet.querySelector('.hh-quiet-text')
    const words = sameDay(now(), options.startsAt) ? quiet.dataset.today : quiet.dataset.later
    if (text && words) text.textContent = words
  }
  function paint() {
    const showLive = live && view === 'live'
    root.dataset.live = live ? 'on' : 'off'
    root.dataset.view = showLive ? 'live' : 'handout'
    if (tabs) tabs.hidden = !live
    if (livePane) livePane.hidden = !showLive
    if (handoutPane) handoutPane.hidden = showLive
    for (const [tab, on] of [[liveTab, showLive], [handoutTab, !showLive]]) {
      if (!tab) continue
      tab.classList.toggle('on', on)
      tab.setAttribute('aria-selected', on ? 'true' : 'false')
    }
    root.classList.toggle('hh-has-poll', pollShowing() || boardShowing())
    const words = live && !showLive ? badgeText() : ''
    if (badge) { badge.hidden = !words; if (words) badge.textContent = words }
    paintQuiet()
    if (showLive !== stageShown) { stageShown = showLive; options.onStageShown?.(showLive) }
  }
  function select(next) {
    if (next !== 'live' && next !== 'handout') return
    const wasLive = view === 'live'
    view = next
    chosen = next
    paint()
    if (next === 'live' && !wasLive) options.onShowLive?.()
    if ((next === 'live') !== wasLive) options.onViewChanged?.(next)
  }
  function setLive(next) {
    next = Boolean(next)
    if (next === live) { paint(); return }
    live = next
    if (live) view = chosen || 'live'
    else { view = 'handout'; chosen = null; instant = false }
    paint()
    if (live && view === 'live') options.onShowLive?.()
  }
  function slideChanged(index) {
    slideIndex = Math.max(0, Number(index) || 0)
    if (caption) caption.textContent = 'Slide ' + (slideIndex + 1) + ' of ' + options.slideCount + ' · follows the speaker'
    // The compiler's renderer built this title HTML (escaped, no links); nothing else reaches innerHTML.
    if (title) title.innerHTML = options.titleHtml(slideIndex) || ''
    // The phone's poll layout heads the small slide with its number ("Slide 9 · …").
    if (title) title.setAttribute('data-num', 'Slide ' + (slideIndex + 1) + ' \u00b7 ')
  }

  liveTab?.addEventListener('click', () => select('live'))
  handoutTab?.addEventListener('click', () => select('handout'))
  doc.querySelectorAll('[data-hh-my-notes]').forEach((button) => button.addEventListener('click', () => options.openMyNotes?.()))
  // The poll runtime shows and hides its own mount; the Live pane and the tab badge follow it.
  if (typeof MutationObserver === 'function') {
    for (const mount of [pollMount, boardMount]) {
      if (mount) new MutationObserver(() => paint()).observe(mount, { attributes: true, attributeFilter: ['hidden'], childList: true })
    }
  }
  // A page left open past the planned start: the quiet line goes when the time comes.
  if (typeof options.startsAt === 'number') {
    const timer = (doc.defaultView || globalThis).setInterval?.(() => { paintQuiet(); if (!upcoming() && timer) (doc.defaultView || globalThis).clearInterval(timer) }, 30000)
  }
  slideChanged(0)
  paint()
  function setInstant(slide) { instant = Boolean(slide); paint() }
  return { setLive, select, slideChanged, setInstant, view: () => (live && view === 'live' ? 'live' : 'handout'), isLive: () => live }
}

export function handoutHomeRuntimeSource() {
  return [createHandoutHome].map((fn) => fn.toString()).join('\n')
}

/** The home page's look: phone (699px and below, the handout's breakpoint) and laptop. */
export const handoutHomeStyles = `
body.hh-mode{background:#f7f3ea;color:#17202a;font-family:-apple-system,system-ui,"Segoe UI",sans-serif}
body.hh-mode .share-shell,body.hh-mode .help-fab{display:none!important}
body.hh-mode .nav-panel:not(.open),body.hh-mode .notes-panel:not(.open),body.hh-mode .mynotes-panel:not(.open){box-shadow:none}
.handout-home{min-height:100vh;box-sizing:border-box}
.handout-home *{box-sizing:border-box}
.handout-home [hidden]{display:none!important}
.hh-tabs{display:flex;background:#fff;border-bottom:1px solid #e3e2dc;position:sticky;top:0;z-index:5}
.hh-tab{appearance:none;position:relative;display:flex;align-items:center;justify-content:center;gap:8px;flex:1;min-height:48px;padding:0 14px;border:0;border-bottom:3px solid transparent;background:none;color:#5c6570;font:600 15px/1.2 -apple-system,system-ui,"Segoe UI",sans-serif;cursor:pointer;touch-action:manipulation}
.hh-tab.on{color:#0f4bd8;border-bottom-color:#0f4bd8;font-weight:700}
.hh-tab:focus-visible{outline:3px solid #0f4bd855;outline-offset:-3px}
.hh-tab .live-dot{flex:none}
.hh-tab-notes{display:none}
.hh-badge{display:inline-flex;align-items:center;gap:5px;border-radius:999px;background:#e8eefc;color:#0f4bd8;padding:2px 8px;font-size:11.5px;font-weight:700;white-space:nowrap}
.hh-badge::before{content:"";width:6px;height:6px;border-radius:50%;background:#0f4bd8}
.hh-home{padding:18px 16px 40px;max-width:760px;margin:0 auto}
.hh-home h1{max-width:none;width:auto;text-wrap:wrap;font-family:Georgia,serif;font-weight:500;font-size:30px;line-height:1.15;margin:6px 0 6px;letter-spacing:-.01em;overflow-wrap:anywhere}
.hh-meta{margin:0 0 16px;color:#5b6470;font-size:14px}
.hh-actions{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
.hh-btn{appearance:none;display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0 18px;border-radius:10px;border:2px solid #0b3a6b;background:none;color:#0b3a6b;font:600 16px/1.2 -apple-system,system-ui,"Segoe UI",sans-serif;text-decoration:none;cursor:pointer;touch-action:manipulation}
.hh-btn.primary{background:#0b3a6b;color:#fff}
.hh-btn b{font-weight:500;opacity:.75;font-size:13px}
.hh-btn:focus-visible{outline:3px solid #0f4bd855;outline-offset:2px}
.hh-card{background:#fff;border:1px solid #e3e2dc;border-radius:12px;padding:12px 14px;margin-bottom:12px}
.hh-card h2{max-width:none;width:auto;text-wrap:wrap;margin:0 0 6px;font:500 12px/1.3 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:#5c6570}
.hh-row{display:flex;justify-content:space-between;gap:10px;align-items:center;min-height:44px;border-top:1px solid #efece3;font-size:15px;color:#17202a;text-decoration:none}
.hh-row:first-of-type{border-top:0}
.hh-row i{font-style:normal;color:#0f4bd8;font-size:13px;white-space:nowrap}
.hh-row:focus-visible{outline:3px solid #0f4bd855;outline-offset:2px}
.hh-share{display:flex;align-items:center;gap:14px;margin-top:6px;color:#5b6470;font-size:13px}
.hh-share p{margin:0;overflow-wrap:anywhere}
.hh-share b{color:#17202a}
.hh-qr{width:84px;flex:none;background:#fff;padding:6px;border-radius:6px}
.hh-qr svg{width:100%;height:auto;display:block}
.hh-quiet{display:flex;gap:10px;align-items:flex-start;margin:12px 16px 0;padding:10px 12px;border:1px dashed #cfc9b8;border-radius:10px;color:#5b6470;font-size:14px;line-height:1.4;background:#fbf8ef}
.hh-quiet-dot{flex:none;width:8px;height:8px;border-radius:50%;background:#a9a392;margin-top:5px}
.hh-live-grid{display:block}
.hh-slide .stage-fit{display:block!important;position:relative;width:100%;aspect-ratio:16/9;max-height:none!important;height:auto;background:#fff;overflow:hidden}
.hh-cap{padding:10px 14px}
.hh-cap span{font:600 12px/1.3 ui-monospace,Menlo,monospace;color:#5c6570;letter-spacing:.04em}
.hh-cap h3{margin:4px 0 0;font-size:18px;line-height:1.25;overflow-wrap:anywhere}
.hh-idle{display:none}
.handout-home .audience-poll-surface{position:static!important;inset:auto;display:block;width:auto;min-height:0;height:auto;max-width:none;padding:0;background:none;z-index:auto;place-items:initial}
.handout-home .audience-poll-surface[hidden]{display:none!important}
.handout-home .audience-poll-surface > .poll-card{width:100%;max-height:none;overflow:visible;padding:8px 14px 4px;border:0;border-radius:0;box-shadow:none;background:none}
.handout-home .poll-allowance{width:100%;background:none;padding:8px 12px 0}
body.hh-mode .handout-home .bd-panel:not([hidden]){display:block!important;border:0;background:none}
.hh-rx .rx-dock:not([hidden]){display:block;border-top:1px solid #e3e2dc;padding:8px 10px;margin-top:8px}
@media (max-width:699px){
  .hh-has-poll .hh-stagecol{display:flex;gap:10px;align-items:center;padding:10px 14px 4px}
  .hh-has-poll .hh-slide{width:84px;flex:none;border:1px solid #e3e2dc}
  .hh-has-poll .hh-cap{padding:0;min-width:0}
  .hh-has-poll .hh-cap span{display:none}
  .hh-has-poll .hh-cap h3{margin:0;font-size:13px;font-weight:700}
  .hh-has-poll .hh-cap h3::before{content:attr(data-num)}
}
@media (min-width:700px){
  .hh-tabs{padding:0 24px}
  .hh-tab{flex:none;padding:0 22px}
  .hh-tab-notes{display:flex}
  .hh-home{max-width:980px;padding:28px 24px}
  .hh-home h1{font-size:42px}
  .hh-cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;align-items:start}
  .hh-quiet{max-width:932px;margin:16px auto 0}
  .hh-live-grid{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:26px;padding:24px;align-items:start}
  .hh-slide .stage-fit{border:1px solid #e3e2dc;border-radius:10px}
  .hh-cap{padding:12px 2px}
  .hh-cap h3{font-size:24px}
  .hh-panel{background:#fff;border:1px solid #e3e2dc;border-radius:14px;padding:14px}
  .hh-idle{display:block}
  .hh-has-poll .hh-idle{display:none}
  .hh-idle h4{margin:2px 0 6px;font-size:19px}
  .hh-idle p{margin:0 0 8px;color:#5b6470;font-size:15px;line-height:1.45}
  .handout-home .audience-poll-surface > .poll-card{padding:4px 2px}
  body.hh-mode .handout-home .bd-panel:not([hidden]){display:flex!important;flex-direction:column;margin:-14px;border:0}
  .hh-rx .rx-dock:not([hidden]){display:flex;justify-content:flex-start;border:0;padding:0;margin-top:10px;background:none}
  .hh-rx .rx-bar{padding:0}
}
`
