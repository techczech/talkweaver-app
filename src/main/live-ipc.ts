import type { IpcMain } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  INK_LIMITS, isPresenterBoardMessage, parseInkMessage, parsePointerMessage, parsePresenterMessage, parseSlideLightbox,
  type PollDefinition,
} from '../../worker/protocol.ts'
import { supportsCurrentLiveWorker } from '../../worker/recovery-protocol.ts'
import { fitInstantImage } from './instant-image.ts'
import type { AdminEndpoint } from './live-admin-request.ts'
import { isTerminalLiveStatus, type LiveStatus } from './live-presenter-client.ts'
import { liveReadClipboardHandler, type ClipboardReadDeps } from './live-read-clipboard.ts'
import { LIVE_ACCESS_REMOVED, LiveServiceError } from './live-service-deploy.ts'
import { sendWithHeldKeys, type LiveServiceAt, type StoredKey } from './live-service-key.ts'
import type { createLiveSessionManager, LivePresenterContext } from './live-session-manager.ts'
import type { createLiveSessionStore, SessionRecoveryRecord } from './live-session-store.ts'
import { answerPreworkTrayForLiveSession, isPreworkQuestionId, preworkTrayForLiveSession } from './prework-tray.ts'
import { withoutSeed } from './run-prework-seed.ts'
import type { PresenterShareLinkUpdate } from '../preload/index'

type LiveIpcHost = Pick<ClipboardReadDeps, 'isFocused' | 'pressedRecently' | 'clipboard'> & {
  ipcMain: Pick<IpcMain, 'handle' | 'on'>
  readonly livePresenterContexts: Pick<ReadonlyMap<number, LivePresenterContext>, 'get' | 'has'>
  readonly liveSessions: Pick<ReturnType<typeof createLiveSessionManager>,
    'snapshot' | 'inUse' | 'detach' | 'create' | 'bindRun' | 'openBoards' | 'end' | 'embed' |
    'pointer' | 'ink' | 'publish' | 'record' | 'poll'> | null
  readonly liveRecoveryStore: Pick<ReturnType<typeof createLiveSessionStore>, 'check'> | null
  attachLiveWindow(wcId: number): SessionRecoveryRecord | null
  verifiedRunSource(outlinePath: string, talkSlug: string): Promise<string | undefined>
  ensureLiveWorker(): Promise<AdminEndpoint>
  ensureLiveJoinUrl(context: LivePresenterContext): Promise<string>
  getCompilerPath(): string | null
  recordedLiveService(): LiveServiceAt
  liveKeysHeldFor(baseUrl: string): StoredKey[]
  liveHttpError(response: Response, fallback: string): Promise<string>
  recordingRunReference(wcId: number): { talkSlug: string; runId: string } | null
  liveVaultReadable(root: string): boolean
  writableLiveRoot(root: string): string | null
  presenterShareLink(url: string | null): Promise<PresenterShareLinkUpdate>
  seedFromRunPrework(wcId: number, poll: PollDefinition): Promise<PollDefinition>
  instantLinkQrSvg(url: string): Promise<string>
}

/** Registers the live-presenter channels on the app's main-frame-guarded IPC object. */
export function registerLiveIpc(host: LiveIpcHost): void {
  const { ipcMain, recordedLiveService, liveKeysHeldFor } = host

  ipcMain.handle('live:go', async (event) => {
    const wcId = event.sender.id
    const context = host.livePresenterContexts.get(wcId)
    if (!context) return { success: false, error: 'Live sessions are available in the presenter window only.' }
    try {
      if (!host.liveSessions || !host.liveRecoveryStore) throw new Error('Secure live session recovery is unavailable. Restart TalkWeaver to retry.')
      if(context.sourceOutline && context.vaultRoot) {
        const outline=join(context.vaultRoot,context.sourceOutline)
        if(await host.verifiedRunSource(outline,context.talkSlug)!==context.sourceOutline)throw Error('run-source-unavailable')
      }
      host.liveRecoveryStore.check()
      const existing = host.attachLiveWindow(wcId)
      if (existing && !isTerminalLiveStatus(existing.status)) return { success: true, ...host.liveSessions.snapshot(wcId) }
      if (host.liveSessions.inUse(context.talkSlug, context.vaultRoot, wcId)) throw new Error('This talk is already live in another presenter window. Close that presentation and keep it live before reopening it here.')
      if (!context.shortUrl) throw new Error('Publish or export this handout before going live.')
      const endpoint = await host.ensureLiveWorker()
      const capabilityResponse = await fetch(`${endpoint.baseUrl}/capabilities`, { signal: AbortSignal.timeout(10_000) })
      const capabilities = capabilityResponse.ok ? await capabilityResponse.json() as { protocol?: number; build?: string } : null
      if (!supportsCurrentLiveWorker(capabilities)) throw new Error('The live service needs updating before you can go live.')
      const joinUrl = await host.ensureLiveJoinUrl(context)
      const compilerDir = host.getCompilerPath()
      if (!compilerDir) throw new Error('Compiler not found.')
      const { makeQrSvg } = await import(pathToFileURL(join(compilerDir, 'lib/01-cli-utils.mjs')).href)
      const qrSvg = String(makeQrSvg(joinUrl) || '')
      // With two keys held for this live service (this computer's own and the 0.38.2 one), a 401 for the
      // one presented is followed by one more try with the other (live-service-key.ts `sendWithHeldKeys`).
      const { response, refused } = await sendWithHeldKeys(recordedLiveService(), liveKeysHeldFor(endpoint.baseUrl), endpoint.adminSecret, (secret) => fetch(`${endpoint.baseUrl}/sessions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ talkSlug: context.talkSlug }),
        signal: AbortSignal.timeout(15_000),
      }))
      // The live service refuses every key this computer holds for it (its access was removed from another
      // computer): the same fixed sentence as the Settings row's, with Open Settings, never the reply's own text.
      if (refused) throw new LiveServiceError('failed', LIVE_ACCESS_REMOVED, null, 'open-settings')
      if (!response.ok) throw new Error(await host.liveHttpError(response, 'Could not create a live session.'))
      const created = await response.json() as { sessionId: string; presenterToken: string; shortId: string; expiresAt: number }
      if (!created.sessionId || !created.presenterToken || !created.shortId || !Number.isFinite(created.expiresAt)) throw new Error('The live service returned an incomplete session.')
      const record: SessionRecoveryRecord = {
        ...created, baseUrl: endpoint.baseUrl, shortUrl: joinUrl, qrSvg,
        talkSlug: context.talkSlug, vaultRoot: context.vaultRoot,
        status: 'connecting', startedAtMs: Date.now(), endRequested: false,
        latest: null, pending: [], polls: [], voteRecords: [], cursor: 0,
      }
      host.liveSessions.detach(wcId)
      host.liveSessions.create(record, wcId)
      host.liveSessions.bindRun(wcId, host.recordingRunReference(wcId))
      return { success: true, ...host.liveSessions.snapshot(wcId) }
    } catch (cause) {
      // A live service that is not set up or failed its set-up: the sorted sentence; what the tool printed only as `details`;
      // and what Go live offers for it (Open Settings, or Set up going live now). Presenting goes on either way.
      if (cause instanceof LiveServiceError) return { success: false, error: cause.message, ...(cause.details ? { details: cause.details } : {}), ...(cause.prompt ? { setup: cause.prompt } : {}) }
      return { success: false, error: cause instanceof Error ? cause.message : String(cause) }
    }
  })

  // Feedback-boards ticket 06 (D20): the boards still open in this window's session, so End live can
  // ask whether to close them or keep them open for late cards.
  ipcMain.handle('live:open-boards', (event) => {
    host.attachLiveWindow(event.sender.id)
    return host.liveSessions?.openBoards(event.sender.id) ?? []
  })
  ipcMain.handle('live:end', async (event, options: unknown) => {
    try {
      host.attachLiveWindow(event.sender.id)
      const keepBoardsOpen = !!options && typeof options === 'object' && (options as { keepBoardsOpen?: unknown }).keepBoardsOpen === true
      return await host.liveSessions?.end(event.sender.id, { keepBoardsOpen }) ?? { success: true, status: 'ended' }
    } catch (cause) {
      return { success: false, error: cause instanceof Error ? cause.message : String(cause) }
    }
  })
  ipcMain.handle('live:snapshot', (event) => {
    const record = host.attachLiveWindow(event.sender.id)
    const snapshot = host.liveSessions?.snapshot(event.sender.id) ?? null
    // The Run's pre-work questions put in the talk's questions ride beside the phones' (never sent to the Worker).
    // Read from the session's own vault (record.vaultRoot) only while it is open and there; never the current vault.
    return snapshot ? { ...snapshot, preworkQuestions: preworkTrayForLiveSession(record, host.liveVaultReadable) } : null
  })
  ipcMain.handle('live:status', (event): LiveStatus => host.attachLiveWindow(event.sender.id)?.status ?? 'ended')
  ipcMain.handle('live:share-link', (event) => host.presenterShareLink(host.livePresenterContexts.get(event.sender.id)?.shortUrl ?? null))
  ipcMain.on('live:embed', (event, value: unknown) => {
    host.liveSessions?.embed(event.sender.id, value)
  })
  ipcMain.on('live:pointer', (event, value: unknown) => {
    const message = parsePointerMessage(value)
    if (message) host.liveSessions?.pointer(event.sender.id, message)
  })
  // The Pen's ink (ticket 08): relayed to the worker, held nowhere in main.
  ipcMain.on('live:ink', (event, value: unknown) => {
    const message = parseInkMessage(value)
    if (message && new TextEncoder().encode(JSON.stringify(message)).length <= INK_LIMITS.bytes) host.liveSessions?.ink(event.sender.id, message)
  })
  ipcMain.on('live:publish-slide', (event, state: { slideId?: string; reveal?: number; focus?: unknown; lightbox?: unknown; talkQr?: unknown }) => {
    if (!state || typeof state.slideId !== 'string' || !Number.isInteger(state.reveal) || Number(state.reveal) < 0) return
    const focus = state.focus == null ? null : state.focus as { kind: 'reveal' | 'focus'; step: number }
    if (focus && ((focus.kind !== 'reveal' && focus.kind !== 'focus') || !Number.isInteger(focus.step) || focus.step < 0)) return
    const lightbox = state.lightbox === undefined ? undefined : parseSlideLightbox(state.lightbox)
    if (state.lightbox !== undefined && !lightbox) return
    if (state.talkQr !== undefined && typeof state.talkQr !== 'boolean') return
    try {
      host.attachLiveWindow(event.sender.id)
      host.liveSessions?.publish(event.sender.id, { slideId: state.slideId, reveal: Number(state.reveal), focus,
        ...(lightbox ? { lightbox } : {}), ...(state.talkQr ? { talkQr: true } : {}) })
    } catch { event.sender.send('live:status', 'paused-reconnecting') }
  })
  type LivePollMessage = NonNullable<ReturnType<typeof parsePresenterMessage>>
  function parseLivePoll(wcId: number, value: unknown): { message: LivePollMessage } | { error: string } {
    host.attachLiveWindow(wcId)
    const message = parsePresenterMessage(JSON.stringify(value))
    // Board operations (message.type 'board.*') reach the worker through the presenter's board panel, not this route.
    if (!message || message.type === 'slide.publish' || message.type === 'question.answer' || message.type === 'switches.set'
      || isPresenterBoardMessage(message)) {
      return { error: 'Invalid poll control.' }
    }
    if (message.type === 'poll.open' && !message.poll.slideId) message.poll.slideId = host.liveSessions?.record(wcId)?.latest?.slideId
    return { message }
  }
  function queueLivePoll(wcId: number, value: unknown) {
    try {
      const parsed = parseLivePoll(wcId, value)
      if ('error' in parsed) return { success: false, error: parsed.error }
      return host.liveSessions?.poll(wcId, parsed.message as never) ?? { success: false, error: 'No live session.' }
    } catch (cause) { return { success: false, error: cause instanceof Error ? cause.message : String(cause) } }
  }
  // Opening a poll: a board slide fed by a pre-work step opens with the Run's answers. A window may not put
  // cards on a board, so any `seed` it sends is dropped first; only main adds one.
  ipcMain.handle('live:poll-open', async (event, poll: unknown) => {
    try {
      const parsed = parseLivePoll(event.sender.id, { type: 'poll.open', poll })
      if ('error' in parsed) return { success: false, error: parsed.error }
      const message = parsed.message
      if (message.type === 'poll.open') message.poll = await host.seedFromRunPrework(event.sender.id, withoutSeed(message.poll))
      return host.liveSessions?.poll(event.sender.id, message as never) ?? { success: false, error: 'No live session.' }
    } catch (cause) { return { success: false, error: cause instanceof Error ? cause.message : String(cause) } }
  })
  ipcMain.handle('live:poll-close', (event, pollId: unknown) => queueLivePoll(event.sender.id, { type: 'poll.close', pollId }))
  ipcMain.handle('live:poll-reveal', (event, pollId: unknown) => queueLivePoll(event.sender.id, { type: 'poll.reveal', pollId }))
  ipcMain.handle('live:poll-hide', (event, pollId: unknown, responseId: unknown, hidden: unknown) => queueLivePoll(event.sender.id, { type: 'poll.hide', pollId, responseId, hidden }))
  // The presenter's board panel (feedback-boards ticket 05): one board operation, checked with the
  // worker's own parser, through the same acknowledged operation queue as the poll controls. Only a
  // presenter window may send one.
  ipcMain.handle('live:board-action', (event, value: unknown) => {
    try {
      host.attachLiveWindow(event.sender.id)
      if (!host.livePresenterContexts.has(event.sender.id)) return { success: false, error: 'The board is sorted in the presenter window only.' }
      const message = parsePresenterMessage(JSON.stringify(value))
      if (!message || !isPresenterBoardMessage(message)) return { success: false, error: 'Invalid board operation.' }
      return host.liveSessions?.poll(event.sender.id, message) ?? { success: false, error: 'No live session.' }
    } catch (cause) { return { success: false, error: cause instanceof Error ? cause.message : String(cause) } }
  })
  ipcMain.handle('live:question-answer', (event, questionId: unknown, answered: unknown) => {
    try {
      host.attachLiveWindow(event.sender.id)
      if (!host.livePresenterContexts.has(event.sender.id)) return { success: false, error: 'Questions are answered in the presenter window only.' }
      // A pre-work question in the tray belongs to the Run: the mark is written there and never reaches the Worker.
      if (isPreworkQuestionId(questionId)) {
        // Written to the session's own vault only (open, there and writable), never the current primary vault.
        const result = answerPreworkTrayForLiveSession(host.liveSessions?.record(event.sender.id) ?? null, host.liveVaultReadable,
          host.writableLiveRoot, questionId, answered !== false)
        if (result.success) event.sender.send('live:prework-questions', result.questions)
        return result.success ? { success: true, status: 'confirmed' as const } : { success: false, status: 'rejected' as const, error: result.error }
      }
      const message = parsePresenterMessage(JSON.stringify({ type: 'question.answer', questionId, answered }))
      if (!message || message.type !== 'question.answer') return { success: false, error: 'Invalid question.' }
      return host.liveSessions?.poll(event.sender.id, message) ?? { success: false, error: 'No live session.' }
    } catch (cause) { return { success: false, error: cause instanceof Error ? cause.message : String(cause) } }
  })
  ipcMain.handle('live:switches', (event, patch: unknown) => {
    try {
      host.attachLiveWindow(event.sender.id)
      if (!host.livePresenterContexts.has(event.sender.id)) return { success: false, error: 'The phone switches belong to the presenter window.' }
      const { questionsAllowed, reactionsAllowed } = (patch && typeof patch === 'object' ? patch : {}) as { questionsAllowed?: unknown; reactionsAllowed?: unknown }
      const message = parsePresenterMessage(JSON.stringify({ type: 'switches.set',
        ...(typeof questionsAllowed === 'boolean' ? { questionsAllowed } : {}), ...(typeof reactionsAllowed === 'boolean' ? { reactionsAllowed } : {}) }))
      if (!message || message.type !== 'switches.set') return { success: false, error: 'Invalid switch.' }
      return host.liveSessions?.poll(event.sender.id, message) ?? { success: false, error: 'No live session.' }
    } catch (cause) { return { success: false, error: cause instanceof Error ? cause.message : String(cause) } }
  })
  ipcMain.handle('live:instant-qr', async (event, url: unknown) => {
    if (!host.livePresenterContexts.has(event.sender.id) || typeof url !== 'string' || !/^https?:\/\/[^\s]+$/i.test(url) || url.length > 2048) return { success: false }
    try { const svg = await host.instantLinkQrSvg(url); return { success: Boolean(svg), svg } } catch { return { success: false } }
  })
  ipcMain.handle('live:instant-action', async (event, action: unknown) => {
    const wcId = event.sender.id
    if (!host.livePresenterContexts.has(wcId)) return { success: false, error: 'Instant slides are available in the presenter window only.' }
    const candidate = action && typeof action === 'object' ? { ...(action as Record<string, unknown>) } : {}
    if (candidate.type === 'instant.show' && candidate.slide && typeof candidate.slide === 'object') {
      const slide = { ...(candidate.slide as Record<string, unknown>) }
      if (slide.kind === 'link' && typeof slide.url === 'string') {
        try {
          const url = new URL(slide.url)
          if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only web links can be shown.')
          const compilerDir = host.getCompilerPath()
          if (!compilerDir) throw new Error('Compiler not found.')
          const { makeQrSvg } = await import(pathToFileURL(join(compilerDir, 'lib/01-cli-utils.mjs')).href)
          slide.qrSvg = String(makeQrSvg(slide.url) || '')
        } catch (error) { return { success: false, error: error instanceof Error ? error.message : 'Invalid link.' } }
      }
      // A text or countdown slide may carry a web link; its QR code is made here, from the link, never taken from the window.
      if ((slide.kind === 'text' || slide.kind === 'countdown') && typeof slide.link === 'string') {
        try {
          if (!['http:', 'https:'].includes(new URL(slide.link).protocol)) throw new Error('Only web links can be shown.')
          const svg = await host.instantLinkQrSvg(slide.link)
          if (svg) slide.linkQrSvg = svg; else delete slide.linkQrSvg
        } catch (error) { return { success: false, error: error instanceof Error ? error.message : 'Invalid link.' } }
      }
      candidate.slide = slide
    }
    const message = parsePresenterMessage(JSON.stringify(candidate))
    if (!message || (message.type !== 'instant.show' && message.type !== 'instant.clear')) return { success: false, error: 'Invalid instant slide.' }
    const result = host.liveSessions?.poll(wcId, message) ?? { success: false, error: 'No live session.' }
    return !result.success && message.type === 'instant.show' ? { ...result, slide: message.slide } : result
  })
  ipcMain.handle('live:fit-instant-image', async (event, bytes: Uint8Array) => {
    if (!host.livePresenterContexts.has(event.sender.id)) return { success: false, error: 'Open the presenter window to show an image.' }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 50_000_000) return { success: false, error: 'This image is too large to process. Try a smaller screenshot.' }
    return fitInstantImage(bytes)
  })
  // The Live menu's "Instant slide from clipboard": the clipboard is read here, never in the preload,
  // and only for a focused presenter window that had a real press in the last five seconds
  // (live-read-clipboard.ts). ⌘V is another path: the page's own paste event.
  ipcMain.handle('live:read-clipboard', liveReadClipboardHandler({
    isPresenter: (wcId) => host.livePresenterContexts.has(wcId),
    isFocused: host.isFocused,
    pressedRecently: host.pressedRecently,
    clipboard: host.clipboard,
  }))
}
