// Go live when the live service is not set up (spec docs/plans/cloudflare-setup-in-app, "What each
// user action does": Go live; ticket 05). The prompt says "Going live is not set up" and offers Open
// Settings, where the Going live and sharing row sets it up, and Not now. Presenting continues
// regardless: the prompt is a status in a corner, not a dialog. It takes no focus and no key, so the
// slides keep their keys while it shows.
//
// No set-up starts here (fix round 2). The presenter window shows the person's slides, embeds
// included, and an embed can reach this document: it could move or relabel any button here and have
// the person's own click land on it. So the only thing this prompt can do is open Settings, a
// surface slide content cannot reach; the main process takes a set-up only from an editor window's
// top frame (setUpAllowedFrom in live-service.ts).
//
// Only a person's pointer press acts: a click a script makes (`isTrusted` false) does nothing. A
// press never focuses a button (mousedown is refused focus), a button that has focus all the same
// lets go of it at the first key, and the click a browser makes from Space or Enter (detail 0) does
// nothing: those keys stay the slides'.
//
// No Electron import: the bridge (present-live-bridge.ts) hands it the one call, and a test drives
// it in jsdom over the compiled presenter page.
import { liveSetupPromptCopy, type LiveSetupPrompt } from '../shared/live-service-status.ts'

export const LIVE_SETUP_PROMPT_ID = 'twLiveSetupPrompt'

export interface LiveSetupOptions {
  /** Whether an event is a person's. Tests in jsdom (which makes no trusted events) pass their own; the bridge never does. */
  trusted?(event: Event): boolean
}

export interface LiveSetupActions {
  /** Settings → Cloudflare in the editor window. */
  openSettings(): Promise<unknown>
}

function element<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, text?: string, style?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (style) node.setAttribute('style', style)
  return node
}

const BOX = 'position:fixed;right:18px;bottom:64px;z-index:2147483000;max-width:340px;padding:12px 14px;border-radius:10px;'
  + 'background:rgba(24,24,28,.96);color:#f4f4f5;font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35)'
const BUTTON = 'margin:8px 8px 0 0;padding:5px 12px;border-radius:6px;border:1px solid #f4f4f5;background:#f4f4f5;color:#18181c;font:inherit;font-weight:600;cursor:pointer'
const PLAIN = 'margin:8px 0 0;padding:5px 10px;border-radius:6px;border:1px solid rgba(244,244,245,.4);background:transparent;color:#f4f4f5;font:inherit;cursor:pointer'

/**
 * Show the prompt (replacing one already shown). `message`: the fixed sentence the main process
 * answered with, shown under the title when it says more than the title does. Returns the element.
 */
export function showLiveSetupPrompt(doc: Document, prompt: LiveSetupPrompt, message: string, actions: LiveSetupActions, options: LiveSetupOptions = {}): HTMLElement {
  const trusted = options.trusted ?? ((event: Event) => event.isTrusted)
  doc.getElementById(LIVE_SETUP_PROMPT_ID)?.remove()
  const copy = liveSetupPromptCopy(prompt)
  const root = element(doc, 'div', undefined, BOX)
  root.id = LIVE_SETUP_PROMPT_ID
  root.setAttribute('role', 'status')
  root.setAttribute('aria-live', 'polite')
  root.dataset.prompt = prompt
  const title = element(doc, 'div', copy.title, 'font-weight:600')
  const said = element(doc, 'div', '', 'color:#d4d4d8;margin-top:2px')
  said.dataset.part = 'message'
  said.textContent = message && !message.startsWith(copy.title) ? message : ''
  said.hidden = !said.textContent
  const act = element(doc, 'button', copy.action, BUTTON)
  act.type = 'button'
  act.tabIndex = -1 // pressed with the pointer; the keyboard stays with the slides
  act.dataset.part = 'action'
  const close = element(doc, 'button', 'Not now', PLAIN)
  close.type = 'button'
  close.tabIndex = -1
  close.dataset.part = 'close'
  root.append(title, said, act, close)
  doc.body.append(root)

  for (const button of [act, close]) {
    // A press takes no focus; a key on a button that has it anyway goes on to the slides, and the button lets go.
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('keydown', () => button.blur())
  }
  /** A person's pointer press: trusted, and not the click a browser makes from a key (detail 0). */
  const pressed = (event: Event): boolean => trusted(event) && (event as MouseEvent).detail > 0
  close.addEventListener('click', (event) => { close.blur(); if (pressed(event)) root.remove() })
  act.addEventListener('click', (event) => {
    act.blur()
    if (!pressed(event)) return
    root.remove()
    void actions.openSettings().catch(() => {})
  })
  return root
}
