import { ipcRenderer } from 'electron'
import { checkPresenterDevices } from './presenter-device-check'
import { mountSelfView } from './presenter-self-view'
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
//
// The microphone (9 Nov 2026 incident): beside Record, the Microphone button opens the Microphone
// menu with a live level meter, before recording starts. A microphone connected during the talk is
// offered once in a notice ("Room microphone available: …. Use it?"); nothing switches without Use it.

import { reportGuideCommand } from './present-guide'
import { showPresentationCloseOffer } from './present-close-flow'
import { RECORDING_OFFER_VISIBLE_MS } from './present-recording-offer'
import { recView, fmtClock, kindLabel, type RecButton, type RunKind } from './present-rec-view'
import type { RecorderController } from './present-recorder'
import { inputName, microphoneMenu, type AudioInput } from '../shared/microphone-choice.ts'
import { lossReasonText } from './recording-loss'
import { dressPresenterButton, presenterControl, presenterControlKeys, presenterIconSvg } from '../shared/presenter-controls.ts'
import { SHORTCUT_REGISTRY } from '../shared/shortcut-registry.ts'

/** How long the "Saved to History" toast stays up if ignored (the same as the start offer). */
export const SAVED_TOAST_VISIBLE_MS = RECORDING_OFFER_VISIBLE_MS

const REC_CSS = `
  #twrec-countdown, #twrec-module, .twrec-toast, .twrec-mic-panel { --lt-amber:#a3630e; --lt-amber-bright:#d98a2b; --lt-red-live:#ec5b56;
    --twrec-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,monospace;
    --twrec-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    --rec-text:#f7f3ea; --rec-muted:#a3b3c2; --rec-dim:#71849a; --rec-line:#ffffff1c; --rec-ctl:#1f2c39; --rec-ctl-hover:#283a4c;
    --rec-red:#ef4444; --rec-amber:#f5b64a; --rec-amber-bg:#3a2a10; --rec-blue:#5b93f0; --rec-primary:#2f6db5; --rec-ok:#3fb970;
    --rec-ui:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;
    --rec-mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,monospace; }
  /* The 3-2-1 before a layered recording: the digit on a dark disc of its own (the toasts' panel
     colours), so it reads over a white slide as well as a dark one and hides only the middle. */
  #twrec-countdown { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
    z-index:200; width:128px; height:128px; box-sizing:border-box; display:grid; place-items:center; border-radius:50%;
    background:#0f1720eb; border:1px solid #ffffff2a; box-shadow:0 12px 34px rgba(0,0,0,.45);
    color:var(--rec-text); font:600 80px/1 var(--rec-ui); font-variant-numeric:tabular-nums; pointer-events:none; }
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
  /* Audio lost while recording: a hollow red ring, not the filled REC dot. */
  #twrec-module[data-tone="lost"] { color:#ffb4ae; }
  #twrec-module[data-tone="lost"] .rec-dot { background:transparent; box-shadow:inset 0 0 0 2px var(--rec-red); }
  #twrec-module[data-tone="lost"] .rec-clock { color:#ffb4ae; }
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
  .twrec-lost-note { left:12px; right:12px; width:max-content; max-width:calc(100vw - 52px);
    height:auto; min-height:44px; padding:8px 12px; flex-wrap:wrap; white-space:normal; }
  .twrec-saved-note { width:min(720px,calc(100vw - 24px)); height:auto; min-height:44px;
    padding:12px; flex-wrap:wrap; white-space:normal; }
  /* The saved offer (docs/design/2026-11-10-record-and-edit-video, drawings/saved.html): what was
     saved, with its close button, on the first line; the words being written out and the actions
     (Change, Edit video) on the second. */
  .twrec-saved-note { row-gap:8px; }
  .twrec-saved-note .rt-text { line-height:1.4; }
  .twrec-saved-note #twrec-saved-text { flex:1 1 calc(100% - 80px); }
  .twrec-saved-note #twrec-saved-dismiss { order:1; }
  .twrec-saved-note::after { content:''; order:1; flex-basis:100%; height:0; margin-top:-8px; }
  .twrec-saved-note > :not(.rt-ok, #twrec-saved-text, #twrec-saved-dismiss) { order:2; }
  .twrec-saved-note #twrec-words { flex:1 1 0; min-width:0; }
  .twrec-saved-note progress { width:110px; height:8px; }
  .twrec-lost-note .rt-text { flex:1 1 320px; line-height:1.4; }
  .twrec-toast.show { transform:translateY(0); opacity:1; pointer-events:auto; }
  .twrec-toast .rt-dot { width:9px; height:9px; border-radius:50%; background:#5d6d7c; flex:none; }
  .twrec-toast .rt-dot.amber { background:var(--rec-amber); }
  .twrec-toast .rt-dot.blue { background:var(--rec-blue); }
  .twrec-toast .rt-dot.red { background:transparent; box-shadow:inset 0 0 0 2px var(--rec-red); }
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

  /* The Microphone button beside Record, and its menu with the level meter. */
  #twrec-module .rec-btn:is(.rec-mic, .rec-again) { width:26px; padding:0; }
  /* The microphone's level beside Record while it is previewed, and its name (the name is the
     first thing to go when the top bar runs short: fitTopBar in the presenter template). */
  #twrec-idle-meter { display:inline-block; flex:none; width:42px; height:5px; border-radius:3px; overflow:hidden; background:#ffffff26; }
  #twrec-idle-level { display:block; height:100%; width:0; background:var(--rec-ok); }
  #twrec-idle-name { flex:none; color:var(--rec-dim); }
  #twrec-module .rec-btn.rec-mic[aria-expanded="true"] { background:var(--rec-ctl-hover); border-color:#6ea8e6; }
  .twrec-mic-panel { position:fixed; z-index:196; display:grid; gap:8px; width:340px; box-sizing:border-box; padding:10px 12px 12px;
    background:#0f1720; border:1px solid #ffffff2a; border-radius:10px; box-shadow:0 12px 34px rgba(0,0,0,.55);
    font-family:var(--rec-ui); color:var(--rec-text); -webkit-font-smoothing:antialiased; }
  .twrec-mic-panel[hidden] { display:none !important; }
  .twrec-mic-panel .mp-title { font:600 13px/1 var(--rec-ui); color:var(--rec-text); }
  .twrec-mic-panel .mp-row { display:flex; align-items:center; gap:10px; }
  .twrec-mic-panel select { flex:1 1 auto; min-width:0; height:28px; padding:0 6px; border:1px solid var(--rec-line); border-radius:6px;
    background:var(--rec-ctl); color:var(--rec-text); font:500 13px/1 var(--rec-ui); }
  .twrec-mic-panel .mp-meter { flex:0 0 72px; height:8px; border-radius:4px; background:#ffffff14; overflow:hidden; }
  .twrec-mic-panel .mp-fill { display:block; height:100%; width:0; border-radius:4px; background:var(--rec-ok); transition:width .08s linear; }
  .twrec-mic-panel .mp-note { font:500 12px/1.35 var(--rec-ui); color:var(--rec-muted); }
  .twrec-mic-panel .mp-note:empty { display:none; }
`

// The recording controls this module injects (their rows in src/shared/presenter-controls.ts).
const RECORDING_CONTROL_IDS = [
  'twrec-primary', 'twrec-change-kind', 'twrec-pause', 'twrec-resume', 'twrec-stop', 'twrec-keep', 'twrec-discard',
  'twrec-toast-yes', 'twrec-toast-no', 'twrec-save-delivery', 'twrec-save-as', 'twrec-save-dismiss',
  'twrec-start-record', 'twrec-start-dismiss', 'twrec-saved-change', 'twrec-saved-dismiss',
  'twrec-lost-resume', 'twrec-lost-dismiss', 'twrec-back-dismiss', 'twrec-disk-dismiss', 'twrec-export',
  'twrec-flag', 'twrec-mic', 'twrec-mic-use', 'twrec-mic-dismiss', 'twrec-again',
  'twrec-words-retry', 'twrec-words-manual', 'twrec-edit-video', 'twrec-lost-switch'
] as const
const CLUSTER_BUTTONS: RecButton[] = ['primary', 'pause', 'resume', 'stop', 'change-kind', 'keep', 'export', 'discard']
const recKeys = (id: string): string => presenterControlKeys(presenterControl(id), SHORTCUT_REGISTRY)
/** A key cap in a toast button: the registry's text, with Enter drawn as ↵. */
const kbd = (id: string): string => `<span class="kbd">${recKeys(id).replace(/^Enter$/, '↵')}</span>`

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string))

/** A device name for a notice: Chromium's transport suffix, "(Built-in)" or "(2b55:0001)", dropped. */
const shortName = (name: string): string => name.replace(/\s*\([^)]*\)\s*$/, '').trim() || name

function normaliseKind(value: unknown): RunKind {
  return value === 'rehearsal' || value === 'recording' ? value : 'delivery'
}

export function mountRecUi(controller: RecorderController, layered = false): void {
  let preparing = false
  async function startCapture(): Promise<void> {
    if (preparing || !['idle', 'saved'].includes(controller.getState())) return
    preparing = true
    try {
      if (!layered) { await controller.start(); return }
      const inputs = await controller.microphones()
      const devices = await navigator.mediaDevices.enumerateDevices()
      const checked = await checkPresenterDevices(controller.captureChoice(), inputs.chosen?.label || controller.microphoneName() || devices.find(d => d.kind === 'audioinput' && d.deviceId !== 'default')?.label || '', (channel, ...args) => ipcRenderer.invoke(channel, ...args))
      if (!checked) return
      controller.checkedCamera(checked.camera, checked.cameraDeviceId)
      const checkedInput = (await controller.microphones()).inputs.find(input => input.label === checked.microphone)
      if (checkedInput && controller.microphoneName() !== inputName(checkedInput)) await controller.chooseMicrophone(checkedInput)
      // The slides picture's surface gets ready during the countdown, so it is painting when the voice starts.
      void ipcRenderer.invoke('recording:layers-warm').catch(() => {})
      const countdown = document.createElement('div')
      countdown.setAttribute('role', 'status'); countdown.id = 'twrec-countdown'
      document.body.appendChild(countdown)
      try { for (const number of [3, 2, 1]) { countdown.textContent = String(number); await new Promise(resolve => setTimeout(resolve, 1000)) } }
      finally { countdown.remove() }
      await controller.start()
    } finally { preparing = false }
  }
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
    <span id="twrec-idle-meter" role="meter" aria-label="Microphone level" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" hidden><span id="twrec-idle-level"></span></span><span id="twrec-idle-name" hidden></span>
    <span class="rec-clock" id="twrec-clock" hidden>00:00</span>
    <button type="button" class="rec-btn rec-go" id="twrec-primary"><span class="tw-btn-label">Record</span></button>
    <select id="twrec-capture" class="rec-btn" aria-label="Capture"><option value="voice">Slides and voice</option><option value="camera">Slides, voice and camera</option></select>
    <button type="button" class="rec-btn icon" id="twrec-flag" title="Mark a mistake (⇧M)" hidden><span class="tw-btn-label">Mark a mistake</span></button>
    <button type="button" class="rec-btn icon rec-mic" id="twrec-mic" aria-haspopup="dialog" aria-expanded="false" hidden><span class="tw-btn-label">Microphone</span></button>
    <button type="button" class="rec-btn icon" id="twrec-pause" hidden><span class="tw-btn-label">Pause recording</span></button>
    <button type="button" class="rec-btn icon rec-amber" id="twrec-resume" hidden><span class="tw-btn-label">Resume recording</span></button>
    <button type="button" class="rec-btn icon rec-stop" id="twrec-stop" hidden><span class="tw-btn-label">Stop and save recording</span></button>
    <button type="button" class="rec-btn icon rec-again" id="twrec-again" hidden><span class="tw-btn-label">Start again</span></button>
    <button type="button" class="rec-btn" id="twrec-change-kind" hidden><span class="tw-btn-label">Change</span></button>
    <button type="button" class="rec-btn rec-keep" id="twrec-keep" hidden><span class="tw-btn-label">Keep</span></button>
    <button type="button" class="rec-btn" id="twrec-export" hidden><span class="tw-btn-label">Save audio elsewhere…</span></button>
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
    <span class="rt-text" id="twrec-words" role="status" aria-live="polite"></span>
    <progress id="twrec-words-progress" aria-label="Writing out words" hidden></progress>
    <button type="button" class="rec-btn" id="twrec-words-retry" hidden>Retry words</button>
    <button type="button" class="rec-btn" id="twrec-words-manual" hidden>Set up words</button>
    <button type="button" class="rec-btn" id="twrec-saved-change"><span class="tw-btn-label">Change</span>${kbd('twrec-saved-change')}</button>
    <button type="button" class="rec-btn" id="twrec-edit-video">Edit video</button>
    <button type="button" class="rt-dismiss" id="twrec-saved-dismiss"></button>`)
  // Audio lost while recording: stays up until the audio is back (or Stop), with one-click Resume.
  const lostToast = makeToast('twrec-toast twrec-lost-note', `
    <span class="rt-dot red" aria-hidden="true"></span>
    <span class="rt-text" id="twrec-lost-text"><b>Audio stopped.</b></span>
    <button type="button" class="rec-btn rec-go" id="twrec-lost-resume"><span class="tw-btn-label">Resume recording</span></button>
    <button type="button" class="rec-btn" id="twrec-lost-switch">Choose microphone</button>
    <button type="button" class="rt-dismiss" id="twrec-lost-dismiss"></button>`)
  lostToast.setAttribute('role', 'alert')
  const backToast = makeToast('twrec-toast twrec-back-note', `
    ${presenterIconSvg('circle-check').replace('class="tw-ico', 'class="rt-ok tw-ico')}
    <span class="rt-text" id="twrec-back-text"><b>Audio is back.</b></span>
    <button type="button" class="rt-dismiss" id="twrec-back-dismiss"></button>`)
  // Main could not write the audio to disk: it is held in memory until Stop, and saved then.
  const diskToast = makeToast('twrec-toast twrec-disk-note', `
    <span class="rt-dot red" aria-hidden="true"></span>
    <span class="rt-text"><b>Audio is not being saved to disk.</b> It is kept until Stop.</span>
    <button type="button" class="rt-dismiss" id="twrec-disk-dismiss"></button>`)
  diskToast.setAttribute('role', 'alert')
  // Another microphone was connected during the talk: offered, never switched to by itself.
  const micToast = makeToast('twrec-toast twrec-mic-note', `
    <span class="rt-dot blue" aria-hidden="true"></span>
    <span class="rt-text" id="twrec-mic-text"><b>Room microphone available.</b> Use it?</span>
    <button type="button" class="rec-btn rec-primary" id="twrec-mic-use"><span class="tw-btn-label">Use it</span></button>
    <button type="button" class="rt-dismiss" id="twrec-mic-dismiss"></button>`)
  const toasts = [toast, saveToast, startToast, savedToast, lostToast, backToast, diskToast, micToast]

  let previewEnabled = false
  const previewWanted = () => previewEnabled || !micPanel.hidden
  // The Microphone menu: which input recordings use, and its level now.
  const micPanel = document.createElement('div')
  micPanel.className = 'twrec-mic-panel'
  micPanel.id = 'twrec-mic-panel'
  micPanel.setAttribute('role', 'dialog')
  micPanel.setAttribute('aria-label', 'Microphone')
  micPanel.hidden = true
  micPanel.innerHTML = `
    <label><input type="checkbox" id="twrec-preview"> Preview</label>
    <label class="mp-title" for="twrec-mic-select">Microphone</label>
    <div class="mp-row">
      <select id="twrec-mic-select"></select>
      <span class="mp-meter" role="meter" aria-label="Input level" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="mp-fill" id="twrec-mic-level"></span></span>
    </div>
    <div class="mp-note" id="twrec-mic-panel-note"></div>`
  document.body.appendChild(micPanel)

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
  function captureSummary(): string {
    if (controller.lastSave()?.captureUnknown) return 'Voice saved · slides: unknown · camera: unknown (files kept)'
    const capture = controller.lastSave()?.capture
    const describe = (name: 'slides' | 'camera') => {
      const layer = capture?.layers[name]
      const loss = (layer?.segments ?? (layer ? [layer] : [])).find(part => part.lostAtMs !== undefined)?.lostAtMs
      return `${name}: ${layer?.outcome ?? 'none'}${layer?.outcome === 'interrupted' && loss !== undefined ? ` at ${fmtClock(loss)}` : ''}`
    }
    return `Voice saved · ${describe('slides')} · ${describe('camera')}`
  }
  const saveText = $('twrec-save-text'), savedText = $('twrec-saved-text')
  const lostText = $('twrec-lost-text'), backText = $('twrec-back-text'), lostResume = $('twrec-lost-resume')

  // Toast placement (surfaces-drawn.md, Toasts): under the status strip, centred on it, kept left
  // of the current slide's right edge so it never covers Next. Without a strip, the old corner.
  function placeToast(el: HTMLElement): void {
    const strip = document.getElementById('presenterStatus')
    const st = strip && strip.getClientRects().length > 0 ? strip.getBoundingClientRect() : null
    if (!st) { el.style.top = '86px'; el.style.left = 'auto'; el.style.right = '26px'; return }
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
  let wordsDismissed = false
  let savedToastTimer: number | null = null
  const hideSavedToast = (): void => {
    wordsDismissed = true
    if (savedToastTimer !== null) { window.clearTimeout(savedToastTimer); savedToastTimer = null }
    window.clearTimeout(wordsTimer)
    savedToast.classList.remove('show')
  }
  // The length of the run History holds: the wall-clock run, or the recorded length of a
  // recording (its kind changed with Change).
  let savedLengthMs = 0
  let wordsTimer: number | undefined
  let wordsRun: string | undefined
  async function refreshWords(): Promise<void> {
    const sid = controller.lastSave()?.sessionId
    if (!sid) return
    wordsRun = sid
    try {
      const status = await ipcRenderer.invoke('transcript:saved-status', controller.talkSlug(), sid)
      if (wordsDismissed || controller.lastSave()?.sessionId !== sid) return
      const text = $('twrec-words')
      if (text) text.textContent = status.state === 'writing' ? `Words are being written out. ${status.note}` : status.note
      $('twrec-words-progress')!.hidden = !['checking', 'writing'].includes(status.state)
      $('twrec-words-retry')!.hidden = status.state !== 'failed'
      $('twrec-words-manual')!.hidden = status.state !== 'unavailable'
      if (status.state === 'checking' || status.state === 'writing') wordsTimer = window.setTimeout(() => { void refreshWords() }, 400)
    } catch { if ($('twrec-words')) $('twrec-words')!.textContent = 'Words status is unavailable. The Run is saved; write out words from the Run.' }
  }
  $('twrec-words-retry')?.addEventListener('click', () => {
    if (!wordsRun) return
    void ipcRenderer.invoke('transcript:retry-saved', controller.talkSlug(), wordsRun).finally(() => { void refreshWords() })
    $('twrec-words-retry')!.hidden = true
    $('twrec-words')!.textContent = 'Words are being written out on this Mac.'
    $('twrec-words-progress')!.hidden = false
  })
  $('twrec-words-manual')?.addEventListener('click', () => { void ipcRenderer.invoke('settings-window:open', 'recording') })
  const showSavedToast = (): void => {
    wordsDismissed = false
    window.clearTimeout(wordsTimer)
    void refreshWords()
    if (savedText) savedText.innerHTML = retake
      ? `<b>New take of slide ${retake.slideN} saved</b> · ${fmtClock(savedLengthMs)} · ${captureSummary()} · choose it in the editor`
      : `<b>Saved to History</b> as ${kindLabel(controller.currentKind())} · ${fmtClock(savedLengthMs)} · ${captureSummary()}`
    const editVideo = $('twrec-edit-video'), change = $('twrec-saved-change')
    if (editVideo) dressPresenterButton(editVideo, presenterControl('twrec-edit-video'), SHORTCUT_REGISTRY, retake ? { label: 'Back to the editor', name: 'Back to the editor' } : { label: 'Edit video' })
    if (change) change.hidden = !!retake
    showOnly(savedToast)
    if (savedToastTimer !== null) window.clearTimeout(savedToastTimer)
    // Keep the saved offer available through transcription; dismissing only hides this UI.
  }

  // Audio lost / back notices (present-audio-capture.ts reports; recording-loss.ts says why).
  let lostDismissed = false
  let lostAlternative: AudioInput | null = null
  let lostMenuRevision = 0
  let micPicking = 0
  // The switch's words change with what it will do; its name on hover follows them.
  const labelLostSwitch = (button: HTMLElement, text: string): void =>
    dressPresenterButton(button, presenterControl('twrec-lost-switch'), SHORTCUT_REGISTRY, { label: text, name: text })
  async function pickMicrophone(input: Parameters<typeof controller.chooseMicrophone>[0]): Promise<boolean> {
    micPicking += 1
    const button = $('twrec-lost-switch') as HTMLButtonElement | null
    if (button) { button.disabled = true; labelLostSwitch(button, 'Still reconnecting…') }
    try { return await controller.chooseMicrophone(input) }
    finally {
      micPicking -= 1
      if (button) {
        button.disabled = micPicking > 0
        labelLostSwitch(button, micPicking ? 'Still reconnecting…' : lostAlternative ? `Use ${inputName(lostAlternative)}` : 'Choose microphone')
      }
      if (controller.audioStatus().lost) showLostToast()
    }
  }
  const hideLostToast = (): void => lostToast.classList.remove('show')
  const showLostToast = (): void => {
    const audio = controller.audioStatus()
    if (!audio.lost || lostDismissed) return
    if (lostText) {
      const since = audio.lostAtMs !== null ? ` at ${fmtClock(audio.lostAtMs)}` : ''
      // The microphone went away: recording waits for that one (it never takes another), so say which.
      const waiting = audio.reason === 'track-ended' || audio.reason === 'device-change' ? shortName(controller.microphoneName()) : ''
      lostText.innerHTML = audio.recovering
        ? `<b>Audio stopped${since}.</b> Nothing is being recorded. Reconnecting the microphone…`
        : `<b>Audio stopped${since}.</b> ${waiting ? `Waiting for ${escapeHtml(waiting)}.` : lossReasonText(audio.reason)} Nothing is being recorded.`
    }
    if (lostResume) {
      lostResume.hidden = audio.recovering
    }
    const revision = ++lostMenuRevision
    void controller.microphones().then(({ inputs, chosen }) => {
      if (revision !== lostMenuRevision || !controller.audioStatus().lost) return
      const alternatives = microphoneMenu(inputs, chosen).filter(r => !r.selected && !r.missing && r.input)
      lostAlternative = alternatives.length === 1 ? alternatives[0].input : null
      const button = $('twrec-lost-switch') as HTMLButtonElement | null
      if (button) {
        button.hidden = alternatives.length === 0
        button.disabled = micPicking > 0
        labelLostSwitch(button, micPicking ? 'Still reconnecting…' : lostAlternative ? `Use ${inputName(lostAlternative)}` : 'Choose microphone')
      }
    })
    showOnly(lostToast)
  }
  let backToastTimer: number | null = null
  const hideBackToast = (): void => {
    if (backToastTimer !== null) { window.clearTimeout(backToastTimer); backToastTimer = null }
    backToast.classList.remove('show')
  }
  const showBackToast = (gapMs: number): void => {
    if (backText) backText.innerHTML = `<b>Audio is back.</b> The ${Math.max(1, Math.round(gapMs / 1000))} s gap is noted in the Run.`
    showOnly(backToast)
    if (backToastTimer !== null) window.clearTimeout(backToastTimer)
    backToastTimer = window.setTimeout(hideBackToast, SAVED_TOAST_VISIBLE_MS)
  }

  // ── The microphone ───────────────────────────────────────────────────────────
  const micButton = $('twrec-mic')
  const micSelect = $('twrec-mic-select') as HTMLSelectElement | null
  const micLevel = $('twrec-mic-level')
  const micMeter = micLevel?.parentElement ?? null
  const micPanelNote = $('twrec-mic-panel-note')
  const micText = $('twrec-mic-text')
  let micInputs: AudioInput[] = []
  // The level meter: the input's own stream, only while the menu is open.
  let meter: { stream: MediaStream; context: AudioContext; frame: number } | null = null
  let meterToken = 0
  const setLevel = (level: number): void => {
    const pct = Math.round(Math.max(0, Math.min(1, level)) * 100)
    if (micLevel) micLevel.style.width = `${pct}%`
    const inline = $('twrec-idle-level')
    if (inline) inline.style.width = `${pct}%`
    $('twrec-idle-meter')?.setAttribute('aria-valuenow', String(pct))
    micMeter?.setAttribute('aria-valuenow', String(pct))
  }
  function stopMeter(): void {
    meterToken++
    if (meter) {
      cancelAnimationFrame(meter.frame)
      try { meter.stream.getTracks().forEach((t) => t.stop()) } catch { /* ignore */ }
      void meter.context.close().catch(() => {})
      meter = null
    }
    setLevel(0)
    showIdleMeter()
  }
  // The level and the name beside Record show only while the meter runs (Preview on, or the
  // Microphone menu open, before a recording): a still bar would say nothing. The Microphone
  // button's tooltip names the input too.
  function showIdleMeter(): void {
    const on = !!meter && ['idle', 'saved'].includes(controller.getState())
    const level = $('twrec-idle-meter'), name = $('twrec-idle-name')
    if (level) level.hidden = !on
    if (name) name.hidden = !on || !name.textContent
  }
  async function startMeter(input: AudioInput | null): Promise<void> {
    stopMeter()
    if (micPanelNote) micPanelNote.textContent = ''
    if (!input) return
    const token = meterToken
    let stream: MediaStream
    try {
      stream = await controller.previewMicrophone(input)
    } catch {
      if (token === meterToken && micPanelNote) micPanelNote.textContent = 'This microphone cannot be heard. Check that it is connected.'
      return
    }
    if (token !== meterToken || !previewWanted()) { try { stream.getTracks().forEach((t) => t.stop()) } catch { /* ignore */ } return }
    const Ctor = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) { try { stream.getTracks().forEach((t) => t.stop()) } catch { /* ignore */ } return }
    const context = new Ctor()
    void context.resume?.()
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    try {
      context.createMediaStreamSource(stream).connect(analyser)
    } catch {
      try { stream.getTracks().forEach((t) => t.stop()) } catch { /* ignore */ }
      void context.close().catch(() => {})
      return
    }
    const samples = new Float32Array(analyser.fftSize)
    meter = { stream, context, frame: 0 }
    showIdleMeter()
    const tick = (): void => {
      if (!meter || meter.context !== context) return
      analyser.getFloatTimeDomainData(samples)
      let sum = 0
      for (const v of samples) sum += v * v
      const rms = Math.sqrt(sum / samples.length)
      // -60 dB (silence) … 0 dB (full scale), so speech sits in the middle of the bar.
      setLevel(rms > 0 ? (20 * Math.log10(rms) + 60) / 60 : 0)
      meter.frame = requestAnimationFrame(tick)
    }
    tick()
  }
  function fillMicMenu(chosen: AudioInput | null): void {
    if (!micSelect) return
    const rows = microphoneMenu(micInputs, chosen)
    micSelect.innerHTML = ''
    if (!rows.some((r) => r.selected)) {
      // Nothing chosen and no built-in microphone to fall back to: the presenter picks.
      const none = document.createElement('option')
      none.textContent = rows.length ? 'Choose a microphone' : 'No microphone found'
      none.value = ''
      none.disabled = true
      none.selected = true
      micSelect.appendChild(none)
    }
    rows.forEach((row) => {
      const option = document.createElement('option')
      option.textContent = row.missing ? `${row.name} (not connected)` : row.name
      option.value = row.input ? String(micInputs.indexOf(row.input)) : ''
      option.disabled = row.missing
      option.selected = row.selected
      micSelect.appendChild(option)
    })
    if (micButton) micButton.dataset.tip = chosen ? `Microphone: ${inputName(chosen)}` : 'Microphone'
  }
  async function refreshMicMenu(note = ''): Promise<void> {
    const { inputs, chosen } = await controller.microphones()
    micInputs = inputs
    fillMicMenu(chosen)
    if (previewWanted()) await startMeter(chosen)
    const name = $('twrec-idle-name'); if (name) name.textContent = chosen ? inputName(chosen) : ''
    showIdleMeter()
    if (note && micPanelNote && !micPanelNote.textContent) micPanelNote.textContent = note
  }
  function placeMicPanel(): void {
    const at = micButton?.getBoundingClientRect()
    if (!at || at.width === 0) { micPanel.style.top = '86px'; micPanel.style.left = '26px'; return }
    micPanel.style.top = `${Math.round(at.bottom + 10)}px`
    micPanel.style.left = `${Math.round(Math.max(10, Math.min(window.innerWidth - micPanel.offsetWidth - 10, at.left + at.width / 2 - micPanel.offsetWidth / 2)))}px`
  }
  function openMicPanel(note = ''): void {
    micPanel.hidden = false
    micButton?.setAttribute('aria-expanded', 'true')
    placeMicPanel()
    updateSelfView()
    void refreshMicMenu(note).then(placeMicPanel)
    micSelect?.focus()
  }
  function closeMicPanel(): void {
    if (micPanel.hidden) return
    micPanel.hidden = true
    micButton?.setAttribute('aria-expanded', 'false')
    if (!previewEnabled) stopMeter()
    updateSelfView()
  }
  micSelect?.addEventListener('change', () => {
    const input = micInputs[Number(micSelect.value)]
    if (!input) return
    void pickMicrophone(input).then(() => refreshMicMenu())
  })
  micPanel.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    closeMicPanel()
    micButton?.focus()
  })
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as Node | null
    if (!micPanel.hidden && t && !micPanel.contains(t) && !micButton?.contains(t)) closeMicPanel()
  }, true)

  // A microphone connected during the talk: one notice each, never over an audio alert.
  let offeredMic: AudioInput | null = null
  const hideMicToast = (): void => { micToast.classList.remove('show'); offeredMic = null }
  const alertShowing = (): boolean => lostToast.classList.contains('show') || diskToast.classList.contains('show')
  function showMicToast(): void {
    if (!offeredMic || alertShowing()) return
    if (micText) micText.innerHTML = `<b>Room microphone available:</b> ${escapeHtml(shortName(inputName(offeredMic)))}. Use it?`
    showOnly(micToast)
  }
  // Record could not tell which microphone to use: never a guess, the presenter picks.
  controller.onNeedMicrophone((missing) => openMicPanel(`${missing ? `${shortName(missing)} isn't connected. ` : ''}Choose the microphone to record with, then press Record.`))
  controller.onNewMicrophone((input) => {
    offeredMic = input
    if (controller.audioStatus().lost) showLostToast()
    else showMicToast()
    if (!micPanel.hidden) void refreshMicMenu()
  })

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

  const captureChoice = document.getElementById('twrec-capture') as HTMLSelectElement
  captureChoice.addEventListener('change', () => controller.chooseCapture(captureChoice.value === 'camera' ? 'camera' : 'voice'))
  document.getElementById('twrec-flag')?.addEventListener('click', () => controller.markMistake())
  // Edit video opens the saved Run in Studio, where it plays back, is trimmed and exported (slice 3a).
  document.getElementById('twrec-edit-video')?.addEventListener('click', () => {
    const saved = controller.lastSave()
    // A new take goes back to the Run it is a take of.
    const runId = retake ? retake.runId : saved && saved.ok && !saved.discarded ? saved.sessionId : undefined
    void ipcRenderer.invoke('tools:open', 'studio', runId).catch(() => {})
  })
  const updateSelfView = mountSelfView(controller, layered, previewWanted)
  $('twrec-preview')?.addEventListener('change', event => {
    previewEnabled = (event.target as HTMLInputElement).checked
    if (!previewEnabled) closeMicPanel()
    if (previewWanted()) void refreshMicMenu(); else stopMeter()
    updateSelfView()
  })
  window.addEventListener('pagehide', () => { previewEnabled = false; micPanel.hidden = true; stopMeter(); updateSelfView() })
  let lastMediaState = ''
  $('twrec-again')?.addEventListener('click', () => {
    if (document.getElementById('twrec-restart')) return
    const dialog = document.createElement('dialog')
    dialog.id = 'twrec-restart'; dialog.className = 'twrec-device-check'
    dialog.innerHTML = '<h2>Start again?</h2><p>Discard this take and start a new recording? Earlier saved Runs are kept.</p><button id="twrec-restart-cancel">Keep this take</button><button id="twrec-restart-confirm">Discard and start again</button>'
    document.body.appendChild(dialog); dialog.showModal()
    dialog.querySelector('#twrec-restart-cancel')!.addEventListener('click', () => dialog.remove())
    dialog.querySelector('#twrec-restart-confirm')!.addEventListener('click', async () => {
      dialog.remove()
      try { await controller.discardTake(); await startCapture() }
      catch { const note = document.createElement('p'); note.className = 'twrec-error'; note.textContent = 'The take could not be discarded. Keep this presentation open.'; document.body.appendChild(note) }
    })
    dialog.addEventListener('cancel', () => dialog.remove())
  })
  let savingAudio = false
  // Record one slide again (the recording editor): a second bar says so, Record reads "Record slide n",
  // the layers are the Run's (no capture choice), and the saved take is named as a take of that Run.
  let retake: { runId: string; slideN: number } | null = null
  void ipcRenderer.invoke('recording:context').then((c: { retake?: { runId: string; slideN: number } } | null) => {
    if (!c?.retake) return
    retake = { runId: c.retake.runId, slideN: c.retake.slideN }
    const banner = document.createElement('div')
    banner.id = 'twrec-retake-banner'
    banner.setAttribute('role', 'status')
    banner.innerHTML = `<span class="rt-dot red" aria-hidden="true"></span><span>Recording slide ${retake.slideN} again. The rest of your video is kept as it is.</span>`
    banner.style.cssText = 'position:fixed;left:0;right:0;z-index:140;display:flex;align-items:center;gap:8px;padding:6px 16px;font:500 13px -apple-system,system-ui,sans-serif;color:#fff;background:#7a1f1f;box-shadow:0 1px 0 #0003'
    const place = (): void => { banner.style.top = `${Math.round(document.querySelector('#presenterRoot header')?.getBoundingClientRect().bottom ?? 0)}px` }
    document.body.appendChild(banner); place()
    window.addEventListener('resize', place)
    render()
  }).catch(() => {})
  function render(): void {
    const st = controller.getState()
    const gate = controller.runGate()
    if (st === 'saving' && gate.audioArmed && previewEnabled) {
      previewEnabled = false
      const previewToggle = $('twrec-preview') as HTMLInputElement | null
      if (previewToggle) previewToggle.checked = false
    }
    const idle = st === 'idle' || st === 'saved'
    const mediaState = `${idle}:${controller.captureChoice?.()}:${!!controller.cameraStream?.()}`
    if (mediaState !== lastMediaState) {
      lastMediaState = mediaState
      if (idle && layered && previewWanted()) void refreshMicMenu(); else stopMeter()
      updateSelfView()
    }
    showIdleMeter()
    $('twrec-again')!.hidden = st !== 'recording' && st !== 'paused'
    const audio = controller.audioStatus()
    const view = recView({ state: st, displayMs: controller.displayMs(), kind: controller.currentKind(), audioHeld: gate.audioArmed, audio })
    captureChoice.value = controller.captureChoice?.() ?? 'voice'
    captureChoice.hidden = !layered || st === 'recording' || st === 'paused' || st === 'saving' || st === 'confirm' || st === 'error'
    const flag = document.getElementById('twrec-flag')
    if (flag) flag.hidden = !layered || (st !== 'recording' && st !== 'paused')
    module.dataset.rec = st
    module.dataset.tone = view.tone
    if (dot) dot.hidden = view.mark !== 'dot'
    if (spinner) spinner.hidden = view.mark !== 'spinner'
    if (ok) ok.hidden = view.mark !== 'check'
    if (label) {
      label.textContent = (st === 'recording' || st === 'paused' || st === 'error') && controller.videoStatus?.().diskError ? 'Video interrupted · voice kept' : (st === 'recording' || st === 'paused') && controller.videoStatus?.().cameraLost ? (audio.lost ? 'Camera and microphone lost · slides continue' : 'Camera lost · slides and voice continue') : controller.refreshResumed?.() && !audio.lost ? 'Recording resumed after refresh' : view.word
      // Collapse step c5 drops only the words that the dot and the button's tooltip also carry.
      label.dataset.collapse = view.wordCollapses ? 'c5' : ''
    }
    if (clock) { clock.hidden = view.time === null; if (view.time !== null) clock.textContent = view.time }
    for (const [name, el] of buttons) if (el) el.hidden = !view.buttons.includes(name)
    // Keep deliberate switching available throughout the talk, including after a loss.
    const canChooseMic = view.buttons.includes('primary') || (layered && idle) || st === 'recording' || st === 'paused'
    if (micButton) micButton.hidden = !canChooseMic
    if (!canChooseMic) closeMicPanel()
    if (btnKeep) {
      dressPresenterButton(btnKeep, presenterControl('twrec-keep'), SHORTCUT_REGISTRY, view.retrying
        ? { label: 'Retry save', name: 'Retry saving this recording', icon: 'refresh-cw' }
        : { label: 'Keep' })
    }
    // The length a saved recording carries, for the saved toast after Change.
    if (st === 'saving') savingAudio = gate.audioArmed
    else if (st === 'saved' && savingAudio) { savedLengthMs = controller.displayMs(); savingAudio = false; showSavedToast() }
    if (st !== 'paused' || audio.lost) hideToast()
    if (!audio.lost || (st !== 'recording' && st !== 'paused')) { hideLostToast(); lostDismissed = false }
    if (retake) {
      captureChoice.hidden = true
      if (label && (st === 'recording' || st === 'paused')) label.textContent = `${st === 'paused' ? 'Paused' : 'Recording'} slide ${retake.slideN}`
      const word = primary?.querySelector('.tw-btn-label')
      if (word) word.textContent = `Record slide ${retake.slideN}`
    }
    if (st !== 'idle') hideStartToast()
    if (st === 'recording' || st === 'paused' || st === 'confirm') hideSavedToast()
    if (gate.saved || gate.audioArmed) hideSaveToast()
  }

  controller.onChange(render)
  controller.onSlideMovedWhilePaused(showToast)
  controller.onRunOffer(showSaveToast)
  controller.onRecordingStartOffer(showStartToast)
  controller.onCloseOffer((offer) => { hideSaveToast(); showPresentationCloseOffer(controller, offer) })
  controller.onAudio((_status, event, detail) => {
    if (event === 'disk-failed') { showOnly(diskToast); return }
    if (event === 'switched') return
    if (event === 'lost') lostDismissed = false
    if (event === 'restored') { hideLostToast(); showBackToast(detail?.gapMs ?? 0); return }
    showLostToast()
  })
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
  primary?.addEventListener('click', () => { void startCapture() })
  btnChangeKind?.addEventListener('click', () => { void saveWithPicker() })
  btnPause?.addEventListener('click', () => controller.pause())
  btnResume?.addEventListener('click', () => controller.resume())
  btnStop?.addEventListener('click', () => { void controller.stop() })
  btnKeep?.addEventListener('click', () => { void controller.confirmSave(true) })
  btnDiscard?.addEventListener('click', () => { void controller.confirmSave(false) })
  $('twrec-export')?.addEventListener('click', () => { void controller.exportHeldAudio() })
  $('twrec-toast-yes')?.addEventListener('click', () => { controller.resume(); hideToast() })
  $('twrec-toast-no')?.addEventListener('click', hideToast)
  $('twrec-save-delivery')?.addEventListener('click', () => { hideSaveToast(); void saveRun('delivery') })
  $('twrec-save-as')?.addEventListener('click', () => { void saveWithPicker() })
  $('twrec-save-dismiss')?.addEventListener('click', hideSaveToast)
  $('twrec-start-record')?.addEventListener('click', () => { hideStartToast(); void startCapture() })
  $('twrec-start-dismiss')?.addEventListener('click', hideStartToast)
  $('twrec-saved-change')?.addEventListener('click', () => { void saveWithPicker() })
  $('twrec-saved-dismiss')?.addEventListener('click', hideSavedToast)
  $('twrec-lost-switch')?.addEventListener('click', () => { if (lostAlternative) void pickMicrophone(lostAlternative); else openMicPanel() })
  lostResume?.addEventListener('click', () => { void controller.reacquireAudio() })
  $('twrec-lost-dismiss')?.addEventListener('click', () => { lostDismissed = true; hideLostToast() })
  $('twrec-back-dismiss')?.addEventListener('click', hideBackToast)
  $('twrec-disk-dismiss')?.addEventListener('click', () => diskToast.classList.remove('show'))
  micButton?.addEventListener('click', () => { if (micPanel.hidden) openMicPanel(); else closeMicPanel() })
  $('twrec-mic-use')?.addEventListener('click', () => {
    const input = offeredMic
    hideMicToast()
    if (input) void pickMicrophone(input).then(() => { if (!micPanel.hidden) void refreshMicMenu() })
  })
  $('twrec-mic-dismiss')?.addEventListener('click', hideMicToast)
  window.addEventListener('resize', () => { if (!micPanel.hidden) placeMicPanel() })

  // 5) Keyboard — ⇧R record/stop, ⇧P pause/resume. Capture phase so we act before the
  // presenter's own handler; plain P/R stay the presenter's (pacing timer / reveal).
  function toggleRecord(): void {
    const st = controller.getState()
    if (st === 'recording' || st === 'paused') void controller.stop()
    else if (st === 'idle' || st === 'saved' || st === 'error') void startCapture()
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
      reportGuideCommand('presenter.save-run-as')
      return
    }
    if (saveToast.classList.contains('show') && e.key === 'Enter') {
      e.preventDefault()
      e.stopImmediatePropagation()
      hideSaveToast()
      void saveRun('delivery')
      reportGuideCommand('presenter.save-run')
      return
    }
    if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === 'R' || e.key === 'r') { e.preventDefault(); e.stopImmediatePropagation(); hideStartToast(); toggleRecord(); reportGuideCommand('presenter.record') }
    else if (e.key === 'M' || e.key === 'm') { e.preventDefault(); e.stopImmediatePropagation(); controller.markMistake(); reportGuideCommand('presenter.record-flag') }
    else if (e.key === 'P' || e.key === 'p') { e.preventDefault(); e.stopImmediatePropagation(); togglePause(); reportGuideCommand('presenter.record-pause') }
  }, true)

  // The ? sheet's Recording rows come from the shortcut registry (presenter.record,
  // presenter.record-pause, presenter.save-run-as, presenter.save-run); the template shows them
  // while this module is mounted (presenter redesign ticket 07).

  render()
}
