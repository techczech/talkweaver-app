// Insert section into the open talk (talk search 07; ADR-0029 §5). The picker's "Insert section"
// runs this: read the section from its talk (main, read-only), copy its images and media into the
// vault pool the way single-slide inserts do, then put it into the open talk's editor buffer through
// the one-writer seam (lib/outlineMutation apply): one minimal change — one undo step — saved from the
// buffer through the file's save queue. It never writes the file itself, and a talk that is not open
// in the editor is refused ('not-open'), never written from disk.
//
// No partial write: every step that can fail runs before the buffer is touched, and the placement is
// worked out inside the mutation against the buffer and caret as they stand, so a refusal leaves the
// talk exactly as it was. The one exception is the save after the change is in the buffer: then the
// change stays in the editor (undoable) and the person is told the save failed.

import { insertSection } from '../../../shared/insert-section.ts'
import type { OutlineMutate, OutlineMutationResult } from './outlineMutation.ts'

export interface SectionInsertRequest {
  /** The talk the section comes from. */
  sourceOutlinePath: string
  /** Where its heading is (the picker's index row): 1-based line and the heading line's text. */
  line: number
  heading: string
  /** The section's name for messages. */
  label: string
}

export interface SectionInsertDeps<R> {
  /** The open talk's outline path, or null with no talk open. */
  targetPath(): string | null
  /** window.tw.talk.extractSection. */
  extract(sourceOutlinePath: string, at: { line: number; heading: string }): Promise<{ ok: true; markdown: string; slides: number } | { ok: false; error: string } | null | undefined>
  /** window.tw.talk.materializeSlideAssets. */
  materialize(sourceOutlinePath: string, markdown: string): Promise<{ success: boolean; markdown: string; error?: string } | null | undefined>
  /** The editor's live buffer and caret for `outlinePath`, or null when it does not hold that talk. */
  readEditor(outlinePath: string): { text: string; caret: number } | null
  /** The one-writer seam (WorkspaceLayout applyOutlineMutation). */
  apply(outlinePath: string, mutate: OutlineMutate): Promise<OutlineMutationResult<R>>
}

export type SectionInsertOutcome =
  | { ok: true; slides: number; line: number; from: number; to: number; level: number }
  /** `applied`: the section is in the editor (undoable) although its save failed. */
  | { ok: false; error: string; applied: boolean }

const NOT_OPEN = 'No talk is open in the editor to insert the section into. Nothing was inserted.'
const SWITCHED = 'The open talk changed while the section was being read, so it was not inserted into the talk you started from. Nothing was inserted; open the talk you want it in and try again.'
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

export async function insertSectionIntoOpenTalk<R>(req: SectionInsertRequest, deps: SectionInsertDeps<R>): Promise<SectionInsertOutcome> {
  const target = deps.targetPath()
  if (!target) return { ok: false, error: NOT_OPEN, applied: false }

  let extracted: Awaited<ReturnType<SectionInsertDeps<R>['extract']>>
  try { extracted = await deps.extract(req.sourceOutlinePath, { line: req.line, heading: req.heading }) } catch (error) {
    return { ok: false, error: `The section “${req.label}” could not be read from its talk (${message(error)}). Nothing was inserted.`, applied: false }
  }
  if (!extracted) return { ok: false, error: `The section “${req.label}” could not be read from its talk. Nothing was inserted.`, applied: false }
  if (!extracted.ok) return { ok: false, error: extracted.error, applied: false }
  const slides = extracted.slides

  // Images and media: into the vault pool, refs rewritten, exactly as single-slide inserts do. As
  // there, a file missing beside the source talk (or one that fails to copy) is skipped with its ref
  // left as written, and materialise still succeeds; only a failure of the whole step (no vault root,
  // the pool cannot be made, a throw) refuses the insert.
  let markdown = extracted.markdown
  let copied: Awaited<ReturnType<SectionInsertDeps<R>['materialize']>>
  try { copied = await deps.materialize(req.sourceOutlinePath, markdown) } catch (error) {
    return { ok: false, error: `The images in “${req.label}” could not be copied into this talk (${message(error)}). Nothing was inserted.`, applied: false }
  }
  if (!copied || !copied.success || typeof copied.markdown !== 'string') {
    return { ok: false, error: `The images in “${req.label}” could not be copied into this talk${copied?.error ? ` (${copied.error})` : ''}. Nothing was inserted.`, applied: false }
  }
  markdown = copied.markdown

  // The talk the insert was started in must still be the open one (the reads above await).
  if (deps.targetPath() !== target) return { ok: false, error: SWITCHED, applied: false }

  let placed: { line: number; from: number; to: number; level: number } | null = null
  const result = await deps.apply(target, (current) => {
    // The seam calls this with the buffer it has just read and no await in between, so the caret read
    // here belongs to that same buffer.
    const editor = deps.readEditor(target)
    if (!editor || editor.text !== current) throw new Error('The talk changed while the section was being placed. Nothing was inserted; try again.')
    const r = insertSection({ text: current, caret: editor.caret, section: markdown })
    if (!r.ok) throw new Error(r.error)
    placed = { line: r.line, from: r.from, to: r.to, level: r.level }
    return r.text
  })
  if (result.ok && result.changed && placed) return { ok: true, slides, ...(placed as { line: number; from: number; to: number; level: number }) }
  if (result.ok) return { ok: false, error: 'The section could not be placed. Nothing was inserted.', applied: false }
  // The seam found the target not open: switched away from since the insert started, or not loaded.
  if (result.reason === 'not-open') return { ok: false, error: deps.targetPath() !== target ? SWITCHED : NOT_OPEN, applied: false }
  if (result.reason === 'save-failed') {
    return { ok: false, error: `“${req.label}” is in the editor, but the talk could not be saved to disk. Undo it (⌘Z) if you do not want it, and check the talk.`, applied: true }
  }
  return { ok: false, error: result.error, applied: false }
}
