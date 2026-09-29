// The slide picker's keyboard hint footer (mockup 1532-1542). Every hint that names a command takes
// its key from the shortcut registry through the live keymap (a Settings rebind shows here at once);
// the three hints about mouse gestures and the help key are literal and say so (talk search 08).
import { useEffect, useState } from 'react'
import { liveShortcutLabel, onKeymapChanged } from '../keymap/store'

type Hint =
  | { id: string; text: string; push?: true }
  | { literal: 'range' | 'scope-click' | 'help' }

export const SLIDE_PICKER_HINTS: Hint[] = [
  { id: 'slide-picker.move', text: 'navigate' },
  { literal: 'range' },
  { id: 'slide-picker.toggle-selection', text: 'select' },
  { id: 'slide-picker.select-section', text: 'select section' },
  { id: 'slide-picker.tags', text: 'tag selection' },
  { id: 'slide-picker.versions', text: 'versions / where-used' },
  { id: 'slide-picker.near', text: 'uncollapse' },
  { id: 'slide-picker.preview', text: 'preview' },
  { id: 'slide-picker.view', text: 'view & insert' },
  { id: 'slide-picker.talk-beside', text: 'talk beside' },
  { id: 'slide-picker.select-whole-section', text: 'select whole section' },
  { id: 'slide-picker.density', text: 'density' },
  { id: 'slide-picker.rail', text: 'rail' },
  { literal: 'scope-click' },
  { id: 'slide-picker.clear-scope', text: 'clear scope' },
  { id: 'app.find-talk', text: 'find a talk' },
  { id: 'slide-picker.close', text: 'close', push: true },
  { literal: 'help' }
]

/** A registry key label as hint keycaps: "↑ ↓ ← →" is four keys, "Space / P" two with a slash. */
export function hintKeycaps(label: string): Array<{ key: string } | { text: string }> {
  if (label === 'no default') return [{ text: '—' }]
  return label.split(' ').filter(Boolean).map((part) => (part === '/' ? { text: '/' } : { key: part }))
}

function Keys({ id }: { id: string }) {
  return (
    <>
      {hintKeycaps(liveShortcutLabel(id)).map((cap, i) => ('key' in cap
        ? <kbd key={i}>{cap.key}</kbd>
        : <span key={i}> {cap.text} </span>))}
    </>
  )
}

export default function SlidePickerHints() {
  const [, setRevision] = useState(0)
  useEffect(() => onKeymapChanged(() => setRevision((n) => n + 1)), [])
  return (
    <footer className="lt-hintbar">
      {SLIDE_PICKER_HINTS.map((hint, i) => {
        if ('literal' in hint) {
          if (hint.literal === 'range') return <span key={i} className="lt-h"><kbd>⇧</kbd>+click <b>range select</b></span>
          if (hint.literal === 'scope-click') return <span key={i} className="lt-h">click <b>scopes</b> · <kbd>⌘</kbd>+click <b>adds</b></span>
          return <span key={i} className="lt-h"><kbd>?</kbd> <b>all shortcuts</b></span>
        }
        return (
          <span key={i} className={`lt-h${hint.push ? ' lt-push' : ''}`} data-hint={hint.id}>
            <Keys id={hint.id} /> <b>{hint.text}</b>
          </span>
        )
      })}
    </footer>
  )
}
