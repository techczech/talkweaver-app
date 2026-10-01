// ADR-0033 §1: the outline editor marks the heading line of a slide whose text cannot fit at the
// readable minimum. Pure model (no React/CodeMirror): projection rows + their source lines in,
// one note per flagged heading line out. The message and remedy come from the warning registry so
// every surface says the same thing.
import {
  WARNING_REGISTRY,
  textTooTallPercent
} from '../../compiler/scripts/lib/warning-registry.mjs'

export type TextFitNote = {
  /** 1-based outline line of the slide's heading. */
  line: number
  message: string
  remedy: string
  /** Estimated percentage the slide is too tall at the type floor, when the compiler gave one. */
  tooTallPercent: number | null
}

export function textFitNotesFor(
  rows: ReadonlyArray<{ warnings?: string[] | null }> | null,
  lineForSlide: ReadonlyArray<number | null>
): TextFitNote[] {
  const definition = WARNING_REGISTRY.find((entry) => entry.id === 'text-too-long')
  if (!rows || !definition) return []
  const notes: TextFitNote[] = []
  rows.forEach((row, index) => {
    const line = lineForSlide[index]
    if (typeof line !== 'number') return
    const raw = (row.warnings ?? []).find((warning) => String(warning).split(':', 1)[0] === 'text-too-long')
    if (!raw) return
    notes.push({
      line,
      message: definition.message,
      remedy: definition.remedy,
      tooTallPercent: textTooTallPercent(raw)
    })
  })
  return notes
}

/** The inline note text: the message, then how much too tall. */
export function textFitNoteLabel(note: TextFitNote): string {
  return note.tooTallPercent ? `${note.message} Too tall by ${note.tooTallPercent}%.` : note.message
}
