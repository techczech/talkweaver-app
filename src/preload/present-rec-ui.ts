/// <reference lib="dom" />
// The recording UI the recording preload injects into the presenter window: the REC cluster in
// the status bar, its four toasts (start offer, recording paused, save run, saved), the run-kind
// picker and the keys (⇧R record/stop, ⇧P pause/resume, L save run as…; registered in the
// presenter scope of the shortcut registry, which also lists them on the ? sheet). ADR-0031 §3, presenter redesign ticket 03; drawn in
// docs/design/2026-09-26-presenter-redesign/round-2/ (shots rec-*, toast-*).
//
// What the cluster shows for each recorder state is present-rec-view.ts (pure). The cluster and
// the toasts carry their own styles (REC_CSS, the chrome type scale: 16px recorded length, 14px
// toast text, 13px status words and small buttons); the template's status-bar stylesheet owns
// only the collapse steps c5 (status word goes) and c6 (Record and Change icon-only).
//
// The kind of run is chosen when saving (the save toast's "Save as…", Change, or L), never when a
// recording starts (ADR-0031 §3).

import { showPresentationCloseOffer } from './present-close-flow'
import { RECORDING_OFFER_VISIBLE_MS } from './present-recording-offer'
import { recView, fmtClock, kindLabel, type RecButton, type RunKind } from './present-rec-view'
import type { RecorderController } from './present-recorder'
import { dressPresenterButton, presenterControl, presenterControlKeys, presenterIconSvg } from '../shared/presenter-controls.ts'
import { SHORTCUT_REGISTRY } from '../shared/shortcut-registry.ts'

/** How long the "Saved to History" toast stays up if ignored (the same as the start offer). */
export const SAVED_TOAST_VISIBLE_MS = RECORDING_OFFER_VISIBLE_MS

const REC_CSS = `
  #twrec-module, .twrec-toast { --lt-amber:#a3630e; --lt-amber-bright:#d98a2b; --lt-red-live:#ec5b56;
    --twrec-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,monospace;
    --twrec-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    --rec-text:#f7f3ea; --rec-muted:#a3b3c2; --rec-dim:#71849a; --rec-line:#ffffff1c; --rec-ctl:#1f2c39; --rec-ctl-hover:#283a4c;
    --rec-red:#ef4444; --rec-amber:#f5b64a; --rec-amber-bg:#3a2a10; --rec-blue:#5b93f0; --rec-primary:#2f6db5; --rec-ok:#3fb970;
    --rec-ui:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;
    --rec-mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,monospace; }
  /* The controls set display:inline-flex, which outranks the UA [hidden]{display:none} rule —
     so state-hidden parts need this explicit !important, or every control shows at once. */
  #twrec-module [hidden], .twrec-toast [hidden] { display: none !important; }
  /* The generic recording button (the close dialog uses it too). */
  .rec-btn { display:inline-flex; align-items:center; gap:6px; background:#26333f; border:1px solid #ffffff26;
    color:#eef3f9; border-radius:6px; padding:5px 9px; font-size:0.76rem; font-weight:600; white-space:nowrap; }
  .rec-btn:hover { border-color:#6ea8e6; background:#2c3b49; }
  .rec-btn.amber { background:#3a2c12; border-color:#7a5a22; color:#f0d5a0; }
  .rec-btn.amber:hover { border-color:var(--lt-amber-bright); background:#46340f; }
  .rec-btn.keep { background:#12261a; border-color:#2f6b45; color:#a8e0bf; }
  .rec-btn.keep:hover { border-color:#3fa066; background:#173224; }
  .rec-btn.ghost { background:#17212b; border-color:#ffffff20; color:#d9e3ed; }
  .rec-btn.ghost:hover { border-color:#6ea8e6; background:#1d2b38; }
  .tw-center-cluster { display:flex; align-items:center; gap:12px; flex:0 0 auto; }
  .tw-center-cluster .cluster-divider { width:1px; height:30px; background:#ffffff1f; flex:none; }

  /* The REC cluster (status bar). */
  #twrec-module { display:inline-flex; align-items:center; gap:6px; height:24px; white-space:nowrap;
    font:600 13px/1 var(--rec-ui); color:var(--rec-muted); -webkit-font-smoothing:antialiased; }
  #twrec-module .rec-dot { width:9px; height:9px; border-radius:50%; flex:none; background:#5d6d7c; }
  #twrec-module .rec-mark { width:16px; height:16px; margin:0; flex:none; }
  #twrec-module .rec-spin { animation:twrec-spin 1s linear infinite; }
  @keyframes twrec-spin { to { transform:rotate(360deg); } }
  #twrec-module .rec-word { font:inherit; letter-spacing:0; }
  #twrec-module .rec-clock { font:600 16px/1 var(--rec-mono); font-variant-numeric:tabular-nums; letter-spacing:0; color:var(--rec-text); }
  #twrec-module[data-tone="idle"] { color:var(--rec-dim); font-weight:500; }
  #twrec-module[data-tone="recording"] { color:#ffb4ae; }
  #twrec-module[data-tone="recording"] .rec-dot { background:var(--rec-red); box-shadow:0 0 0 3px #ef444433; }
  #twrec-module[data-tone="paused"], #twrec-module[data-tone="confirm"] { color:var(--rec-amber); }
  #twrec-module[data-tone="paused"] .rec-dot, #twrec-module[data-tone="confirm"] .rec-dot { background:var(--rec-amber); }
  #twrec-module[data-tone="paused"] .rec-clock, #twrec-module[data-tone="confirm"] .rec-clock { color:var(--rec-amber); }
  #twrec-module[data-tone="saving"] { color:#9cc3f5; }
  #twrec-module[data-tone="saving"] .rec-clock { color:var(--rec-muted); }
  #twrec-module[data-tone="saved"] { color:#7fd6a1; }
  #twrec-module[data-tone="saved"] .rec-mark { color:var(--rec-ok); }
  #twrec-module[data-tone="error"] { color:#ffb4ae; }
  #twrec-module[data-tone="error"] .rec-dot { background:var(--rec-red); }
  #twrec-module .rec-btn { display:inline-flex; align-items:center; justify-content:center; gap:5px; height:26px; padding:0 9px;
    box-sizing:border-box; margin-left:2px; border:1px solid var(--rec-line); border-radius:6px; background:var(--rec-ctl);
    color:var(--rec-text); font:500 13px/1 var(--rec-ui); white-space:nowrap; cursor:pointer; }
  #twrec-module .rec-btn + .rec-btn { margin-left:0; }
  #twrec-module .rec-btn:hover { background:var(--rec-ctl-hover); }
  /* Pause, Resume and Stop: 28px square, the chrome's next control size up from the strip's 26px
     buttons (Dominik's preview.8 feedback, 28 Sep: "slightly larger"); the icon keeps its 16px step. */
  #twrec-module .rec-btn.icon { width:28px; height:28px; padding:0; }
  #twrec-module .rec-btn.rec-go { color:#ffd2cf; border-color:#ef444466; background:#3a1a1a; }
  #twrec-module .rec-btn.rec-go .tw-ico { color:var(--rec-red); }
  #twrec-module .rec-btn.rec-amber { color:#ffe1a8; border-color:#f5b64a66; background:var(--rec-amber-bg); }
  /* The stop square is drawn at 12px, filled; scaled so the icon keeps the one 16px size step. */
  #twrec-module .rec-btn.rec-stop .tw-ico { fill:currentColor; transform:scale(.75); }
  #twrec-module .rec-btn.rec-keep { color:#a8e0bf; border-color:#2f6b45; background:#12261a; }
  #twrec-module .rec-btn.icon > .tw-btn-label { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
  #twrec-module .tw-ico, .twrec-toast .tw-ico { width:16px; height:16px; margin:0; flex:none; vertical-align:middle; }
  #twrec-module .tw-btn-label[hidden], .twrec-toast .tw-btn-label[hidden] { display:none !important; }

  /* The toasts: under the status strip, over the top of the stage, never over Next. */
  .twrec-toast { position:fixed; top:86px; left:50%; z-index:190; display:flex; align-items:center; gap:10px; height:44px;
    box-sizing:border-box; padding:0 8px 0 14px; background:#0f1720; border:1px solid #ffffff2a; border-radius:10px;
    box-shadow:0 12px 34px rgba(0,0,0,.55); white-space:nowrap; font-family:var(--rec-ui); color:var(--rec-text);
    -webkit-font-smoothing:antialiased; transform:translateY(-8px); opacity:0; pointer-events:none;
    transition:opacity .22s ease, transform .22s ease; }
  .twrec-toast.show { transform:translateY(0); opacity:1; pointer-events:auto; }
  .twrec-toast .rt-dot { width:9px; height:9px; border-radius:50%; background:#5d6d7c; flex:none; }
  .twrec-toast .rt-dot.amber { background:var(--rec-amber); }
  .twrec-toast .rt-dot.blue { background:var(--rec-blue); }
  .twrec-toast .rt-ok { color:var(--rec-ok); }
  .twrec-toast .rt-text { font:500 14px/1 var(--rec-ui); color:var(--rec-muted); }
  .twrec-toast .rt-text b { color:var(--rec-text); font-weight:600; margin-right:3px; }
  .twrec-toast .rec-btn { display:inline-flex; align-items:center; gap:5px; height:28px; padding:0 9px; box-sizing:border-box;
    border:1px solid var(--rec-line); border-radius:6px; background:var(--rec-ctl); color:var(--rec-text);
    font:500 13px/1 var(--rec-ui); white-space:nowrap; cursor:pointer; }
  .twrec-toast .rec-btn:hover { background:var(--rec-ctl-hover); }
  .twrec-toast .rec-btn.rec-go { color:#ffd2cf; border-color:#ef444466; background:#3a1a1a; }
  .twrec-toast .rec-btn.rec-go .tw-ico { color:var(--rec-red); }
  .twrec-toast .rec-btn.rec-amber { color:#ffe1a8; border-color:#f5b64a66; background:var(--rec-amber-bg); }
  .twrec-toast .rec-btn.rec-primary { color:#fff; border-color:var(--rec-primary); background:var(--rec-primary); font-weight:600; }
  .twrec-toast .rec-btn .kbd { font:500 13px/1 var(--rec-ui); color:inherit; opacity:.8; margin-left:4px; background:none; border:0; padding:0; }
  .twrec-toast .rt-dismiss { display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; padding:0;
    border:0; border-radius:6px; background:none; color:var(--rec-dim); cursor:pointer; }
  .twrec-toast .rt-dismiss:hover { color:var(--rec-text); background:#ffffff0d; }

  .twrec-error { position:fixed; left:50%; bottom:96px; transform:translateX(-50%); background:#2a1618;
    border:1px solid #7d3b37; color:#f4b9b5; padding:9px 16px; border-radius:9px; font-size:0.86rem; z-index:210;
    box-shadow:0 12px 34px rgba(0,0,0,.5); font-family:var(--twrec-sans); max-width:60ch; }
  .twrec-picker, .twrec-close-modal { position:fixed; inset:0; z-index:230; display:flex; align-items:center; justify-content:center;
    background:rgba(6,10,15,0.54); backdrop-filter:blur(4px); font-family:var(--twrec-sans); }
  .twrec-picker-panel, .twrec-close-panel { min-width:min(440px, calc(100vw - 44px)); max-width:520px; border-radius:12px;
    background:#111a24; border:1px solid #ffffff24; box-shadow:0 24px 80px rgba(0,0,0,.58); padding:16px; color:#eef3f9; }
  .twrec-picker-title, .twrec-close-title { font-size:0.95rem; font-weight:800; letter-spacing:0.01em; margin-bottom:4px; }
  .twrec-picker-sub, .twrec-close-sub { color:#aab8c6; font-size:0.82rem; line-height:1.35; margin-bottom:13px; }
  .twrec-kind-row, .twrec-close-row { display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
  .twrec-kind { border:1px solid #ffffff24; background:#1a2632; color:#eef3f9; border-radius:7px; padding:8px 11px;
    font-size:0.82rem; font-weight:750; }
  .twrec-kind.active { border-color:#d98a2b; background:#3a2c12; color:#f0d5a0; box-shadow:0 0 0 1px #d98a2b33; }
  .twrec-planned-list { display:grid; gap:7px; margin:0 0 13px; max-height:230px; overflow:auto; }
  .twrec-planned { display:flex; align-items:baseline; justify-content:space-between; gap:18px; text-align:left;
    border:1px solid #ffffff24; background:#1a2632; color:#eef3f9; border-radius:8px; padding:9px 11px; }
  .twrec-planned:hover, .twrec-planned:focus, .twrec-planned.active { border-color:#d98a2b; background:#3a2c12; outline:none; }
  .twrec-planned b { font-size:.84rem; }
  .twrec-planned span { color:#aab8c6; font-size:.75rem; }
  .twrec-close-panel .danger { color:#ffd6d2; border-color:#7d3b37; background:#2a1618; }
`

// The recording controls this module injects (their rows in src/shared/presenter-controls.ts).
const RECORDING_CONTROL_IDS = [
  'twrec-primary', 'twrec-change-kind', 'twrec-pause', 'twrec-resume', 'twrec-stop', 'twrec-keep', 'twrec-discard',
  'twrec-toast-yes', 'twrec-toast-no', 'twrec-save-delivery', 'twrec-save-as', 'twrec-save-dismiss',
  'twrec-start-record', 'twrec-start-dismiss', 'twrec-saved-change', 'twrec-saved-dismiss'
] as const
const CLUSTER_BUTTONS: RecButton[] = ['primary', 'pause', 'resume', 'stop', 'change-kind', 'keep', 'discard']
const recKeys = (id: string): string => presenterControlKeys(presenterControl(id), SHORTCUT_REGISTRY)
/** A key cap in a toast button: the registry's text, with Enter drawn as ↵. */
const kbd = (id: string): string => `<span class="kbd">${recKeys(id).replace(/^Enter$/, '↵')}</span>`

function normaliseKind(value: unknown): RunKind {
  return value === 'rehearsal' || value === 'recording' ? value : 'delivery'
}

export function mountRecUi(controller: RecorderController): void {
  // 1) Styles — once.
  if (!document.getElementById('twrec-styles')) {
    const style = document.createElement('style')
    style.id = 'twrec-styles'
    style.textContent = REC_CSS
    document.head.appendChild(style)
  }

  // 2) The REC cluster — mounted in the status bar's recording slot.
  const module = document.createElement('div')
  module.id = 'twrec-module'
  module.dataset.rec = 'idle'
  module.dataset.tone = 'idle'
  module.setAttribute('role', 'group')
  module.setAttribute('aria-label', 'Recording')
  module.innerHTML = `
    <span class="rec-dot" id="twrec-dot" aria-hidden="true"></span>
    <span id="twrec-spinner" hidden>${presenterIconSvg('loader-circle').replace('class="tw-ico', 'class="rec-mark rec-spin tw-ico')}</span>
    <span id="twrec-ok" hidden>${presenterIconSvg('circle-check').replace('class="tw-ico', 'class="rec-mark tw-ico')}</span>
    <span class="rec-word" id="twrec-label">Not recording</span>
    <span class="rec-clock" id="twrec-clock" hidden>00:00</span>
    <button type="button" class="rec-btn rec-go" id="twrec-primary"><span class="tw-btn-label">Record</span></button>
    <button type="button" class="rec-btn icon" id="twrec-pause" hidden><span class="tw-btn-label">Pause recording</span></button>
    <button type="button" class="rec-btn icon rec-amber" id="twrec-resume" hidden><span class="tw-btn-label">Resume recording</span></button>
    <button type="button" class="rec-btn icon rec-stop" id="twrec-stop" hidden><span class="tw-btn-label">Stop and save recording</span></button>
    <button type="button" class="rec-btn" id="twrec-change-kind" hidden><span class="tw-btn-label">Change</span></button>
    <button type="button" class="rec-btn rec-keep" id="twrec-keep" hidden><span class="tw-btn-label">Keep</span></button>
    <button type="button" class="rec-btn" id="twrec-discard" hidden><span class="tw-btn-label">Discard</span></button>`

  // The presenter's status bar keeps a slot for the recording block (ADR-0031 §2, presenter
  // redesign ticket 02).
  const recSlot = document.getElementById('presenterRecSlot')
  const clockBar = document.querySelector<HTMLElement>('#presenterRoot header .tw-clock-bar')
  if (recSlot) {
    recSlot.appendChild(module)
  } else if (clockBar && clockBar.parentElement) {
    // An older presenter template without the slot: reparent the clock-bar into a cluster so the
    // two clocks group tightly. Same node moved — every id/listener stays live.
    const divider = document.createElement('span')
    divider.className = 'cluster-divider'
    divider.setAttribute('aria-hidden', 'true')
    const cluster = document.createElement('div')
    cluster.className = 'tw-center-cluster'
    clockBar.parentElement.insertBefore(cluster, clockBar)
    cluster.appendChild(clockBar)
    cluster.appendChild(divider)
    cluster.appendChild(module)
  } else {
    // Fallback: no clock-bar found — pin the module top-centre so recording still works.
    module.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:150;'
    document.body.appendChild(module)
  }

  // 3) The toasts — non-blocking, never focused, under the status strip.
  const makeToast = (className: string, html: string): HTMLElement => {
    const el = document.createElement('div')
    el.className = className
    el.setAttribute('role', 'status')
    el.setAttribute('aria-live', 'polite')
    el.innerHTML = html
    document.body.appendChild(el)
    return el
  }
  const toast = makeToast('twrec-toast twrec-paused-offer', `
    <span class="rt-dot amber" aria-hidden="true"></span>
    <span class="rt-text"><b>Recording is paused.</b> Resume?</span>
    <button type="button" class="rec-btn rec-amber" id="twrec-toast-yes"><span class="tw-btn-label">Resume recording</span>${kbd('twrec-toast-yes')}</button>
    <button type="button" class="rt-dismiss" id="twrec-toast-no"></button>`)
  const saveToast = makeToast('twrec-toast twrec-save-offer', `
    <span class="rt-dot blue" aria-hidden="true"></span>
    <span class="rt-text" id="twrec-save-text"><b>Save this run to History?</b></span>
    <button type="button" class="rec-btn rec-primary" id="twrec-save-delivery"><span class="tw-btn-label">Save as Delivery</span>${kbd('twrec-save-delivery')}</button>
    <button type="button" class="rec-btn" id="twrec-save-as"><span class="tw-btn-label">Save as…</span>${kbd('twrec-save-as')}</button>
    <button type="button" class="rt-dismiss" id="twrec-save-dismiss"></button>`)
  // The start-recording offer: quiet, never focused, and it fades by itself. ⇧R (the existing
  // record command) or its Record button accept it; the dismiss control is out of the tab order.
  const startToast = makeToast('twrec-toast twrec-start-offer', `
    <span class="rt-dot" aria-hidden="true"></span>
    <span class="rt-text"><b>Start recording?</b> Offered once, fades in ${Math.round(RECORDING_OFFER_VISIBLE_MS / 1000)} seconds</span>
    <button type="button" class="rec-btn rec-go" id="twrec-start-record"><span class="tw-btn-label">Record</span>${kbd('twrec-start-record')}</button>
    <button type="button" class="rt-dismiss" id="twrec-start-dismiss" tabindex="-1"></button>`)
  const savedToast = makeToast('twrec-toast twrec-saved-note', `
    ${presenterIconSvg('circle-check').replace('class="tw-ico', 'class="rt-ok tw-ico')}
    <span class="rt-text" id="twrec-saved-text"><b>Saved to History</b></span>
    <button type="button" class="rec-btn" id="twrec-saved-change"><span class="tw-btn-label">Change</span>${kbd('twrec-saved-change')}</button>
    <button type="button" class="rt-dismiss" id="twrec-saved-dismiss"></button>`)
  const toasts = [toast, saveToast, startToast, savedToast]

  // Icons, names and keys for every recording control, from the presenter-controls table; the
  // presenter template's delegated tooltip shows data-tip and data-key.
  for (const id of RECORDING_CONTROL_IDS) {
    const el = document.getElementById(id)
    if (el) dressPresenterButton(el, presenterControl(id), SHORTCUT_REGISTRY)
  }

  // Refs
  const $ = (id: string): HTMLElement | null => document.getElementById(id)
  const label = $('twrec-label'), clock = $('twrec-clock')
  const dot = $('twrec-dot'), spinner = $('twrec-spinner'), ok = $('twrec-ok')
  const buttons = new Map(CLUSTER_BUTTONS.map((name) => [name, $(`twrec-${name}`)] as const))
  const primary = buttons.get('primary'), btnChangeKind = buttons.get('change-kind'), btnPause = buttons.get('pause')
  const btnResume = buttons.get('resume'), btnStop = buttons.get('stop'), btnKeep = buttons.get('keep'), btnDiscard = buttons.get('discard')
  const saveText = $('twrec-save-text'), savedText = $('twrec-saved-text')

  // Toast placement (surfaces-drawn.md, Toasts): under the status strip, centred on it, kept left
  // of the current slide's right edge so it never covers Next. Without a strip, the old corner.
  function placeToast(el: HTMLElement): void {
    const strip = document.getElementById('presenterStatus')
    const st = strip && strip.getClientRects().length > 0 ? strip.getBoundingClientRect() : null
    if (!st) { el.style.top = '86px'; el.style.left = ''; el.style.right = '26px'; return }
    const stage = document.querySelector('.presenter-current-panel')?.getBoundingClientRect()
    const right = stage && stage.width > 0 ? stage.right : window.innerWidth - 10
    el.style.right = ''
    el.style.top = `${Math.round(st.bottom + 10)}px`
    el.style.left = `${Math.round(Math.max(10, Math.min(right - el.offsetWidth - 8, st.left + st.width / 2 - el.offsetWidth / 2)))}px`
  }
  // One toast at a time: they share the place under the strip.
  function showOnly(el: HTMLElement): void {
    for (const other of toasts) if (other !== el) other.classList.remove('show')
    placeToast(el)
    el.classList.add('show')
  }
  window.addEventListener('resize', () => { for (const el of toasts) if (el.classList.contains('show')) placeToast(el) })

  const showToast = (): void => showOnly(toast)
  const hideToast = (): void => toast.classList.remove('show')
  const showSaveToast = (): void => {
    if (saveText) saveText.innerHTML = controller.runGate().lastSlideReached ? '<b>Last slide.</b> Save this run to History?' : '<b>Save this run to History?</b>'
    showOnly(saveToast)
  }
  const hideSaveToast = (): void => saveToast.classList.remove('show')
  let startToastTimer: number | null = null
  const hideStartToast = (): void => {
    if (startToastTimer !== null) { window.clearTimeout(startToastTimer); startToastTimer = null }
    startToast.classList.remove('show')
  }
  const showStartToast = (): void => {
    if (controller.getState() !== 'idle') return
    showOnly(startToast)
    if (startToastTimer !== null) window.clearTimeout(startToastTimer)
    startToastTimer = window.setTimeout(hideStartToast, RECORDING_OFFER_VISIBLE_MS)
  }
  let savedToastTimer: number | null = null
  const hideSavedToast = (): void => {
    if (savedToastTimer !== null) { window.clearTimeout(savedToastTimer); savedToastTimer = null }
    savedToast.classList.remove('show')
  }
  // The length of the run History holds: the wall-clock run, or the recorded length of a
  // recording (its kind changed with Change).
  let savedLengthMs = 0
  const showSavedToast = (): void => {
    if (savedText) savedText.innerHTML = `<b>Saved to History</b> as ${kindLabel(controller.currentKind())} · ${fmtClock(savedLengthMs)}`
    showOnly(savedToast)
    if (savedToastTimer !== null) window.clearTimeout(savedToastTimer)
    savedToastTimer = window.setTimeout(hideSavedToast, SAVED_TOAST_VISIBLE_MS)
  }

  function chooseKind(initial: RunKind = 'delivery'): Promise<RunKind | null> {
    return new Promise((resolve) => {
      let selected = initial
      const overlay = document.createElement('div')
      overlay.className = 'twrec-picker'
      overlay.setAttribute('role', 'dialog')
      overlay.setAttribute('aria-modal', 'true')
      overlay.innerHTML = `
        <div class="twrec-picker-panel">
          <div class="twrec-picker-title">Save run to History</div>
          <div class="twrec-picker-sub">Choose how this run should appear in History.</div>
          <div class="twrec-kind-row">
            <button type="button" class="twrec-kind" data-kind="delivery">Delivery</button>
            <button type="button" class="twrec-kind" data-kind="rehearsal">Rehearsal</button>
            <button type="button" class="twrec-kind" data-kind="recording">Recording</button>
          </div>
        </div>`
      const kinds = Array.from(overlay.querySelectorAll<HTMLButtonElement>('.twrec-kind'))
      const sync = (): void => {
        kinds.forEach((button) => button.classList.toggle('active', button.dataset.kind === selected))
      }
      const close = (value: RunKind | null): void => {
        window.removeEventListener('keydown', onKey, true)
        overlay.remove()
        resolve(value)
      }
      const confirm = (): void => close(selected)
      const onKey = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(null); return }
        if (event.key === 'Enter') { event.preventDefault(); event.stopImmediatePropagation(); confirm(); return }
        const idx = kinds.findIndex((button) => button.dataset.kind === selected)
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault()
          selected = normaliseKind(kinds[(idx + 1) % kinds.length]?.dataset.kind)
          sync()
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault()
          selected = normaliseKind(kinds[(idx + kinds.length - 1) % kinds.length]?.dataset.kind)
          sync()
        }
      }
      kinds.forEach((button) => {
        button.addEventListener('click', () => {
          selected = normaliseKind(button.dataset.kind)
          sync()
          confirm()
        })
      })
      sync()
      document.body.appendChild(overlay)
      window.addEventListener('keydown', onKey, true)
      kinds.find((button) => button.dataset.kind === selected)?.focus()
    })
  }

  // Save the run (or change the kind of the saved one), then confirm it in the saved toast.
  async function saveRun(kind: RunKind): Promise<boolean> {
    const gate = controller.runGate()
    if (!gate.saved) savedLengthMs = gate.wallMs
    const result = await controller.saveRun(kind)
    const saved = !!result?.ok && !result.discarded
    if (saved) showSavedToast()
    return saved
  }

  async function saveWithPicker(): Promise<boolean> {
    hideSaveToast()
    hideSavedToast()
    const picked = await chooseKind(controller.currentKind())
    if (!picked) return false
    return saveRun(picked)
  }

  let savingAudio = false
  function render(): void {
    const st = controller.getState()
    const gate = controller.runGate()
    const view = recView({ state: st, displayMs: controller.displayMs(), kind: controller.currentKind(), audioHeld: gate.audioArmed })
    module.dataset.rec = st
    module.dataset.tone = view.tone
    if (dot) dot.hidden = view.mark !== 'dot'
    if (spinner) spinner.hidden = view.mark !== 'spinner'
    if (ok) ok.hidden = view.mark !== 'check'
    if (label) {
      label.textContent = view.word
      // Collapse step c5 drops only the words that the dot and the button's tooltip also carry.
      label.dataset.collapse = view.wordCollapses ? 'c5' : ''
    }
    if (clock) { clock.hidden = view.time === null; if (view.time !== null) clock.textContent = view.time }
    for (const [name, el] of buttons) if (el) el.hidden = !view.buttons.includes(name)
    if (btnKeep) {
      dressPresenterButton(btnKeep, presenterControl('twrec-keep'), SHORTCUT_REGISTRY, view.retrying
        ? { label: 'Retry save', name: 'Retry saving this recording', icon: 'refresh-cw' }
        : { label: 'Keep' })
    }
    // The length a saved recording carries, for the saved toast after Change.
    if (st === 'saving') savingAudio = gate.audioArmed
    else if (st === 'saved' && savingAudio) { savedLengthMs = controller.displayMs(); savingAudio = false }
    if (st !== 'paused') hideToast()
    if (st !== 'idle') hideStartToast()
    if (st === 'recording' || st === 'paused' || st === 'confirm') hideSavedToast()
    if (gate.saved || gate.audioArmed) hideSaveToast()
  }

  controller.onChange(render)
  controller.onSlideMovedWhilePaused(showToast)
  controller.onRunOffer(showSaveToast)
  controller.onRecordingStartOffer(showStartToast)
  controller.onCloseOffer((offer) => { hideSaveToast(); showPresentationCloseOffer(controller, offer) })
  controller.onError((msg) => {
    const n = document.createElement('div')
    n.className = 'twrec-error'
    n.textContent = msg
    document.body.appendChild(n)
    setTimeout(() => n.remove(), 4200)
  })

  // Clock tick — the visible REC clock advances while recording; render() keeps it correct otherwise.
  setInterval(() => { if (controller.getState() === 'recording' && clock) clock.textContent = fmtClock(controller.displayMs()) }, 200)

  // 4) Controls
  primary?.addEventListener('click', () => { void controller.start() })
  btnChangeKind?.addEventListener('click', () => { void saveWithPicker() })
  btnPause?.addEventListener('click', () => controller.pause())
  btnResume?.addEventListener('click', () => controller.resume())
  btnStop?.addEventListener('click', () => { void controller.stop() })
  btnKeep?.addEventListener('click', () => { void controller.confirmSave(true) })
  btnDiscard?.addEventListener('click', () => { void controller.confirmSave(false) })
  $('twrec-toast-yes')?.addEventListener('click', () => { controller.resume(); hideToast() })
  $('twrec-toast-no')?.addEventListener('click', hideToast)
  $('twrec-save-delivery')?.addEventListener('click', () => { hideSaveToast(); void saveRun('delivery') })
  $('twrec-save-as')?.addEventListener('click', () => { void saveWithPicker() })
  $('twrec-save-dismiss')?.addEventListener('click', hideSaveToast)
  $('twrec-start-record')?.addEventListener('click', () => { hideStartToast(); void controller.start() })
  $('twrec-start-dismiss')?.addEventListener('click', hideStartToast)
  $('twrec-saved-change')?.addEventListener('click', () => { void saveWithPicker() })
  $('twrec-saved-dismiss')?.addEventListener('click', hideSavedToast)

  // 5) Keyboard — ⇧R record/stop, ⇧P pause/resume. Capture phase so we act before the
  // presenter's own handler; plain P/R stay the presenter's (pacing timer / reveal).
  function toggleRecord(): void {
    const st = controller.getState()
    if (st === 'recording' || st === 'paused') void controller.stop()
    else if (st === 'idle' || st === 'saved' || st === 'error') void controller.start()
  }
  function togglePause(): void {
    const st = controller.getState()
    if (st === 'recording') controller.pause()
    else if (st === 'paused') controller.resume()
  }
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (document.querySelector('.twrec-close-modal')) return
    const t = e.target
    if (t instanceof HTMLElement && t.matches('input, textarea, select, [contenteditable="true"]')) return
    // Resolve a short-recording Keep/Discard from the keyboard: Enter keeps, Esc discards.
    if (controller.getState() === 'confirm') {
      if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); void controller.confirmSave(true) }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); void controller.confirmSave(false) }
      return
    }
    if (!e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'L' || e.key === 'l')) {
      e.preventDefault()
      e.stopImmediatePropagation()
      void saveWithPicker()
      return
    }
    if (saveToast.classList.contains('show') && e.key === 'Enter') {
      e.preventDefault()
      e.stopImmediatePropagation()
      hideSaveToast()
      void saveRun('delivery')
      return
    }
    if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === 'R' || e.key === 'r') { e.preventDefault(); e.stopImmediatePropagation(); hideStartToast(); toggleRecord() }
    else if (e.key === 'P' || e.key === 'p') { e.preventDefault(); e.stopImmediatePropagation(); togglePause() }
  }, true)

  // The ? sheet's Recording rows come from the shortcut registry (presenter.record,
  // presenter.record-pause, presenter.save-run-as, presenter.save-run); the template shows them
  // while this module is mounted (presenter redesign ticket 07).

  render()
}
