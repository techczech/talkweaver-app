import type { RecordingSession } from '../../../preload/index'
import { unresolvedTriggerBlock } from '../../../shared/layout-doctor'

/**
 * Starts presenting a planned Run bound to that Run, as History's Present does: the talk's outline is read,
 * a pathway Run presents its pathway, and the presenter is opened with the Run's id so what is recorded and
 * went live lands on this Run. Allowed before the session date.
 */
export async function presentRun(run: Pick<RecordingSession, 'id' | 'slideSet' | 'pathwayId'>, outlinePath: string | undefined): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!outlinePath) return { ok: false, error: 'Talk outline not found' }
  const source = await window.tw.talk.readOutline(outlinePath)
  if (source === null) return { ok: false, error: 'Talk outline could not be read' }
  const blocked = unresolvedTriggerBlock(source)
  if (blocked) return { ok: false, error: blocked.message }
  const set = run.slideSet ?? (run.pathwayId ? { kind: 'pathway' as const, pathwayId: run.pathwayId } : { kind: 'full' as const })
  const result = set.kind === 'pathway'
    ? await window.tw.pathways.present(outlinePath, source, set.pathwayId, run.id)
    : await window.tw.talk.present(outlinePath, source, 'presenter', undefined, run.id)
  return result.success ? { ok: true } : { ok: false, error: `Could not present Run: ${result.error ?? 'unknown error'}` }
}
