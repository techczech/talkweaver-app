/** Read-time identity: kept Runs and vault Runs can legitimately have the same session id. */
export interface RecordingRunLocation {
  id: string
  talkSlug: string
  kept?: 'app-data'
  home?: string | null
}

export function recordingRunHome(run: RecordingRunLocation): string | null | undefined {
  return run.kept === 'app-data' ? null : run.home
}

export function recordingRunKey(run: RecordingRunLocation): string {
  const home = recordingRunHome(run)
  return JSON.stringify([home === undefined ? 'vault' : home, run.talkSlug, run.id])
}
