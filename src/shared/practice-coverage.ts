// Keeps the example vault's practice slides honest (onboarding 0.38.1 ticket 09). A chapter's rows
// come from `deriveChapters` (the function the Guide lists and ticks from), and its practice section
// is the one `CHAPTER_TALK` names, so nothing here is typed per chapter.
//
// How a practice section names a command:
//   - by its effective default chord as a key cap, `<kbd>⌘⇧↓</kbd>`: the shortcut registry's first
//     chord for the command (`⌘⇧[ / ⌘\` → `⌘⇧[`; `→ Space ↓` → `→`);
//   - by its palette name in bold, `**Fold all sections**`, when it has no key (the command's label
//     without a trailing bracket, as the Guide row and the palette show it).
// The names are read from the section's slide text (speaker notes are not on the slide and are not
// read). Sub-groups are named in the chapter's order: each sub-group's first mention comes at or
// after the previous sub-group's first mention, and its commands are looked for from there on.
// A row of one command or a pair (larger / smaller) is covered when every command in it is named;
// a row of variants (Notes: off · bottom · …) is covered when one variant is named, which is also
// when the Guide ticks it.
//
// Nothing may be named that does not exist: every key cap must be a chord the shortcut registry
// holds, and every bold phrase in a practice quotation must be its lead-in ("Try it." or
// "Try it: …."), a command's name, or words that stand in the talk's own text outside quotations.
// A practice quotation (one that starts with a bold "Try it") must carry a key cap, because only a
// quotation with a key cap is drawn in the practice style (ticket 05).
import { chapterCommands, rowLabel, type Chapter, type ChapterCommand } from './guide-chapters.ts'
import { SHORTCUT_REGISTRY, type ShortcutEntry } from './shortcut-registry.ts'

/** A command the section should name and does not; `expects` is the exact text that would name it. */
export interface PracticeGap { subgroup: string; row: string; id: string; expects: string }

export interface PracticeCheck {
  /** Rows of the chapter. */
  total: number
  /** Rows the section names. */
  covered: number
  missing: PracticeGap[]
  /** Named, but before an earlier sub-group's first mention. */
  outOfOrder: PracticeGap[]
  /** Key caps that no registry chord matches. */
  unknownKeys: string[]
  /** Bold phrases in practice quotations that are no lead-in, command name or own words. */
  unknownNames: string[]
  /** Practice quotations with no key cap (they would be drawn as ordinary quotations). */
  withoutKeyCap: string[]
}

const shortcutById = (id: string, registry: readonly ShortcutEntry[]): ShortcutEntry | undefined => registry.find((row) => row.id === id)

/** The first chord of a registry key text: `⌘⇧[ / ⌘\` → `⌘⇧[`, `→ Space ↓ PgDn ↵` → `→`. */
export const firstChord = (keys: string): string => keys.split(' / ')[0].split(' ')[0]

/** Every chord a key cap may show: each alternative of every bound registry row. */
export function registryChords(registry: readonly ShortcutEntry[] = SHORTCUT_REGISTRY): Set<string> {
  const out = new Set<string>()
  for (const row of registry) {
    if (row.unbound) continue
    for (const alternative of row.keys.split(' / ')) {
      out.add(alternative)
      for (const key of alternative.split(' ')) if (key) out.add(key)
    }
  }
  return out
}

/** The exact text a practice slide uses to name a command: a key cap of its first default chord, else its name in bold. */
export function practiceMention(command: ChapterCommand, registry: readonly ShortcutEntry[] = SHORTCUT_REGISTRY): string {
  const shortcut = command.shortcutId ? shortcutById(command.shortcutId, registry) : undefined
  return shortcut && !shortcut.unbound ? `<kbd>${firstChord(shortcut.keys)}</kbd>` : `**${rowLabel(command.label)}**`
}

/** The contents of every key cap in a text, in order. */
export const keyCapsIn = (text: string): string[] => [...text.matchAll(/<kbd>(.*?)<\/kbd>/g)].map((match) => match[1])

const boldIn = (text: string): string[] => [...text.matchAll(/\*\*(.+?)\*\*/g)].map((match) => match[1])

/** A talk's text without its frontmatter and its speaker notes (what is on the slides). */
export function slideText(outline: string): string {
  const body = outline.replace(/^---\n[\s\S]*?\n---\n/, '')
  const out: string[] = []
  let notes = false
  for (const line of body.split('\n')) {
    const t = line.trim().toLowerCase()
    if (t === ':::notes') { notes = true; continue }
    if (notes && (t === ':::' || /^#{1,6}\s/.test(line))) { notes = false; if (t === ':::') continue }
    if (!notes) out.push(line)
  }
  return out.join('\n')
}

/** The text of the `##` section whose title is `title`, up to the next `#` or `##` heading; null when absent. */
export function sectionText(outline: string, title: string): string | null {
  const lines = slideText(outline).split('\n')
  const start = lines.findIndex((line) => line.replace(/\s+$/, '') === `## ${title}`)
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) if (/^#{1,2}\s/.test(lines[i])) { end = i; break }
  return lines.slice(start, end).join('\n')
}

/** The talk's title from its frontmatter. */
export const talkTitle = (outline: string): string | null => /^title:\s*"?(.*?)"?\s*$/m.exec(/^---\n([\s\S]*?)\n---/.exec(outline)?.[1] ?? '')?.[1] ?? null

/** The quotations of a text (each run of `>` lines, joined), in order. */
export function quotationsIn(text: string): string[] {
  const out: string[] = []
  let open: string[] | null = null
  for (const line of text.split('\n')) {
    if (line.startsWith('>')) {
      if (open) open.push(line.replace(/^>\s?/, ''))
      else open = [line.replace(/^>\s?/, '')]
    } else if (open) { out.push(open.join(' ')); open = null }
  }
  if (open) out.push(open.join(' '))
  return out
}

const isPractice = (quotation: string): boolean => /^\*\*Try it[.:]/.test(quotation)
const leadInOf = (quotation: string): string | null => /^\*\*(Try it[^*]*\.)\*\*/.exec(quotation)?.[1] ?? null

/** Names in a talk that do not exist: key caps no chord matches, bold phrases no command has, practice lines without a key cap. */
export function unknownIn(
  outline: string,
  commands: readonly ChapterCommand[] = chapterCommands(),
  registry: readonly ShortcutEntry[] = SHORTCUT_REGISTRY
): Pick<PracticeCheck, 'unknownKeys' | 'unknownNames' | 'withoutKeyCap'> {
  const text = slideText(outline)
  const chords = registryChords(registry)
  const names = new Set(commands.flatMap((command) => [command.label, rowLabel(command.label)]))
  const ownWords = text.split('\n').filter((line) => !line.startsWith('>')).join('\n')
  const unknownNames: string[] = []
  const withoutKeyCap: string[] = []
  for (const quotation of quotationsIn(text).filter(isPractice)) {
    const leadIn = leadInOf(quotation)
    for (const phrase of boldIn(quotation)) {
      if (phrase === leadIn || names.has(phrase) || ownWords.includes(phrase)) continue
      if (!unknownNames.includes(phrase)) unknownNames.push(phrase)
    }
    if (keyCapsIn(quotation).length === 0) withoutKeyCap.push(quotation)
  }
  const unknownKeys = [...new Set(keyCapsIn(text).filter((chord) => !chords.has(chord)))]
  return { unknownKeys, unknownNames, withoutKeyCap }
}

/** Check one chapter's practice section against the chapter the Guide derives. */
export function checkPractice(
  chapter: Chapter,
  section: string,
  commands: readonly ChapterCommand[] = chapterCommands(),
  registry: readonly ShortcutEntry[] = SHORTCUT_REGISTRY
): Omit<PracticeCheck, 'unknownKeys' | 'unknownNames' | 'withoutKeyCap'> {
  const byId = new Map(commands.map((command) => [command.id, command]))
  const missing: PracticeGap[] = []
  const outOfOrder: PracticeGap[] = []
  let covered = 0
  let cursor = 0
  for (const group of chapter.subgroups) {
    const starts: number[] = []
    for (const row of group.rows) {
      const members = row.ids.map((id) => byId.get(id)).filter((command): command is ChapterCommand => Boolean(command))
      const named: boolean[] = []
      for (const command of members) {
        const expects = practiceMention(command, registry)
        const at = section.indexOf(expects, cursor)
        const gap = { subgroup: group.name, row: row.label, id: command.id, expects }
        if (at >= 0) { starts.push(at); named.push(true); continue }
        named.push(false)
        if (section.includes(expects)) outOfOrder.push(gap)
        else missing.push(gap)
      }
      const rowCovered = row.merged === 'variants' ? named.some(Boolean) : named.every(Boolean)
      if (rowCovered) covered += 1
      // A variants row needs one variant only: the others are not gaps.
      if (row.merged === 'variants' && rowCovered) {
        for (const command of members) {
          const expects = practiceMention(command, registry)
          const drop = (list: PracticeGap[]): void => { const i = list.findIndex((gap) => gap.id === command.id && gap.expects === expects); if (i >= 0) list.splice(i, 1) }
          drop(missing)
          drop(outOfOrder)
        }
      }
    }
    if (starts.length) cursor = Math.min(...starts)
  }
  return { total: chapter.rows.length, covered, missing, outOfOrder }
}
