// When a real key or mouse press last reached each window (embed-sandbox design 4.3 and 2.4). Two
// rules in main ask it: the clipboard read (`live:read-clipboard`) and a deck window handing a web
// link to the default browser (`present-window-open.ts`). Both need a press in THAT window in the
// last five seconds.
//
// A press is recorded from three webContents events, all raised in the browser process for input
// that is about to be sent to the page, never by page script:
//   - `input-event` (the event the design names): mouseDown, keyDown, rawKeyDown, touchStart, gestureTap;
//   - `before-mouse-event`: mouseDown;
//   - `before-input-event`: keyDown.
// A page cannot raise any of them: `element.click()`, `dispatchEvent` and a script-made KeyboardEvent
// never leave the renderer. Main's own `webContents.sendInputEvent` and a debugger's Input.dispatch*
// do raise them (the app calls neither; Playwright's clicks in the e2e tests use the second).
//
// What it does not tell apart: a press on the window's own page from a press inside a frame of that
// window that shares the main frame's process (an inlined page). Both are a press in the window.
// Not determined: whether any of the three events is raised for a press inside a frame that runs in
// another process (a remote site). If none is, such a press is not recorded and the rules that ask
// refuse; that is the safe direction.
//
// Times are from a monotonic clock, so changing the system clock cannot make an old press recent.

export const RECENT_PRESS_MS = 5_000

const PRESS_TYPES: Record<string, readonly string[]> = {
  'input-event': ['mouseDown', 'keyDown', 'rawKeyDown', 'touchStart', 'gestureTap'],
  'before-mouse-event': ['mouseDown'],
  'before-input-event': ['keyDown'],
}

export type PressSource = keyof typeof PRESS_TYPES & string

/** Is this input, seen on this event, the start of a key or mouse press (not a release, a move, a wheel)? */
export function isPressInput(source: string, input: unknown): boolean {
  const type = (input as { type?: unknown } | null)?.type
  return typeof type === 'string' && (PRESS_TYPES[source] ?? []).includes(type)
}

type WatchedContents = {
  id: number
  on(event: string, listener: (...args: any[]) => void): unknown
}

export interface PressLedger {
  /** Records presses of this webContents until it is destroyed. */
  watch(contents: WatchedContents): void
  /** A press reached the window `id` now. */
  note(id: number): void
  /** A press reached the window `id` no more than `withinMs` ago. */
  pressedRecently(id: number, withinMs?: number): boolean
  forget(id: number): void
}

export function createPressLedger(opts: { now?: () => number } = {}): PressLedger {
  const now = opts.now ?? (() => performance.now())
  const last = new Map<number, number>()
  const ledger: PressLedger = {
    watch(contents) {
      const id = contents.id
      for (const source of Object.keys(PRESS_TYPES)) {
        contents.on(source, (_event: unknown, input: unknown) => { if (isPressInput(source, input)) ledger.note(id) })
      }
      contents.on('destroyed', () => ledger.forget(id))
    },
    note(id) { last.set(id, now()) },
    pressedRecently(id, withinMs = RECENT_PRESS_MS) {
      const at = last.get(id)
      if (at === undefined) return false
      const age = now() - at
      return age >= 0 && age <= withinMs
    },
    forget(id) { last.delete(id) },
  }
  return ledger
}

/** Install once, before the first window: every webContents the app creates is watched. */
export function installPressLedger(app: { on(event: 'web-contents-created', listener: (event: unknown, contents: WatchedContents) => void): unknown }, ledger: PressLedger): void {
  app.on('web-contents-created', (_event, contents) => ledger.watch(contents))
}
