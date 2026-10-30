// Two stores, copy before removal. A confirmed snapshot is never rolled back: Undo restores only the outline.
import { blockAt, cutBlocks, refHolds, type SlideRef } from '../../../shared/slide-handling/blocks.ts'
import type { ScratchReply, ScratchSlideInput } from '../../../shared/scratchpad.ts'
import type { OutlineMutationOptions, OutlineMutationResult, OutlineMutate } from './outlineMutation.ts'

export interface SetAsideHost {
  readonly outlinePath: string | null
  settled(): Promise<void>
  read(): { path: string; text: string } | null
  copy(inputs: ScratchSlideInput[], expectedOutline: string): Promise<ScratchReply<object>>
  apply(path: string, mutate: OutlineMutate, options: OutlineMutationOptions): Promise<OutlineMutationResult<unknown>>
  notify(message: string): void
}
const busy = new WeakSet<SetAsideHost>()
const kept = 'The slides were copied to the Scratchpad, but could not be removed from the talk. The Scratchpad copies have been kept.'

export async function runSetAside(host: SetAsideHost, refs: readonly SlideRef[], source: Omit<ScratchSlideInput, 'slideId' | 'title' | 'markdown'>): Promise<boolean> {
  if (busy.has(host)) return false
  busy.add(host)
  let copied = false
  try {
    const expectedOutline = host.outlinePath
    await host.settled()
    const before = host.read()
    if (!before || refs.length === 0) return false
    if (before.path !== expectedOutline) { host.notify('Nothing was removed from the talk: the open talk changed while its save was finishing.'); return false }
    const cut = cutBlocks(before.text, refs)
    if ('refused' in cut) { host.notify(cut.refused); return false }
    const inputs: ScratchSlideInput[] = []
    let endLine = 0
    const lines = before.text.split('\n')
    for (const ref of [...refs].sort((a, b) => a.line - b.line)) {
      if (ref.line < endLine) continue // a section already carries its selected descendants
      const block = blockAt(before.text, ref.line)!
      endLine = block.endLine
      const from = lines.slice(0, block.line - 1).join('\n').length + (block.line > 1 ? 1 : 0)
      const to = block.endLine > lines.length ? before.text.length : lines.slice(0, block.endLine - 1).join('\n').length + 1
      const markdown = before.text.slice(from, to)
      const slideId = /\{id=([A-Za-z0-9_-]+)\}/.exec(markdown.split('\n').slice(0, 2).join('\n'))?.[1] ?? ''
      inputs.push({ ...source, slideId, title: block.title, markdown })
    }
    const reply = await host.copy(inputs, before.path)
    if (!reply.ok) { host.notify(`Nothing was removed from the talk: the Scratchpad copy failed. ${reply.error}`); return false }
    copied = true
    if (host.read()?.path !== before.path) { host.notify(kept); return false }
    const result = await host.apply(before.path, (current) => {
      // Check the entire snapshot too: unchanged heading text alone cannot protect a body edited during the copy.
      if (current !== before.text || !refs.every(ref => refHolds(current, ref))) throw new Error('The talk changed while the Scratchpad copy was being saved.')
      const removal = cutBlocks(current, refs)
      if ('refused' in removal) throw new Error(removal.refused)
      return removal.text
    }, { base: before.text, ownUndoStep: true })
    if (!result.ok) {
      host.notify(result.applied
        ? `The slides are out of the talk in the editor and copied in the Scratchpad, but the talk file could not be saved yet. The Scratchpad copies have been kept. Undo restores them to the talk. ${result.error}`
        : `${kept} ${result.error}`)
      return false
    }
    host.notify(`${cut.count === 1 ? 'Slide or section' : `${cut.count} slides or sections`} set aside in the Scratchpad. Undo restores them to the talk.`)
    return true
  } catch (error) {
    host.notify(`${copied ? kept : 'Nothing was removed from the talk: the Scratchpad copy failed.'} ${error instanceof Error ? error.message : String(error)}`)
    return false
  } finally { busy.delete(host) }
}
