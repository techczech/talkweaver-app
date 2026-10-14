// Command-I in the Plain view (ticket 13): opens the icon picker under the caret's line, and
// applies its choice.
//
// The write path, all of it:
//   1. `open` reads the outline and the caret's line from the editor (PlainIconTools.caret) and
//      asks the verbs what the line is (shared/icon-verbs.ts lineIconState). A line that takes no
//      icon gets a short message under it and nothing else happens.
//   2. A choice is worked out by the verb on the outline as the editor holds it then, and only if
//      that is still the outline the picker was opened on (so the line is the same line). The
//      verb answers ok only for a result it has read back through the compiler's facts; the
//      icon's name must be one the app's icon source has handed over.
//   3. The verb's one change is dispatched by the editor as one ordinary transaction
//      (PlainIconTools.write), and only if the outline is still the text the verb checked.
// Nothing is written on any other path: a refusal, a thrown error and a moved-on outline all end
// in a message and an unchanged outline.
import { useCallback, useEffect, useRef, useState } from 'react'
import { clearLineIcon, lineIconState, setLineIcon, type IconLineKind, type IconWrite } from '../../../shared/icon-verbs'
import { notify } from '../lib/notify'
import type { PlainIconTools } from './Editor'
import PlainIconPicker, { PlainIconNote, type IconAnchor } from './PlainIconPicker'
import { isKnownIcon, pushRecent } from './plainIconPickerModel'

const NOTE_MS = 2500
const NOT_HERE = 'Icons go on titles, paragraphs and list items.'
const PLACE: Record<IconLineKind, string> = { heading: 'title', paragraph: 'paragraph', item: 'list item' }

type Shown =
  | { view: 'picker'; text: string; line: number; anchor: IconAnchor; kind: IconLineKind; current: string | null }
  | { view: 'note'; anchor: IconAnchor; detail: string }

export function usePlainIconPicker(tools: React.MutableRefObject<PlainIconTools | null>): {
  /** Command-I: open at the caret (or close, when open). False: there is no editor to open it in. */
  toggle: () => boolean
  isOpen: boolean
  /** The picker or the message, to be rendered once anywhere in the workspace. */
  view: JSX.Element | null
} {
  const [shown, setShown] = useState<Shown | null>(null)
  const shownRef = useRef<Shown | null>(null)
  shownRef.current = shown

  // The message goes by itself.
  useEffect(() => {
    if (shown?.view !== 'note') return
    const timer = window.setTimeout(() => setShown((now) => (now === shown ? null : now)), NOTE_MS)
    return () => window.clearTimeout(timer)
  }, [shown])

  const close = useCallback(() => {
    setShown(null)
    // Focus only: the selection is the editor's own and was never touched.
    tools.current?.focus()
  }, [tools])

  const toggle = useCallback((): boolean => {
    if (shownRef.current?.view === 'picker') { close(); return true }
    const at = tools.current?.caret()
    if (!at) return false
    const state = lineIconState(at.text, at.line)
    if (!state.ok) setShown({ view: 'note', anchor: at.anchor, detail: state.detail })
    else setShown({ view: 'picker', text: at.text, line: at.line, anchor: at.anchor, kind: state.kind, current: state.key })
    return true
  }, [close, tools])

  const apply = useCallback((opened: string, verb: (text: string) => IconWrite, icon: string | null) => {
    setShown(null)
    const editor = tools.current
    const at = editor?.caret()
    if (!editor || !at) return
    const moved = (): void => notify('The outline changed while the icon was being placed, so nothing was written.', 'warning', 'plain-icon')
    if (at.text !== opened) { moved(); editor.focus(); return }
    let write: IconWrite
    try {
      write = verb(at.text)
    } catch {
      notify('The outline could not be read, so no icon was changed.', 'warning', 'plain-icon')
      editor.focus()
      return
    }
    if (!write.ok) notify(write.detail, 'warning', 'plain-icon')
    else if (write.changed && write.change && !editor.write(at.text, write.change)) moved()
    else if (icon) pushRecent(icon)
    editor.focus()
  }, [tools])

  let view: JSX.Element | null = null
  if (shown?.view === 'note') view = <PlainIconNote anchor={shown.anchor} message={NOT_HERE} detail={shown.detail} />
  if (shown?.view === 'picker') {
    const { line, text: opened } = shown
    view = (
      <PlainIconPicker
        anchor={shown.anchor} place={PLACE[shown.kind]} current={shown.current}
        onPick={(key) => apply(opened, (text) => setLineIcon(text, line, key, isKnownIcon), key)}
        onRemove={() => apply(opened, (text) => clearLineIcon(text, line), null)}
        onClose={close}
      />
    )
  }
  return { toggle, isOpen: shown?.view === 'picker', view }
}
