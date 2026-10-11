// A registry chord ('Mod-Shift-t', 'Alt-ArrowUp', 'Tab') as the init of the KeyboardEvent that
// matches it. The command palette runs a command that only a key reaches by sending that key to
// the editor, as the presenter palette's viaKey entries do. The round trip is tested against
// shortcutEventMatches in scripts/test-task-groups.mjs.

export interface ChordEventInit {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  bubbles: true
  cancelable: true
}

export function chordEventInit(code: string): ChordEventInit {
  const parts = code.split('-')
  // A chord whose key is '-' ends in an empty part ('Mod--').
  const base = code.endsWith('-') ? '-' : (parts.at(-1) ?? '')
  const modifiers = new Set(code.endsWith('-') ? parts.slice(0, -2) : parts.slice(0, -1))
  const shiftKey = modifiers.has('Shift')
  const key = base === 'Space' ? ' ' : base.length === 1 && shiftKey ? base.toUpperCase() : base
  return {
    key,
    metaKey: modifiers.has('Mod'),
    ctrlKey: modifiers.has('Ctrl'),
    altKey: modifiers.has('Alt'),
    shiftKey,
    bubbles: true,
    cancelable: true
  }
}
