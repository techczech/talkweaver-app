// The presenter's clipboard read, in main (embed-sandbox design 4.3). The Live menu's "Instant slide
// from clipboard" and the same command in the palette have no paste event to read, so the presenter
// preload asks main. Before this the preload read Electron's clipboard itself and returned it to
// whatever page script called the bridge, at any time.
//
// `live:read-clipboard` answers only when all three hold:
//   1. the sender is a presenter window;
//   2. that window is focused;
//   3. a real key or mouse press reached that window in the last five seconds (recent-press.ts).
// Otherwise it returns nothing (empty text, no image) and logs one line. It never throws for a
// refusal: the deck then shows "Nothing to show", as for an empty clipboard.
// The frame rule (the sender is the window's main frame) is the app-wide guard, ipc-main-frame-only.ts.
//
// The answer is bounded: text cut to 20,000 characters, one image as PNG, dropped when it is larger
// than the instant-image handler accepts (`live:fit-instant-image`, 50 MB).

export const CLIPBOARD_TEXT_LIMIT = 20_000
export const CLIPBOARD_IMAGE_LIMIT_BYTES = 50_000_000

export type ClipboardReadDecision = 'allow' | 'not-presenter' | 'not-focused' | 'no-recent-press'

export function decideClipboardRead(facts: { isPresenter: boolean; focused: boolean; pressedRecently: boolean }): ClipboardReadDecision {
  if (facts.isPresenter !== true) return 'not-presenter'
  if (facts.focused !== true) return 'not-focused'
  if (facts.pressedRecently !== true) return 'no-recent-press'
  return 'allow'
}

/** At most 20,000 UTF-16 units, never ending on half of a surrogate pair. */
export function capClipboardText(text: unknown): string {
  if (typeof text !== 'string') return ''
  if (text.length <= CLIPBOARD_TEXT_LIMIT) return text
  const cut = text.slice(0, CLIPBOARD_TEXT_LIMIT)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

export interface ClipboardAnswer { text: string; image: Uint8Array | null }

type ClipboardImage = { isEmpty(): boolean; toPNG(): Uint8Array }

export interface ClipboardReadDeps {
  isPresenter(senderId: number): boolean
  /** The sender's window is the focused window. */
  isFocused(sender: unknown): boolean
  pressedRecently(senderId: number): boolean
  clipboard: { readText(): string; readImage(): ClipboardImage | null | undefined }
  log?: (message: string) => void
}

const NOTHING: ClipboardAnswer = Object.freeze({ text: '', image: null }) as ClipboardAnswer

/** The `ipcMain.handle('live:read-clipboard', …)` listener. The clipboard is not touched on a refusal. */
export function liveReadClipboardHandler(deps: ClipboardReadDeps): (event: { sender: { id: number } }) => ClipboardAnswer {
  return (event) => {
    const sender = event?.sender
    const id = sender?.id
    let decision: ClipboardReadDecision = 'not-presenter'
    try {
      decision = typeof id !== 'number' ? 'not-presenter' : decideClipboardRead({
        isPresenter: deps.isPresenter(id),
        focused: deps.isFocused(sender),
        pressedRecently: deps.pressedRecently(id),
      })
    } catch { decision = 'not-presenter' }
    if (decision !== 'allow') {
      try { (deps.log ?? console.warn)(`[clipboard] refused a read from window ${String(id ?? '?')}: ${decision}`) } catch { /* logging never changes the answer */ }
      return { ...NOTHING }
    }
    let text = ''
    let image: Uint8Array | null = null
    try { text = capClipboardText(deps.clipboard.readText()) } catch { text = '' }
    try {
      const picture = deps.clipboard.readImage()
      if (picture && !picture.isEmpty()) {
        const png = picture.toPNG()
        image = png.byteLength > 0 && png.byteLength <= CLIPBOARD_IMAGE_LIMIT_BYTES ? new Uint8Array(png) : null
      }
    } catch { image = null }
    return { text, image }
  }
}
