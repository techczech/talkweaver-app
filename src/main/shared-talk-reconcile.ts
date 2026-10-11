// Part of Share for comments (ticket 12 design: the header of src/main/shared-talk.ts, section 4).
// share_url as ONE transformation of the outline, decided against the slot's state when the
// writer runs it, never when it was asked for.
import { parseFrontmatterPairs } from '../shared/frontmatter-editor.ts'
import { stampShareUrl as stampShareUrlLine } from '../shared/handout-stamp.ts'
import { describe } from './shared-talk-model.ts'
import type { ShareCore } from './shared-talk-state.ts'
import type { Slot, Slots } from './shared-talk-slots.ts'

export function createReconcile(core: ShareCore, slots: Pick<Slots, 'rowOf'>): (slot: Slot) => Promise<void> {
  const { deps, stopping, linkOf, log } = core
  /**
   * share_url as ONE transformation of the outline (section 4): the writer runs `decide` against the
   * text it holds when the write runs, and decide reads the slot's state then.
   */
  return async function reconcile(slot: Slot): Promise<void> {
    const decide = (text: string): string => {
      const row = slots.rowOf(slot)
      // A share closed on the service whose row stayed (finding 7) has no line.
      if (row && !row.closedRemotely && !stopping.has(row.shareId)) {
        const url = linkOf(row)
        slot.madeUrls.add(url)
        return stampShareUrlLine(text, url)
      }
      if (row && !row.closedRemotely) return text // stopping: the close may fail
      let current: string | null = null
      try { current = parseFrontmatterPairs(text).find((pair) => pair.key === 'share_url')?.value || null } catch { /* no frontmatter */ }
      return current && slot.madeUrls.has(current) ? stampShareUrlLine(text, null) : text
    }
    try {
      await deps.stampShareUrl(slot.outlinePath, decide)
    } catch (error) {
      log(`[shared-talk] share_url not written: ${describe(error)}`)
    }
  }
}
