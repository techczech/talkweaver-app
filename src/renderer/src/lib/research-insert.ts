import { researchInsertText, researchSlideText, type ResearchListResult } from '../../../shared/research'
import { insertSlideAfterCaret } from '../../../shared/old-slide'
import type { OutlineMutator, OutlineSaveReply } from './outlineMutation'

interface Talk { path: string; outlinePath: string }
export interface ResearchInsertHost<R extends OutlineSaveReply> {
  activeTalk(): Talk | null
  readItem(input: { talkDir: string; file: string }): Promise<ResearchListResult>
  editor(): { path: string; text: string; caret: number } | null
  mutator: OutlineMutator<R>
}
/** Both UI and agent requests enter here; the live buffer remains the one writer. */
export async function insertResearchItem<R extends OutlineSaveReply>(file: string, slide: boolean, host: ResearchInsertHost<R>): Promise<boolean> {
  const talk = host.activeTalk()
  if (!talk) return false
  // Main validates the file against the canonical active talk, including symlink aliases.
  const reply = await host.readItem({ talkDir: talk.path, file })
  if (!reply.ok) throw new Error(reply.error.message)
  const item = reply.items[0]
  if (!item || item.archive || !item.inCurrentTalk || host.activeTalk() !== talk) return false
  const editor = host.editor()
  if (!editor || editor.path !== talk.outlinePath) return false
  const result = slide ? await host.mutator.apply(talk.outlinePath, current => {
    const live = host.editor()
    if (host.activeTalk() !== talk || !live || live.path !== talk.outlinePath || live.text !== current) throw new Error('The talk changed. Try inserting the research again.')
    const placed = insertSlideAfterCaret({ text: current, caret: live.caret, slide: researchSlideText(item) })
    if (!placed.ok) throw new Error(placed.error)
    return placed.text
  }) : await host.mutator.insertAtCaret(talk.outlinePath, researchInsertText(item))
  if (!result.ok && !result.applied) throw new Error(result.error)
  return result.ok || result.applied
}
