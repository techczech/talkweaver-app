// Background thumbnail prewarm (docs/design/2026-07-19-thumbnail-prewarm/SPEC.md, built 2026-10-20).
//
// Renders the slide pictures the Slide Browser will ask for, for every talk in every open vault,
// before anyone opens the Browser — so a first opening shows pictures instead of waiting 5-15 s a card.
//
// WHY IT IS SHAPED LIKE THIS. Three earlier whole-vault passes took the main process down:
//   - 2026-07-20 (9e614d4a): the startup sweep rendered every changed talk with the compiler's FULL
//     media (every video base64-inlined) in the main process, back to back, while an OCR pass ran
//     beside it; ~1,400 imported slides at once beachballed and natively killed the app.
//   - 2026-07-20 (cf97a28a): whole-vault compiles loading gigabytes of media Buffers off-heap, which
//     no heap flag bounds.
//   - 2026-09-15 (5a23b0f7): the Browser's own sweep prepared deck after deck with video inlined (a
//     194 MB HTML string for one talk), kept the last one retained, and let a second deck be prepared
//     beside it — main heap 3.8-3.9 GB against a 4 GB ceiling.
// The cause each time was the same: whole decks prepared with their media in the main process, more
// than one alive at a time, with nothing that waited when memory was high. So this pass:
//   - holds ONE prepared talk at a time and lets go of it before the next (the deps prepare uncached
//     and video-free; `release` drops the last reference);
//   - lets go of it, and waits, whenever the main heap, the main process, the whole app or the machine
//     is under pressure, and while a talk is being presented, recorded or live;
//   - renders through the one render queue at the lowest priority: it starts only when no other render
//     is waiting, and any other render interrupts it between two slides;
//   - waits for a quiet spell after the last render someone asked for, so it never competes with the
//     editor strip or the Browser;
//   - renders a talk in short runs of slides, pausing between slides, and closes the hidden render
//     window (its renderer process and every deck it held) every so many slides or when it grows large.
// Nothing is recorded beyond the pictures: a talk whose pictures are all on disk is skipped by file
// name, without compiling it, so a restart picks up where the last session stopped.
//
// Everything outside this file is injected (talk list, picture check, prepare, render, memory, clock),
// so the rules above are tested without Electron (scripts/test-thumbnail-prewarm.mjs).

/** One talk as the prewarm sees it, built without compiling anything. */
export interface PrewarmTalk {
  outlinePath: string
  slug: string
  /** When the outline last changed (ms). Newer first. */
  editedMs: number
  /** Open in an editor window now: ahead of everything else. */
  open: boolean
  /** The picture keys the Slide Browser will ask for (its rows' render_hash). */
  keys: string[]
}

/** One slide of a prepared deck, as the renderer wants it. */
export interface PrewarmSlide {
  key: string
  cacheKey: string
  index: number
  layout?: string
}

/** A compiled talk held for rendering. `release` drops it; nothing else may keep it. */
export interface PrewarmDeck {
  slides: PrewarmSlide[]
  release(): void
}

export interface PrewarmMemory {
  /** The main process's V8 heap in use. */
  mainHeapBytes: number
  /** The main process's resident memory (heap, Buffers and the compile's worker thread). */
  mainRssBytes: number
  /** The hidden render window's renderer process, or null when there is none. */
  rendererBytes: number | null
  /** Every process of the app together. */
  appBytes: number
  /** One-minute load average per CPU core. */
  loadPerCpu: number
}

export interface PrewarmLimits {
  /** Wait after start before the first look (ms). */
  startDelayMs: number
  /** Quiet spell after the last render someone asked for (ms). */
  quietMs: number
  /** How often a waiting prewarm looks again (ms). */
  pollMs: number
  /** Pause between two slides (ms). */
  slidePaceMs: number
  /** Pause between two talks (ms). */
  talkGapMs: number
  /** Slides per render request. */
  chunkSlides: number
  /** Close the render window after this many slides rendered in it. */
  recycleEverySlides: number
  /** ... or when its renderer grows past this. */
  recycleRendererBytes: number
  /** Pause when the main heap reaches this. */
  mainHeapPauseBytes: number
  /** Pause when the main process's resident memory reaches this. */
  mainRssPauseBytes: number
  /** Pause when the whole app reaches this. */
  appPauseBytes: number
  /** Pause when the machine's load per core reaches this. */
  loadPerCpuPause: number
  /** With a talk held: how much more than just after preparing it before the prewarm lets go. */
  holdGrowthBytes: number
  /** Hard ceiling, always: the main heap at which the held talk is let go at once, whatever it weighed. */
  hardHeapBytes: number
  /** Hard ceiling, always: the main process's resident memory. */
  hardRssBytes: number
  /** Hard ceiling, always: the whole app. */
  hardAppBytes: number
  /** A talk prepared this many times in one session without finishing is left until the next one. */
  maxPreparesPerTalk: number
  /** After a full pass, look at the vault again after this long (ms), or sooner on `nudge`. */
  rescanMs: number
}

export const DEFAULT_PREWARM_LIMITS: PrewarmLimits = {
  startDelayMs: 15_000,
  quietMs: 5_000,
  pollMs: 10_000,
  slidePaceMs: 120,
  talkGapMs: 1_500,
  chunkSlides: 20,
  recycleEverySlides: 200,
  recycleRendererBytes: 1536 * 1024 * 1024,
  // Below the browser lane's own 2048 MB guard (thumbnail-media-policy.ts): the prewarm backs off first.
  mainHeapPauseBytes: 1536 * 1024 * 1024,
  mainRssPauseBytes: 3072 * 1024 * 1024,
  appPauseBytes: 8192 * 1024 * 1024,
  // macOS load averages run high on a busy Mac (every runnable thread counts); 1.5 per core is a
  // machine already saturated, where one more renderer would be felt.
  loadPerCpuPause: 1.5,
  // Preparing a talk of large photographs costs the main process gigabytes until the next collection
  // (measured 2026-10-20: ~3 GB resident, ~0.6 GB heap, for 100 slides with 40 MB of photographs).
  // That weight is the talk's own and does not grow while it is rendered, so a held talk may sit above
  // the pause levels; growth beyond the reading taken just after preparing it is an extra, early trigger.
  // The hard ceilings sit above the 1,500-slide diagnostic's peaks (heap 637 MB, resident 3.8 GB, app
  // 4.4 GB) and apply always, held talk or not: heap = the browser lane's own guard; resident 4 GiB
  // leaves a little over the diagnostic's peak (a bigger talk than that is skipped, not hosted); app
  // 10 GiB (index.ts lowers it to 60% of the machine's memory on a small Mac).
  holdGrowthBytes: 1024 * 1024 * 1024,
  hardHeapBytes: 2048 * 1024 * 1024,
  hardRssBytes: 4096 * 1024 * 1024,
  hardAppBytes: 10240 * 1024 * 1024,
  maxPreparesPerTalk: 3,
  rescanMs: 10 * 60_000
}

export interface PrewarmDeps {
  /** Every talk of every open vault whose picture keys are known (no compile). */
  listTalks(): PrewarmTalk[]
  /** The keys among these whose picture is not on disk (one look at the talk's folder). */
  missing(talk: PrewarmTalk, keys: string[]): string[]
  /** Compile the talk for pictures (uncached, video-free). null = it cannot be compiled. */
  prepare(talk: PrewarmTalk): Promise<PrewarmDeck | null>
  /** Render these slides of the deck at the lowest priority. `interrupted`: another render cut in, or
   *  `shouldYield` said stop. The renderer must call `shouldYield` between every two slides (and before
   *  writing a picture), and stop at once, writing nothing further, when it returns true. */
  render(talk: PrewarmTalk, deck: PrewarmDeck, slides: PrewarmSlide[], paceMs: number, shouldYield: () => boolean): Promise<{ interrupted: boolean }>
  /** Close the hidden render window if nothing is using it. */
  recycleRenderer(): boolean
  /** Stop a render of ours in flight (quit). */
  cancelRender(): void
  memory(): PrewarmMemory
  /** The talk's vault is still open and its outline still exists. */
  talkAlive(talk: PrewarmTalk): boolean
  /** A talk is being presented, recorded or is live: the prewarm does nothing. */
  presenting(): boolean
  /** A render or compile somebody is waiting for is running or queued. */
  foregroundBusy(): boolean
  /** When a render somebody wanted was last asked for (same clock as `now`), 0 if never. */
  lastForegroundAt(): number
  now(): number
  /** Resolves after ms, or at once when the signal aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>
  log(message: string): void
  limits?: Partial<PrewarmLimits>
}

export type PrewarmState = 'not-started' | 'starting' | 'checking' | 'rendering' | 'waiting' | 'idle' | 'stopped'

export interface PrewarmStatus {
  state: PrewarmState
  /** Why it is waiting: presenting | foreground | memory:<which> | load. */
  reason: string | null
  currentTalk: string | null
  talksChecked: number
  talksWarmed: number
  slidesRendered: number
  recycles: number
  passes: number
  /** Highest readings seen while the prewarm was working. */
  peak: { mainHeapBytes: number; mainRssBytes: number; rendererBytes: number; appBytes: number }
}

export interface ThumbnailPrewarm {
  /** Begin after `startDelayMs` (or the given delay). Calling it again does nothing. */
  start(delayMs?: number): void
  /** Look at the vault again as soon as the current talk is done (a vault was opened, talks changed). */
  nudge(): void
  /** Called synchronously by the preparation gate when any other preparation is requested, before it
   *  compiles: the held talk is released at once and our render cancelled; a talk still being prepared
   *  is released as soon as it arrives. Does nothing when the prewarm holds nothing. */
  releaseNow(): void
  /** Stop now: a render of ours is cancelled, the held talk is released. Resolves when the loop has ended. */
  stop(): Promise<void>
  status(): PrewarmStatus
}

/** The order talks are warmed in: open in an editor first, then most recently edited. */
export function prewarmOrder(talks: PrewarmTalk[]): PrewarmTalk[] {
  return talks.slice().sort((a, b) => (Number(b.open) - Number(a.open)) || (b.editedMs - a.editedMs))
}

/** The hard ceilings, which apply always: a reason, or null. */
export function hardCeiling(memory: PrewarmMemory, limits: PrewarmLimits): string | null {
  if (memory.mainHeapBytes >= limits.hardHeapBytes) return 'memory:main-heap'
  if (memory.mainRssBytes >= limits.hardRssBytes) return 'memory:main-process'
  if (memory.appBytes >= limits.hardAppBytes) return 'memory:app'
  return null
}

/** Which pressure, if any, says "wait". Pure: readings and limits in, a reason or null out.
 *  The hard ceilings always apply. Without a held talk the pause levels apply. With one (`held`: the
 *  reading just after it was prepared) its own weight is allowed for, so the pause levels give way to
 *  the hard ceilings, and growth beyond that reading is an additional early trigger. */
export function memoryPressure(memory: PrewarmMemory, limits: PrewarmLimits, held?: PrewarmMemory): string | null {
  const hard = hardCeiling(memory, limits)
  if (hard) return hard
  const over = (now: number, pause: number, base: number | undefined): boolean =>
    base === undefined ? now >= pause : now >= base + limits.holdGrowthBytes
  if (over(memory.mainHeapBytes, limits.mainHeapPauseBytes, held?.mainHeapBytes)) return 'memory:main-heap'
  if (over(memory.mainRssBytes, limits.mainRssPauseBytes, held?.mainRssBytes)) return 'memory:main-process'
  if (over(memory.appBytes, limits.appPauseBytes, held?.appBytes)) return 'memory:app'
  if (memory.loadPerCpu >= limits.loadPerCpuPause) return 'load'
  return null
}

export function createThumbnailPrewarm(deps: PrewarmDeps): ThumbnailPrewarm {
  const limits: PrewarmLimits = { ...DEFAULT_PREWARM_LIMITS, ...(deps.limits ?? {}) }
  const stopper = new AbortController()
  let nudgeWake = new AbortController()
  let nudged = false
  let loop: Promise<void> | null = null
  let slidesInWindow = 0
  // outlinePath -> { editedMs, prepares, left }: a talk tried and left this session is not tried again
  // until it changes (a slide whose picture never settles would otherwise be compiled forever).
  const tries = new Map<string, { editedMs: number; prepares: number; deferrals: number; left: boolean }>()
  const status: PrewarmStatus = {
    state: 'not-started', reason: null, currentTalk: null,
    talksChecked: 0, talksWarmed: 0, slidesRendered: 0, recycles: 0, passes: 0,
    peak: { mainHeapBytes: 0, mainRssBytes: 0, rendererBytes: 0, appBytes: 0 }
  }
  const stopped = (): boolean => stopper.signal.aborted
  // The one talk held now (if any), whether releaseNow() has dropped it, and whether another
  // preparation was requested while ours was compiling.
  let heldDeck: PrewarmDeck | null = null
  let forced = false
  let preparing = false
  let wantedWhilePreparing = false

  function read(): PrewarmMemory {
    const m = deps.memory()
    const p = status.peak
    p.mainHeapBytes = Math.max(p.mainHeapBytes, m.mainHeapBytes)
    p.mainRssBytes = Math.max(p.mainRssBytes, m.mainRssBytes)
    p.rendererBytes = Math.max(p.rendererBytes, m.rendererBytes ?? 0)
    p.appBytes = Math.max(p.appBytes, m.appBytes)
    return m
  }

  /** Why the prewarm must not work right now, or null. Memory is read in every case, so a hard ceiling
   *  is seen whatever else is going on. */
  function obstacle(held?: PrewarmMemory): string | null {
    const memory = memoryPressure(read(), limits, held)
    if (deps.presenting()) return 'presenting'
    if (memory?.startsWith('memory:')) return memory
    if (deps.foregroundBusy()) return 'foreground'
    const last = deps.lastForegroundAt()
    if (last > 0 && deps.now() - last < limits.quietMs) return 'foreground'
    return memory
  }

  /** Wait until nothing stands in the way. With a deck held (`held`: the reading just after it was
   *  prepared) it never waits: any reason at all (someone else's render included) is returned at once so
   *  the caller lets go of the deck first and waits without it. */
  async function clear(held?: PrewarmMemory): Promise<string | null> {
    const holding = held !== undefined
    let logged: string | null = null
    for (;;) {
      if (stopped()) return 'stopped'
      const why = obstacle(held)
      if (!why) {
        if (logged) deps.log(`prewarm: going on (was waiting: ${logged})`)
        status.reason = null
        return null
      }
      if (holding) return why
      if (why !== logged && why !== 'foreground') {
        deps.log(`prewarm: waiting — ${why}`)
        // A render window held while presenting or under pressure is closed rather than kept (once
        // per wait: the editor may open a fresh one meanwhile, and that one is its own).
        if (deps.recycleRenderer()) slidesInWindow = 0
      }
      logged = why
      status.state = 'waiting'
      status.reason = why
      await deps.sleep(why === 'foreground' ? Math.min(limits.pollMs, limits.quietMs) : limits.pollMs, stopper.signal)
    }
  }

  /** Whether the talk's own preparation accounts for a hard-ceiling breach. The main process's heap and
   *  resident memory are this process's own (the talk is what filled them), so a breach there is the
   *  talk's. App-wide memory is shared with every window and tool: that breach is the talk's only when the
   *  main process grew by at least half of what the whole app grew across the preparation. */
  function attributable(before: PrewarmMemory, after: PrewarmMemory): boolean {
    if (after.mainHeapBytes >= limits.hardHeapBytes || after.mainRssBytes >= limits.hardRssBytes) return true
    const appGrowth = after.appBytes - before.appBytes
    return appGrowth > 0 && (after.mainRssBytes - before.mainRssBytes) * 2 >= appGrowth
  }

  function maybeRecycle(memory: PrewarmMemory): void {
    const big = memory.rendererBytes != null && memory.rendererBytes >= limits.recycleRendererBytes
    if (slidesInWindow < limits.recycleEverySlides && !big) return
    if (deps.recycleRenderer()) {
      status.recycles += 1
      deps.log(`prewarm: render window closed after ${slidesInWindow} slides` +
        (memory.rendererBytes != null ? ` (renderer at ${Math.round(memory.rendererBytes / 1048576)} MB)` : ''))
      slidesInWindow = 0
    }
  }

  const missing = (talk: PrewarmTalk, keys: string[]): string[] => deps.missing(talk, keys)
  const unrendered = (talk: PrewarmTalk, slides: PrewarmSlide[]): PrewarmSlide[] => {
    const gone = new Set(missing(talk, slides.map((slide) => slide.key)))
    return slides.filter((slide) => gone.has(slide.key))
  }

  /** Warm one talk. Returns when every picture is there, or it has been left for this session. */
  async function warmTalk(talk: PrewarmTalk): Promise<void> {
    const tried = tries.get(talk.outlinePath)
    const record = tried && tried.editedMs === talk.editedMs ? tried : { editedMs: talk.editedMs, prepares: 0, deferrals: 0, left: false }
    tries.set(talk.outlinePath, record)
    if (record.left) return
    while (!stopped()) {
      if (!deps.talkAlive(talk)) return // its vault was closed or the outline is gone
      // The cheap check: file names only, no compile.
      if (missing(talk, talk.keys).length === 0) return
      if (record.prepares >= limits.maxPreparesPerTalk) {
        deps.log(`prewarm: ${talk.slug} left for this session after ${record.prepares} tries`)
        record.left = true
        return
      }
      if (await clear()) return
      status.state = 'rendering'
      status.currentTalk = talk.slug
      record.prepares += 1
      let deck: PrewarmDeck | null = null
      const beforePrepare = read()
      forced = false
      wantedWhilePreparing = false
      preparing = true
      try {
        deck = await deps.prepare(talk)
      } catch (error) {
        deps.log(`prewarm: ${talk.slug} could not be compiled (${error instanceof Error ? error.message : String(error)})`)
      } finally {
        preparing = false
      }
      if (!deck) { record.left = true; return }
      if (wantedWhilePreparing) {
        // Another preparation was requested while this one compiled: drop the result unused.
        deck.release()
        status.currentTalk = null
        record.prepares -= 1
        deps.log(`prewarm: let go of ${talk.slug} — foreground`)
        continue
      }
      heldDeck = deck
      const held = read()
      // A hard ceiling reached just after preparing. App memory is shared, so the talk is left for the
      // session only when its own preparation can account for the breach (it grew by more than the
      // room between the pause level and the ceiling); otherwise this is pressure from elsewhere and the
      // talk is let go and tried again once it clears, without using up a try.
      const breach = hardCeiling(held, limits)
      if (breach) {
        deck.release()
        heldDeck = null
        status.currentTalk = null
        const own = attributable(beforePrepare, held)
        if (own) {
          deps.log(`prewarm: ${talk.slug} left for this session — preparing it alone reached the ${breach} ceiling`)
          record.left = true
          return
        }
        deps.log(`prewarm: let go of ${talk.slug} — ${breach} (not the talk's own)`)
        // Pressure from elsewhere does not use up a try, but a talk is not deferred for it for ever.
        record.deferrals += 1
        if (record.deferrals > limits.maxPreparesPerTalk) {
          deps.log(`prewarm: ${talk.slug} left for this session after ${record.deferrals} deferrals`)
          record.left = true
          return
        }
        record.prepares -= 1
        continue
      }
      let letGo: string | null = null
      // Asked between every two slides by the renderer: stop when anything that would have made us let go
      // of the talk has come up, or its vault was closed.
      const shouldYield = (): boolean =>
        forced || stopped() || !deps.talkAlive(talk) || obstacle(held) !== null
      try {
        let todo = unrendered(talk, deck.slides)
        while (todo.length > 0 && !stopped()) {
          if (forced) { letGo = 'foreground'; break }
          if (!deps.talkAlive(talk)) { letGo = 'closed'; break }
          letGo = await clear(held)
          if (letGo) break
          maybeRecycle(read())
          const chunk = todo.slice(0, limits.chunkSlides)
          status.state = 'rendering'
          const { interrupted } = await deps.render(talk, deck, chunk, limits.slidePaceMs, shouldYield)
          if (forced) { letGo = 'foreground'; break } // released under the render by releaseNow()
          const before = todo.length
          todo = unrendered(talk, todo)
          const made = before - todo.length
          slidesInWindow += made
          status.slidesRendered += made
          // A run that was not cut short and made nothing: those slides do not settle (a picture that
          // never loads). Leave them; the Browser and the editor still try them on demand.
          if (!interrupted && made === 0) {
            deps.log(`prewarm: ${talk.slug}: ${todo.length} slide(s) would not render; left for this session`)
            record.left = true
            break
          }
        }
        if (todo.length === 0) {
          status.talksWarmed += 1
          deps.log(`prewarm: ${talk.slug} warmed (${deck.slides.length} slides)`)
        }
      } finally {
        deck.release()
        deck = null
        heldDeck = null
        status.currentTalk = null
      }
      if (record.left || stopped() || !letGo) return
      deps.log(`prewarm: let go of ${talk.slug} — ${letGo}`)
      if (letGo === 'closed') return // the vault was closed or the talk removed: nothing more for it
      // Presenting and other people's renders are not the talk's fault; pressure may be (a deck too big
      // to hold), so it counts.
      if (letGo === 'presenting' || letGo === 'foreground') record.prepares -= 1
    }
  }

  async function run(firstDelayMs: number): Promise<void> {
    status.state = 'starting'
    await deps.sleep(firstDelayMs, stopper.signal)
    while (!stopped()) {
      nudged = false
      status.passes += 1
      status.state = 'checking'
      let talks: PrewarmTalk[] = []
      try { talks = prewarmOrder(deps.listTalks()) } catch (error) {
        deps.log(`prewarm: could not list talks (${error instanceof Error ? error.message : String(error)})`)
      }
      let warmedAny = false
      for (const talk of talks) {
        if (stopped()) break
        status.talksChecked += 1
        const before = status.slidesRendered
        try {
          await warmTalk(talk)
        } catch (error) {
          // One bad talk never stops the pass.
          deps.log(`prewarm: ${talk.slug} failed (${error instanceof Error ? error.message : String(error)})`)
          tries.set(talk.outlinePath, { editedMs: talk.editedMs, prepares: limits.maxPreparesPerTalk, deferrals: 0, left: true })
        }
        if (status.slidesRendered > before) {
          warmedAny = true
          await deps.sleep(limits.talkGapMs, stopper.signal)
        }
        if (nudged) break // a newer list (a vault opened, an edit) comes first
        await deps.sleep(0, stopper.signal) // one turn of the event loop between two talks' checks
      }
      if (stopped()) break
      if (nudged) continue
      if (warmedAny) continue // talks may have changed while this pass ran: one more cheap look
      // Nothing left to do: let the render window go and wait for a nudge or the next look.
      if (deps.recycleRenderer()) slidesInWindow = 0
      status.state = 'idle'
      status.reason = null
      nudgeWake = new AbortController()
      const wake = nudgeWake
      const both = new AbortController()
      const forward = (): void => both.abort()
      stopper.signal.addEventListener('abort', forward, { once: true })
      wake.signal.addEventListener('abort', forward, { once: true })
      await deps.sleep(limits.rescanMs, both.signal)
      stopper.signal.removeEventListener('abort', forward)
    }
    status.state = 'stopped'
  }

  return {
    start(delayMs?: number): void {
      if (loop || stopped()) return
      loop = run(delayMs ?? limits.startDelayMs).catch((error) => {
        deps.log(`prewarm: stopped by an error (${error instanceof Error ? error.message : String(error)})`)
        status.state = 'stopped'
      })
    },
    nudge(): void {
      nudged = true
      nudgeWake.abort()
    },
    releaseNow(): void {
      // For foreground and non-prewarm background preparations alike, a render already in flight may
      // keep its options and HTML until its current slide step settles: one step, one video-free deck.
      // After other background compiles settle, a share build retains its payload through upload;
      // variant/conflict jobs retain their video-free decks through picture rendering. These are
      // bounded jobs, not a vault sweep; share payloads can still contain inline video. Variant
      // (background) and conflict (normal) renders count as foreground in the render queue (everything
      // except idle), so the prewarm waits while they are running or queued.
      if (heldDeck) {
        forced = true
        const deck = heldDeck
        heldDeck = null
        try { deck.release() } catch { /* already released */ }
        try { deps.cancelRender() } catch { /* nothing in flight */ }
      } else if (preparing) {
        wantedWhilePreparing = true
      }
    },
    async stop(): Promise<void> {
      if (!stopper.signal.aborted) {
        stopper.abort()
        try { deps.cancelRender() } catch { /* quitting */ }
      }
      status.state = 'stopped'
      await loop
    },
    status: () => ({ ...status, peak: { ...status.peak } })
  }
}
