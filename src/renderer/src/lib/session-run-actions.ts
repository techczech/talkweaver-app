// The Sessions page's Go live and Open results, for the Run on show (issue 256). Every Run in the Sessions list
// belongs to one open vault, and two open vaults can hold the same talk and Run id (a copied vault). Both actions
// carry that vault: Go live reads the Run and its talk from the Run's own vault, never the primary one, and Open
// results names the vault to the Tools window, which opens History's results only for a Run of the vault History
// lists. Kept apart from SessionsView so the scripts can drive it with stand-ins for window.tw.

/** The Run on show: its vault, talk and Run id. */
export interface SessionRunTarget {
  vaultId: string
  talkSlug: string
  runId: string
}

/** What Go live needs from window.tw: the Run's vault's Runs and talks, and presenting a Run (lib/present-run.ts). */
export interface GoLiveApi<R extends { id: string }> {
  listRuns(talkSlug: string, vaultId: string): Promise<R[]>
  talkHandouts(vaultId: string): Promise<Record<string, { outlinePath?: string } | undefined>>
  present(run: R, outlinePath: string | undefined): Promise<{ ok: true } | { ok: false; error: string }>
}

export const GO_LIVE_REFUSED = 'This Run cannot be presented from here.'

/** Go live from the Sessions page: the Run and its talk's outline from the Run's own vault. */
export async function goLiveFromSessions<R extends { id: string }>(target: SessionRunTarget, api: GoLiveApi<R>): Promise<{ ok: true } | { ok: false; error: string }> {
  const [runs, talks] = await Promise.all([api.listRuns(target.talkSlug, target.vaultId), api.talkHandouts(target.vaultId)])
  const run = runs.find((candidate) => candidate.id === target.runId)
  if (!run) return { ok: false, error: GO_LIVE_REFUSED }
  return api.present(run, talks[target.talkSlug]?.outlinePath)
}

/** window.tw.tools.open, as Open results uses it. */
export type ToolsOpen = (view: 'history', sessionId: string, run: SessionRunTarget) => Promise<{ success: boolean; error?: string }>

/** Open results from the Sessions page: History's results for the Run, naming the Run's vault. */
export function openResultsFromSessions(target: SessionRunTarget, open: ToolsOpen): Promise<{ success: boolean; error?: string }> {
  return open('history', `results:${target.talkSlug}/${target.runId}`, { vaultId: target.vaultId, talkSlug: target.talkSlug, runId: target.runId })
}
