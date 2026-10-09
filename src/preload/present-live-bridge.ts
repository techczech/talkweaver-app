/// <reference lib="dom" />
import { parsePointerMessage, type InkMessage } from '../../worker/protocol'
import { readInkSlot } from './recorder-ink'
import { askEndLiveWithBoards, type OpenBoard } from './present-end-live-boards'
// `clipboard` is used to WRITE the join link only; reading it is main's (`live:read-clipboard`).
import { clipboard, contextBridge, ipcRenderer } from 'electron'
import type { LiveStatus } from '../main/live-presenter-client'
import { venueScreenLinkFromUrl } from '../shared/venue-screen-link'
import { dressPresenterButton, presenterControl, presenterIconSvg } from '../shared/presenter-controls.ts'
import { SHORTCUT_REGISTRY } from '../shared/shortcut-registry.ts'
import { LIVE_BRIDGE_ATTRIBUTE } from '../shared/presenter-palette.ts'
import type { InstantSlide, PollStateMessage, PresenterAudienceMessage, PresenterBoardMessage, PresenterInstantMessage, PresenterPollMessage } from '../../worker/protocol'
import {
  linkLabel,
  liveControlPresentation,
  liveSessionCanStart,
  liveSessionFinished,
  liveSlideStateKey,
  liveToggleIntent,
  AUDIENCE_FEEDBACK_START,
  audienceCountsView,
  nextAudienceFeedback,
  trayPreworkQuestions,
  withPreworkQuestions,
  type AudienceFeedbackPush,
  type AudienceFeedbackState,
  type TrayQuestion,
  liveStatusView,
  nextVenueWatch,
  presenterLiveSlideState,
  settleVenueWatch,
  VENUE_BACK_MS,
  VENUE_WATCH_START,
  venueNoticeView,
  venueScreenCountLabel,
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
type PollOperation = { operationId: string; status: 'pending' | 'confirmed' | 'rejected'; message: PresenterPollMessage | PresenterInstantMessage | PresenterAudienceMessage | PresenterBoardMessage; error?: string }
type PollJoin = { shortUrl: string; qrSvg: string }
let joinHandler: ((value: PollJoin) => void) | null = null
let operationHandler: ((value: PollOperation) => void) | null = null
let instantHandler: ((value: InstantSlide | null) => void) | null = null
let cachedInstant: InstantSlide | null = null
let instantRevision = 0
const cachedPolls = new Map<string, PollStateMessage>()
const cachedOperations = new Map<string, PollOperation>()
let cachedJoin: PollJoin | null = null
let cachedStatus: LiveStatus | null = null
let statusRevision = 0
let sessionEpoch = 0
let joinRevision = 0
let audienceHandler: ((counts: ReturnType<typeof audienceCountsView>) => void) | null = null
let audienceFeedback: AudienceFeedbackState = AUDIENCE_FEEDBACK_START
let audienceSlideId: string | null = null
let audienceRevision = 0
// The questions tray's own hook: every question the worker holds, and whether a session is up.
let questionsHandler: ((view: { questions: TrayQuestion[]; live: boolean }) => void) | null = null
// The Run's pre-work questions put in the talk's questions (ticket 11): main's own list, beside the phones'.
let preworkQuestions: TrayQuestion[] = []
const showAudienceCounts = (): void => {
  const shown = withPreworkQuestions(audienceFeedback, preworkQuestions)
  try { audienceHandler?.(audienceCountsView(shown, audienceSlideId, cachedStatus || 'ended')) } catch { /* inert */ }
  try { questionsHandler?.({ questions: shown.questions, live: cachedStatus === 'live' || cachedStatus === 'paused-reconnecting' }) } catch { /* inert */ }
}
let statusRenderer: ((status: LiveStatus) => void) | null = null
let venueCountRenderer: ((count: number) => void) | null = null
let venueLinkRenderer: ((url: string) => void) | null = null
let cachedVenueScreens = 0
let presenceRevision = 0
const sessionFinished = liveSessionFinished
const sessionCanStart = liveSessionCanStart
function updateStatus(status: LiveStatus): void {
  cachedStatus = status
  if (sessionFinished(status)) {
    sessionEpoch++; cachedPolls.clear(); cachedOperations.clear(); cachedJoin = null
    cachedVenueScreens = 0; venueCountRenderer?.(0)
    cachedInstant = null
  }
  if (sessionFinished(status)) audienceFeedback = AUDIENCE_FEEDBACK_START
  try { statusRenderer?.(status) } catch { /* inert */ }
  try { liveStatusHandler?.(status) } catch { /* inert */ }
  showAudienceCounts()
}
ipcRenderer.on('live:status', (_event, status: LiveStatus) => {
  statusRevision++
  updateStatus(status)
})
ipcRenderer.on('live:presence', (_event, presence: { venueScreens?: number }) => {
  if (!Number.isSafeInteger(presence?.venueScreens) || presence.venueScreens! < 0) return
  cachedVenueScreens = presence.venueScreens!
  presenceRevision++
  venueCountRenderer?.(cachedVenueScreens)
})

function updateJoin(value: PollJoin): void {
  joinRevision++
  cachedJoin = value
  venueLinkRenderer?.(value.shortUrl)
  try { joinHandler?.(value) } catch { /* presenting stays independent */ }
}

async function forwardPollAction(message: PresenterPollMessage | PresenterInstantMessage): Promise<PollActionResult> {
  if (!message) return { success: false, status: 'rejected', error: 'Invalid poll action.' }
  const invoke = message.type === 'instant.show' || message.type === 'instant.clear'
    ? ipcRenderer.invoke('live:instant-action', message)
    : message.type === 'poll.open'
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
    qrSvg: (url: string) => ipcRenderer.invoke('live:instant-qr', url) as Promise<{ success: boolean; svg?: string }>,
    fitImage: (bytes: Uint8Array) => ipcRenderer.invoke('live:fit-instant-image', bytes),
    // The Live menu's "Instant slide from clipboard" (presenter redesign ticket 04): a menu press
    // has no paste event, and the window's permission handler denies the web clipboard. The read is
    // main's (`live:read-clipboard`: presenter window, focused, a real press in the last five
    // seconds; embed-sandbox design 4.3). Here it is asked for only while this page holds a user
    // activation, which a click on the menu item or Enter in the palette gives it.
    readClipboard: async (): Promise<{ text: string; image: Uint8Array | null }> => {
      if (navigator.userActivation?.isActive !== true) return { text: '', image: null }
      const clip = await ipcRenderer.invoke('live:read-clipboard') as { text?: unknown; image?: unknown } | null
      return { text: typeof clip?.text === 'string' ? clip.text : '', image: clip?.image instanceof Uint8Array ? clip.image : null }
    },
    action: (message: PresenterPollMessage | PresenterInstantMessage) => forwardPollAction(message),
    onInstant: (callback: (value: InstantSlide | null) => void) => {
      instantHandler = callback
      queueMicrotask(() => { try { callback(cachedInstant) } catch { /* inert */ } })
    },
    onState: (callback: (message: PollStateMessage) => void) => {
      pollStateHandler = callback
      queueMicrotask(() => { for (const value of cachedPolls.values()) { try { callback(value) } catch { /* inert */ } } })
    },
    onStatus: (callback: (status: LiveStatus) => void) => {
      liveStatusHandler = callback
      queueMicrotask(() => { if (cachedStatus) { try { callback(cachedStatus) } catch { /* inert */ } } })
    },
    // The status bar's reactions chip and questions counter (ADR-0027 §4): callback({ reactions:
    // { puzzled, helped, bookmark } | null, questions: number | null }) for the slide on screen, again
    // whenever a count, the slide or the session status changes.
    onAudience: (callback: (counts: ReturnType<typeof audienceCountsView>) => void) => {
      audienceHandler = callback
      queueMicrotask(showAudienceCounts)
    },
    // The questions tray (ADR-0027, ticket 03): callback({ questions, live }) with every question the
    // worker holds (answered or not; text and name are untrusted), again whenever they change.
    onQuestions: (callback: (view: { questions: TrayQuestion[]; live: boolean }) => void) => {
      questionsHandler = callback
      queueMicrotask(showAudienceCounts)
    },
    // Mark one question answered (or not); the worker's next questions.state is what the tray then shows.
    answerQuestion: (questionId: string, answered = true): Promise<PollActionResult> =>
      typeof questionId === 'string' && questionId
        ? Promise.resolve(ipcRenderer.invoke('live:question-answer', questionId, answered !== false)).then((value) => value as PollActionResult)
          .catch(() => ({ success: false, status: 'rejected' as const, error: 'Could not mark the question answered. Try again.' }))
        : Promise.resolve({ success: false, status: 'rejected' as const, error: 'Invalid question.' }),
    // The Live menu's "From phones · this talk" switches (ADR-0027 amendment): `{ questionsAllowed?,
    // reactionsAllowed? }` goes to the worker as `switches.set` through the presenter's operation queue.
    setSwitches: (patch: { questionsAllowed?: boolean; reactionsAllowed?: boolean }): Promise<PollActionResult> => {
      const clean: { questionsAllowed?: boolean; reactionsAllowed?: boolean } = {}
      if (typeof patch?.questionsAllowed === 'boolean') clean.questionsAllowed = patch.questionsAllowed
      if (typeof patch?.reactionsAllowed === 'boolean') clean.reactionsAllowed = patch.reactionsAllowed
      if (clean.questionsAllowed === undefined && clean.reactionsAllowed === undefined) return Promise.resolve({ success: false, status: 'rejected' as const, error: 'Invalid switch.' })
      return Promise.resolve(ipcRenderer.invoke('live:switches', clean)).then((value) => value as PollActionResult)
        .catch(() => ({ success: false, status: 'rejected' as const, error: 'Could not update the phones. Try again.' }))
    },
    // The board panel (feedback-boards ticket 05): one board operation (board.move, board.merge,
    // board.split, board.hide, board.freeze, board.release, board.limit) through the presenter's
    // acknowledged operation queue; main checks it with the worker's own parser.
    boardAction: (message: PresenterBoardMessage): Promise<PollActionResult> =>
      Promise.resolve(ipcRenderer.invoke('live:board-action', message)).then((value) => value as PollActionResult)
        .catch(() => ({ success: false, status: 'rejected' as const, error: 'storage_failed' })),
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
ipcRenderer.on('live:audience', (_event, push: AudienceFeedbackPush) => {
  if (!push || (push.kind !== 'snapshot' && push.kind !== 'reaction' && push.kind !== 'questions')) return
  audienceRevision++
  audienceFeedback = nextAudienceFeedback(audienceFeedback, push)
  showAudienceCounts()
})
ipcRenderer.on('live:prework-questions', (_event, list: unknown) => {
  preworkQuestions = trayPreworkQuestions(list)
  showAudienceCounts()
})
ipcRenderer.on('live:instant-state', (_event, slide: InstantSlide | null) => {
  instantRevision++
  cachedInstant = slide
  try { instantHandler?.(slide) } catch { /* inert */ }
})
ipcRenderer.on('live:poll-operation', (_event, operation: PollOperation) => {
  cachedOperations.set(operation.operationId, operation)
  try { operationHandler?.(operation) } catch { /* inert */ }
})
const snapshotSessionEpoch = sessionEpoch
const snapshotStatusRevision = statusRevision
const snapshotJoinRevision = joinRevision
const snapshotPresenceRevision = presenceRevision
const snapshotInstantRevision = instantRevision
const snapshotAudienceRevision = audienceRevision
void ipcRenderer.invoke('live:snapshot').then((value: { status?: LiveStatus; shortUrl?: string; qrSvg?: string; venueScreens?: number; polls?: PollStateMessage[]; instantSlide?: InstantSlide | null; reactionCounts?: AudienceFeedbackState['reactionCounts']; questions?: Array<{ answered: boolean }>; pending?: Array<{ operationId: string; action: PresenterPollMessage | PresenterInstantMessage }> }) => {
  if (!value || sessionEpoch !== snapshotSessionEpoch) return
  if (statusRevision !== snapshotStatusRevision && cachedStatus && sessionFinished(cachedStatus)) return
  if (value.status && statusRevision === snapshotStatusRevision) cachedStatus = value.status
  if (value.shortUrl && joinRevision === snapshotJoinRevision) updateJoin({ shortUrl: value.shortUrl, qrSvg: value.qrSvg || '' })
  if (presenceRevision === snapshotPresenceRevision && Number.isSafeInteger(value.venueScreens) && value.venueScreens! >= 0) {
    cachedVenueScreens = value.venueScreens!
    venueCountRenderer?.(cachedVenueScreens)
  }
  if (instantRevision === snapshotInstantRevision) {
    cachedInstant = value.instantSlide ?? null
    try { instantHandler?.(cachedInstant) } catch { /* inert */ }
  }
  // Pushes received while the request was in flight are newer than its snapshot.
  if (!preworkQuestions.length) {
    preworkQuestions = trayPreworkQuestions((value as { preworkQuestions?: unknown }).preworkQuestions)
    if (preworkQuestions.length) showAudienceCounts()
  }
  if (audienceRevision === snapshotAudienceRevision && (value.reactionCounts || value.questions)) {
    audienceFeedback = nextAudienceFeedback(audienceFeedback, { kind: 'snapshot', reactionCounts: value.reactionCounts ?? {}, questions: value.questions ?? [] })
    showAudienceCounts()
  }
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

function currentSlideState(): ReturnType<typeof presenterLiveSlideState> {
  const active = document.querySelector('.slide.active')
  return presenterLiveSlideState(location.hash, active as HTMLElement | null, document.documentElement.dataset)
}

export function mountLiveBridge(): void {
  const goButton = document.getElementById('liveGoButton') as HTMLButtonElement | null
  const panel = document.getElementById('liveGoPanel')
  const panelClose = document.getElementById('liveGoPanelClose')
  const qr = document.getElementById('liveQr')
  const url = document.getElementById('liveShortUrl')
  const venueUrl = document.getElementById('liveVenueUrl')
  const venueCopy = document.getElementById('liveVenueCopy') as HTMLButtonElement | null
  const venueCount = document.getElementById('liveVenueCount')
  if (!goButton || !panel || !qr || !url) return
  // The venue-screen notice in the status bar, beside the live status (presenter redesign ticket
  // 06; ADR-0026 §3): the session's presence count through nextVenueWatch(); "following again"
  // clears after VENUE_BACK_MS.
  const venueNotice = document.getElementById('presenterVenueNotice')
  let venueWatch = VENUE_WATCH_START
  let venueBackTimer: ReturnType<typeof setTimeout> | undefined
  const renderVenueNotice = (): void => {
    if (!venueNotice) return
    const view = venueNoticeView(venueWatch.notice)
    venueNotice.hidden = view.hidden
    venueNotice.dataset.tone = view.tone
    if (view.tip) venueNotice.dataset.tip = view.tip
    else delete venueNotice.dataset.tip
    const doc = venueNotice.ownerDocument
    const label = doc.createElement('span')
    label.className = 'tw-venue-label'
    label.append(view.lead)
    if (view.long) {
      const long = doc.createElement('span')
      long.className = 'tw-venue-long'
      long.textContent = view.long
      label.append(long)
    }
    label.append(view.tail)
    venueNotice.innerHTML = view.icon ? presenterIconSvg(view.icon) : ''
    venueNotice.append(label)
  }
  const updateVenueWatch = (): void => {
    const previous = venueWatch
    venueWatch = nextVenueWatch(previous, cachedStatus || 'ended', cachedVenueScreens)
    if (venueWatch.notice === 'back' && previous.notice !== 'back') {
      clearTimeout(venueBackTimer)
      venueBackTimer = setTimeout(() => { venueWatch = settleVenueWatch(venueWatch); renderVenueNotice() }, VENUE_BACK_MS)
    }
    if (venueWatch.notice !== previous.notice) renderVenueNotice()
  }
  const showVenueCount = (count: number): void => {
    if (venueCount) {
      const label = venueScreenCountLabel(count)
      venueCount.innerHTML = label ? presenterIconSvg('monitor-check') : ''
      venueCount.append(label)
      venueCount.hidden = count === 0
    }
    updateVenueWatch()
  }
  venueCountRenderer = showVenueCount
  showVenueCount(cachedVenueScreens)
  // The Live menu's Show join link and Copy venue-screen link (presenter redesign ticket 04).
  const showJoin = document.getElementById('liveShowJoin') as HTMLButtonElement | null
  const copyVenueItem = document.getElementById('liveCopyVenueLink') as HTMLButtonElement | null
  venueLinkRenderer = (shortUrl: string): void => {
    // Shown without the scheme, as drawn, so it fits the panel; Copy takes the whole link.
    const link = venueScreenLinkFromUrl(shortUrl) || ''
    if (venueUrl) { venueUrl.textContent = linkLabel(link); venueUrl.dataset.link = link }
    if (copyVenueItem) copyVenueItem.disabled = !link
  }
  if (cachedJoin) venueLinkRenderer(cachedJoin.shortUrl)
  const copyVenueLink = (): void => {
    const link = venueUrl?.dataset.link
    if (link) clipboard.writeText(link)
  }
  venueCopy?.addEventListener('click', copyVenueLink)
  copyVenueItem?.addEventListener('click', copyVenueLink)
  showJoin?.addEventListener('click', () => {
    if (cachedJoin && !url.textContent) {
      qr.innerHTML = cachedJoin.qrSvg || ''
      url.textContent = linkLabel(cachedJoin.shortUrl)
    }
    panel.hidden = false
  })

  // The live button takes its key from the registry; the label (the live status) and the name
  // (what pressing it does) change with the state. As an item of the Live menu (presenter redesign
  // ticket 04) it reads as the action, Go live or End live session (radio-off, in red), and stays.
  const inMenu = !!goButton.closest('[role="menu"]')
  const setGoButton = (label: string, name: string, ending = false): void =>
    dressPresenterButton(goButton, presenterControl('liveGoButton'), SHORTCUT_REGISTRY, { label: inMenu ? name : label, name, icon: inMenu && ending ? 'radio-off' : undefined })
  // The status bar's live slot (ADR-0031 §2 and §7): live status shows once, there, with End live
  // while a session can be ended; the Go live button steps aside while a session is up.
  const liveSlot = document.getElementById('presenterLiveStatus')
  const liveIcon = document.getElementById('presenterLiveIcon')
  const liveLabel = document.getElementById('presenterLiveLabel')
  const endLive = document.getElementById('presenterEndLive') as HTMLButtonElement | null
  if (endLive) dressPresenterButton(endLive, presenterControl('presenterEndLive'), SHORTCUT_REGISTRY, { label: 'End live' })
  // "Not live" is the Go live button (Dominik's preview.8 feedback): it carries the status's icon
  // and words, is named "Go live" with G from the registry, and runs the Live menu's Go live.
  // While it shows, the slot's plain icon and words step aside; every other state is status text.
  const goLive = document.getElementById('presenterGoLive') as HTMLButtonElement | null
  if (goLive) {
    dressPresenterButton(goLive, presenterControl('presenterGoLive'), SHORTCUT_REGISTRY, { label: 'Not live' })
    // Its visible words start the accessible name (label in name), then what pressing it does.
    goLive.setAttribute('aria-label', 'Not live. Go live')
  }
  const renderLiveSlot = (view: ReturnType<typeof liveStatusView>): void => {
    if (!liveSlot || !liveLabel) return
    liveSlot.hidden = false
    liveSlot.dataset.tone = view.tone
    liveLabel.textContent = view.label
    if (liveIcon && liveIcon.dataset.icon !== view.icon) {
      liveIcon.innerHTML = presenterIconSvg(view.icon)
      liveIcon.dataset.icon = view.icon
    }
    const asButton = !!goLive && view.canStart
    if (goLive) goLive.hidden = !asButton
    liveLabel.hidden = asButton
    if (liveIcon) liveIcon.hidden = asButton
    if (endLive) endLive.hidden = !view.canEnd
  }
  let status: LiveStatus = cachedStatus || 'ended'
  const renderStatus = (next: LiveStatus): void => {
    status = next
    cachedStatus = next
    const presentation = liveControlPresentation(next)
    const view = liveStatusView(next)
    setGoButton(presentation.label, presentation.title, view.canEnd)
    goButton.classList.toggle('is-danger', view.canEnd)
    goButton.dataset.liveTone = presentation.tone
    goButton.classList.toggle('is-live', next === 'live')
    goButton.classList.toggle('is-reconnecting', next === 'paused-reconnecting')
    goButton.disabled = next === 'ending'
    // Only where the status bar can show it: without the slot the button still carries the status.
    // In the Live menu it stays, as End live session.
    if (liveSlot && !inMenu) goButton.hidden = view.active
    if (showJoin) showJoin.disabled = !view.active
    renderLiveSlot(view)
    updateVenueWatch()
    if (sessionFinished(next)) panel.hidden = true
  }
  statusRenderer = renderStatus
  renderStatus(status)
  const showError = (message: string): void => {
    window.setTimeout(() => {
      setGoButton(message, message)
      goButton.dataset.liveTone = 'idle'
      renderLiveSlot({ ...liveStatusView(status), label: message, canStart: false })
      window.setTimeout(() => renderStatus(status), 4200)
    }, 0)
  }

  const toggleLive = async (): Promise<void> => {
    if (goButton.disabled) return
    goButton.disabled = true
    const intent = liveToggleIntent(status)
    setGoButton(intent.action === 'start' ? 'Going live…' : 'Ending live…', liveControlPresentation(status).title)
    try {
      // The one question seam: End live asks before ending; Go live over a session another window
      // took over asks before starting here. Cancel leaves the state as it is. With a board still
      // open, End live asks instead whether to close it or keep it open for late cards (D20).
      if (intent.action === 'end') {
        const boards = await ipcRenderer.invoke('live:open-boards').catch(() => []) as OpenBoard[]
        let keepBoardsOpen = false
        if (Array.isArray(boards) && boards.length) {
          const choice = await askEndLiveWithBoards(document, boards)
          if (!choice) return
          keepBoardsOpen = choice === 'keep'
        } else if (intent.confirm && !window.confirm(intent.confirm)) return
        const result = await ipcRenderer.invoke('live:end', { keepBoardsOpen }) as LiveGoResult
        if (!result.success) showError(result.error || 'Could not end the live session')
        else updateStatus(result.status ?? 'ended')
        return
      }
      if (intent.confirm && !window.confirm(intent.confirm)) return
      const result = await ipcRenderer.invoke('live:go') as LiveGoResult
      if (!result.success || !result.shortUrl) {
        showError(result.error || 'Could not start the live session')
        return
      }
      qr.innerHTML = result.qrSvg || ''
      url.textContent = linkLabel(result.shortUrl)
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
  endLive?.addEventListener('click', () => { if (!sessionCanStart(status)) void toggleLive() })
  goLive?.addEventListener('click', () => { if (sessionCanStart(status)) void toggleLive() })
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
  // G is bound and the live bridge is exposed: the presenter's ? sheet and palette list the live
  // keys (G, Q, ⇧Q, K) only while this mark is there (PRESENTER_KEY_NEEDS; presenter redesign
  // ticket 08).
  document.documentElement.setAttribute(LIVE_BRIDGE_ATTRIBUTE, '')
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
    if (state.slideId !== audienceSlideId) { audienceSlideId = state.slideId; showAudienceCounts() }
    ipcRenderer.send('live:publish-slide', state)
  }
  let pointerLast = ''
  const reportPointer = (): void => {
    const raw = document.documentElement.dataset.twLivePointer || ''
    // Attribute ticks are page events: movement is throttled there, resting keep-alives are 1 Hz.
    pointerLast = raw
    try {
      const message = parsePointerMessage({ type: 'pointer.live', pointer: JSON.parse(raw) })
      if (message) ipcRenderer.send('live:pointer', message)
    } catch { /* malformed page data is inert */ }
  }
  const pointerObserver = new MutationObserver(reportPointer)
  pointerObserver.observe(document.documentElement, {
    attributes: true, attributeFilter: ['data-tw-live-pointer', 'data-tw-live-pointer-tick'],
  })
  const clearPointer = (): void => {
    if (pointerLast && pointerLast !== '"gone"') ipcRenderer.send('live:pointer', { type: 'pointer.live', pointer: 'gone' })
    pointerObserver.disconnect()
  }
  window.addEventListener('pagehide', clearPointer, { once: true })
  window.addEventListener('beforeunload', clearPointer, { once: true })
  // The Pen's ink (ticket 08): the deck writes its current layer on the root; the deck limits it to
  // 15 writes a second and adds a keep-alive tick. Checked here, in main and in the worker.
  let inkLast: InkMessage | null = null
  const reportInk = (): void => {
    try {
      // Length first, then the capped check: an oversized slot is refused before it is parsed.
      const message = readInkSlot(document.documentElement.dataset.twLiveInk)
      if (!message) return
      inkLast = message
      ipcRenderer.send('live:ink', message)
    } catch { /* malformed page data is inert */ }
  }
  const inkObserver = new MutationObserver(reportInk)
  inkObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-tw-live-ink', 'data-tw-live-ink-tick'] })
  // Closing the presenter ends the talk's drawings: the venue screen is told the layer is empty.
  const clearInk = (): void => {
    if (inkLast && (inkLast.ink.strokes.length || inkLast.ink.draft)) {
      ipcRenderer.send('live:ink', { type: 'ink.live', ink: { ...inkLast.ink, strokes: [], draft: null } })
    }
    inkLast = null
    inkObserver.disconnect()
  }
  window.addEventListener('pagehide', clearInk, { once: true })
  window.addEventListener('beforeunload', clearInk, { once: true })
  const poll = window.setInterval(report, 150)
  window.addEventListener('hashchange', report)
  window.addEventListener('beforeunload', () => window.clearInterval(poll), { once: true })
  report()
}
