import { planCompetingLayoutRepair, type CompetingLayoutRepair } from '../../../shared/competing-layout-repair.ts'
import type { OutlineMutator, OutlineSaveReply } from './outlineMutation.ts'

const CHECK_TIMEOUT_MS = 30_000
const CANCELLED = 'The repair was cancelled.'

/** Apply precisely the reviewed bytes, through the open buffer and its normal save queue. */
export async function applyCompetingLayoutRepair(
  apply: OutlineMutator<OutlineSaveReply>['apply'],
  path: string,
  reviewed: string,
  plan: CompetingLayoutRepair,
  verify: (before: string, after: string) => Promise<boolean | null>,
  { signal, onSaving, timeoutMs = CHECK_TIMEOUT_MS }: {
    signal?: AbortSignal; onSaving?: () => void; timeoutMs?: number
  } = {}
): Promise<string | null> {
  const result = await apply(path, async (base) => {
    if (signal?.aborted) throw new Error(CANCELLED)
    const current = planCompetingLayoutRepair(base, plan.headingLine)
    if (!current.ok || current.text !== plan.text) throw new Error('The reviewed lines no longer match the repair. Review the fix again.')
    let interrupt!: (error: Error) => void
    const interrupted = new Promise<never>((_resolve, reject) => { interrupt = reject })
    const cancel = () => interrupt(new Error(CANCELLED))
    signal?.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(() => interrupt(new Error('Checking the compiled slides took too long. Try again.')), timeoutMs)
    try {
      const identical = await Promise.race([Promise.resolve().then(() => verify(base, plan.text)), interrupted])
      if (signal?.aborted) throw new Error(CANCELLED)
      if (identical === null) throw new Error('The compiler could not check the fix. Try again.')
      if (!identical) throw new Error('The compiled slides would change. Check the attributes in Markdown.')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
    }
    onSaving?.()
    return plan.text
  }, { base: reviewed, ownUndoStep: true, layoutRepair: { before: reviewed, headingLine: plan.headingLine } })
  return result.ok ? null : result.error
}
