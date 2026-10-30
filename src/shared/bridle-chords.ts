// Chords in two spellings: the app's key strings (CodeMirror style, 'Mod-Shift-t', as the shortcut
// registry and the editor keymap use them) and @app-patterns/commands chords ('⌘⇧T', as the menu bar, the
// Settings window and the settings file use them). Pure; erasable TypeScript only (node tests
// import it as it is).

const MOD_TO_GLYPH: Readonly<Record<string, string>> = { Mod: '⌘', Cmd: '⌘', Meta: '⌘', Ctrl: '⌃', Control: '⌃', Alt: '⌥', Shift: '⇧' }
const GLYPH_ORDER = ['⌘', '⌃', '⌥', '⇧'] as const
const GLYPH_TO_MOD: Readonly<Record<string, string>> = { '⌘': 'Mod', '⌃': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift' }

const KEY_TO_CHORD: Readonly<Record<string, string>> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Enter: '↵', Backspace: '⌫', Delete: '⌦', Tab: '⇥', Escape: 'Esc', Space: 'Space', ' ': 'Space'
}
const CHORD_TO_KEY: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(KEY_TO_CHORD).filter(([k]) => k !== ' ').map(([k, v]) => [v, k])
)
/** Keys an App Patterns chord may end in besides letters, digits and F-keys. */
const CHORD_PUNCTUATION = new Set([',', '.', '/', ';', "'", '\\', '[', ']', '`', '=', '-'])

/** 'Mod-Shift-t' → '⌘⇧T'; '' when the key cannot be written as a chord (a shifted symbol such as '?'). */
export function chordFromKeyString(keys: string): string {
  const t = keys.trim()
  if (!t) return ''
  // The last '-' separates the key, except for the minus key itself ('Mod--').
  const minus = t.endsWith('--')
  const parts = minus ? [...t.slice(0, -2).split('-').filter(Boolean), '-'] : t.split('-')
  const key = parts.pop() ?? ''
  const mods = new Set<string>()
  for (const p of parts) {
    const g = MOD_TO_GLYPH[p]
    if (!g) return ''
    mods.add(g)
  }
  let name: string
  if (KEY_TO_CHORD[key]) name = KEY_TO_CHORD[key]
  else if (/^[a-zA-Z0-9]$/.test(key)) name = key.toUpperCase()
  else if (/^F\d{1,2}$/.test(key)) name = key
  else if (CHORD_PUNCTUATION.has(key)) name = key
  else return ''
  return GLYPH_ORDER.filter((g) => mods.has(g)).join('') + name
}

/** '⌘⇧T' → 'Mod-Shift-t'; '' for '' or a chord this app cannot spell. */
export function keyStringFromChord(chord: string): string {
  const t = chord.trim()
  if (!t) return ''
  const mods: string[] = []
  let i = 0
  while (i < t.length && GLYPH_TO_MOD[t[i]]) { mods.push(GLYPH_TO_MOD[t[i]]); i += 1 }
  const name = t.slice(i)
  if (!name) return ''
  let key: string
  if (CHORD_TO_KEY[name]) key = CHORD_TO_KEY[name]
  else if (/^[A-Z0-9]$/.test(name)) key = name.toLowerCase()
  else if (/^F\d{1,2}$/.test(name)) key = name
  else if (CHORD_PUNCTUATION.has(name)) key = name
  else return ''
  return [...mods, key].join('-')
}
