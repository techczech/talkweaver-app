/// <reference lib="dom" />
import { contextBridge, ipcRenderer } from 'electron'
import type { LiveStatus } from '../main/live-presenter-client'
import type { PollStateMessage, PresenterPollMessage } from '../../worker/protocol'
import {
  liveControlPresentation,
  liveSlideStateKey,
  presenterFocusState,
  presenterRevealState,
  slideIdForAudience,
} from './present-live-state'

type LiveGoResult = {
  success: boolean
  status?: LiveStatus
  shortUrl?: string
  qrSvg?: string
  error?: string
}

// The presenter template runs in the page's main world; this bridge runs in the isolated
// preload world (contextIsolation). `window` CustomEvents do NOT carry their object `detail`
// across that boundary — that silently broke poll open/close/reveal/hide and results, while
// DOM-polled slide-follow kept working. So the poll channel goes through contextBridge (the
// same mechanism the editor preload uses for `tw`), exposed at module load so it exists
// before the template registers its handlers.
let pollStateHandler: ((message: PollStateMessage) => void) | null = null
let liveStatusHandler: ((status: LiveStatus) => void) | null = null
type PollActionResult = { success: boolean; operationId?: string; status?: 'pending' | 'confirmed' | 'rejected'; error?: string }
type PollOperation = { operationId: string; status: 'pending' | 'confirmed' | 'rejected'; message: PresenterPollMessage; error?: string }
type PollJoin = { shortUrl: string; qrSvg: string }
let joinHandler: ((value: PollJoin) => void) | null = null
let operationHandler: ((value: PollOperation) => void) | null = null
const cachedPolls = new Map<string, PollStateMessage>()
const cachedOperations = new Map<string, PollOperation>()
let cachedJoin: PollJoin | null = null
let cachedStatus: LiveStatus | null = null
let statusRevision = 0
let sessionEpoch = 0
let joinRevision = 0
let statusRenderer: ((status: LiveStatus) => void) | null = null
function sessionFinished(status: LiveStatus): boolean { return ['ended', 'expired'].includes(status) }
function sessionCanStart(status: LiveStatus): boolean { return ['ended', 'expired', 'authentication-failed', 'incompatible'].includes(status) }
function updateStatus(status: LiveStatus): void {
  cachedStatus = status
  if (sessionFinished(status)) { sessionEpoch++; cachedPolls.clear(); cachedOperations.clear(); cachedJoin = null }
  try { statusRenderer?.(status) } catch { /* inert */ }
  try { liveStatusHandler?.(status) } catch { /* inert */ }
}
ipcRenderer.on('live:status', (_event, status: LiveStatus) => {
  statusRevision++
  updateStatus(status)
})

function updateJoin(value: PollJoin): void {
  joinRevision++
  cachedJoin = value
  try { joinHandler?.(value) } catch { /* presenting stays independent */ }
}

async function forwardPollAction(message: PresenterPollMessage): Promise<PollActionResult> {
  if (!message) return { success: false, status: 'rejected', error: 'Invalid poll action.' }
  const invoke = message.type === 'poll.open'
    ? ipcRenderer.invoke('live:poll-open', message.poll)
    : message.type === 'poll.close'
      ? ipcRenderer.invoke('live:poll-close', message.pollId)
      : message.type === 'poll.reveal'
        ? ipcRenderer.invoke('live:poll-reveal', message.pollId)
        : message.type === 'poll.hide' ? ipcRenderer.invoke('live:poll-hide', message.pollId, message.responseId, message.hidden ?? true)
          : Promise.resolve({ success: false, status: 'rejected', error: 'Invalid poll action.' })
  try { return await invoke as PollActionResult }
  catch { return { success: false, status: 'rejected', error: 'Could not update the poll. Try again.' } }
}

try {
  contextBridge.exposeInMainWorld('twLivePollBridge', {
    action: (message: PresenterPollMessage) => forwardPollAction(message),
    onState: (callback: (message: PollStateMessage) => void) => {
      pollStateHandler = callback
      queueMicrotask(() => { for (const value of cachedPolls.values()) { try { callback(value) } catch { /* inert */ } } })
    },
    onStatus: (callback: (status: LiveStatus) => void) => {
      liveStatusHandler = callback
      queueMicrotask(() => { if (cachedStatus) { try { callback(cachedStatus) } catch { /* inert */ } } })
    },
    onJoin: (callback: (value: PollJoin) => void) => {
      joinHandler = callback
      queueMicrotask(() => { if (cachedJoin) { try { callback(cachedJoin) } catch { /* inert */ } } })
    },
    onOperation: (callback: (value: PollOperation) => void) => {
      operationHandler = callback
      const operations = [...cachedOperations.values()]
      queueMicrotask(() => { for (const value of operations) { try { callback(value) } catch { /* inert */ } } })
    },
  })
} catch { /* not a contextIsolated preload, or already exposed — inert */ }

ipcRenderer.on('live:poll-state', (_event, message: PollStateMessage) => {
  cachedPolls.set(message.pollId, message)
  try { pollStateHandler?.(message) } catch { /* inert */ }
})
ipcRenderer.on('live:poll-operation', (_event, operation: PollOperation) => {
  cachedOperations.set(operation.operationId, operation)
  try { operationHandler?.(operation) } catch { /* inert */ }
})
const snapshotSessionEpoch = sessionEpoch
const snapshotStatusRevision = statusRevision
const snapshotJoinRevision = joinRevision
void ipcRenderer.invoke('live:snapshot').then((value: { status?: LiveStatus; shortUrl?: string; qrSvg?: string; polls?: PollStateMessage[]; pending?: Array<{ operationId: string; action: PresenterPollMessage }> }) => {
  if (!value || sessionEpoch !== snapshotSessionEpoch) return
  if (statusRevision !== snapshotStatusRevision && cachedStatus && sessionFinished(cachedStatus)) return
  if (value.status && statusRevision === snapshotStatusRevision) cachedStatus = value.status
  if (value.shortUrl && joinRevision === snapshotJoinRevision) updateJoin({ shortUrl: value.shortUrl, qrSvg: value.qrSvg || '' })
  for (const message of value.polls || []) {
    // Push events received while the request was in flight are newer than its snapshot.
    if (cachedPolls.has(message.pollId)) continue
    cachedPolls.set(message.pollId, message)
    try { pollStateHandler?.(message) } catch { /* inert */ }
  }
  for (const pending of value.pending || []) {
    if (cachedOperations.has(pending.operationId)) continue
    const operation: PollOperation = { operationId: pending.operationId, status: 'pending', message: pending.action }
    cachedOperations.set(operation.operationId, operation)
    try { operationHandler?.(operation) } catch { /* inert */ }
  }
  if (cachedStatus) updateStatus(cachedStatus)
}).catch(() => { /* an older app lacks snapshot IPC; live push events still work */ })

function currentSlideState(): { slideId: string; reveal: number; focus: ReturnType<typeof presenterFocusState> } | null {
  const slideId = location.hash.startsWith('#') ? decodeURIComponent(location.hash.slice(1)) : ''
  const active = document.querySelector('.slide.active')
  if (!slideId || !active) return null
  return {
    slideId: slideIdForAudience(slideId, active as HTMLElement),
    reveal: presenterRevealState(document.documentElement.dataset),
    focus: presenterFocusState(document.documentElement.dataset),
  }
}

export function mountLiveBridge(): void {
  const goButton = document.getElementById('liveGoButton') as HTMLButtonElement | null
  const panel = document.getElementById('liveGoPanel')
  const panelClose = document.getElementById('liveGoPanelClose')
  const qr = document.getElementById('liveQr')
  const url = document.getElementById('liveShortUrl')
  if (!goButton || !panel || !qr || !url) return

  let status: LiveStatus = cachedStatus || 'ended'
  const renderStatus = (next: LiveStatus): void => {
    status = next
    cachedStatus = next
    const presentation = liveControlPresentation(next)
    goButton.textContent = presentation.label
    goButton.title = presentation.title
    goButton.dataset.liveTone = presentation.tone
    goButton.classList.toggle('is-live', next === 'live')
    goButton.classList.toggle('is-reconnecting', next === 'paused-reconnecting')
    goButton.setAttribute('aria-label', presentation.title)
    goButton.disabled = next === 'ending'
    if (sessionFinished(next)) panel.hidden = true
  }
  statusRenderer = renderStatus
  renderStatus(status)
  const showError = (message: string): void => {
    window.setTimeout(() => {
      goButton.textContent = message
      goButton.title = message
      goButton.dataset.liveTone = 'idle'
      window.setTimeout(() => renderStatus(status), 4200)
    }, 0)
  }

  const toggleLive = async (): Promise<void> => {
    if (goButton.disabled) return
    goButton.disabled = true
    goButton.textContent = sessionCanStart(status) ? 'Going live…' : 'Ending live…'
    try {
      if (!sessionCanStart(status)) {
        if (!window.confirm('End this live session?')) return
        const result = await ipcRenderer.invoke('live:end') as LiveGoResult
        if (!result.success) showError(result.error || 'Could not end the live session')
        else updateStatus(result.status ?? 'ended')
        return
      }
      const result = await ipcRenderer.invoke('live:go') as LiveGoResult
      if (!result.success || !result.shortUrl) {
        showError(result.error || 'Could not start the live session')
        return
      }
      qr.innerHTML = result.qrSvg || ''
      url.textContent = result.shortUrl
      updateJoin({ shortUrl: result.shortUrl, qrSvg: result.qrSvg || '' })
      panel.hidden = false
      updateStatus(result.status ?? 'connecting')
      last = ''
      report()
    } catch {
      showError('Live session unavailable · presenting is unaffected')
    } finally {
      goButton.disabled = false
      renderStatus(status)
    }
  }
  goButton.addEventListener('click', () => { void toggleLive() })
  panelClose?.addEventListener('click', () => { panel.hidden = true })
  window.addEventListener('keydown', (event) => {
    const target = event.target
    if (target instanceof HTMLElement && target.matches('input, textarea, select, [contenteditable="true"]')) return
    if (event.key === 'Escape' && !panel.hidden) {
      event.preventDefault()
      event.stopImmediatePropagation()
      panel.hidden = true
      return
    }
    if ((event.key === 'g' || event.key === 'G') && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      event.preventDefault()
      event.stopImmediatePropagation()
      void toggleLive()
    }
  }, true)
  // Poll open/close/reveal/hide and results now cross the isolation boundary via the
  // contextBridge `twLivePollBridge` (exposed above), NOT window events.
  const requestedStatusRevision = statusRevision
  void ipcRenderer.invoke('live:status').then((next: LiveStatus) => {
    if (statusRevision === requestedStatusRevision) updateStatus(next)
  }).catch(() => {})

  let last = ''
  const report = (): void => {
    const state = currentSlideState()
    if (!state) return
    const key = liveSlideStateKey(state)
    if (key === last) return
    last = key
    ipcRenderer.send('live:publish-slide', state)
  }
  const poll = window.setInterval(report, 150)
  window.addEventListener('hashchange', report)
  window.addEventListener('beforeunload', () => window.clearInterval(poll), { once: true })
  report()
}
