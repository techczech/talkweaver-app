import { useCallback, useEffect, useState } from 'react'
import type { RecordingSession } from '../../../preload/index'

/**
 * The talk's planned Runs (ADR-0038, ADR-0032 point 5), reloaded when a Run is saved anywhere in
 * the app (`tw-runs-changed`) and when the window regains focus (History is another window). The
 * status bar's Run chips and the Inspector's "Before the session" section read the same list.
 */
export function usePlannedRuns(talkSlug: string): RecordingSession[] {
  const [runs, setRuns] = useState<RecordingSession[]>([])
  const reload = useCallback(async (): Promise<void> => {
    try {
      const all = await window.tw.history.listRuns(talkSlug)
      setRuns(all.filter((run) => run && run.status === 'planned'))
    } catch { setRuns([]) }
  }, [talkSlug])
  useEffect(() => {
    setRuns([])
    void reload()
    const refresh = (): void => { void reload() }
    window.addEventListener('tw-runs-changed', refresh)
    window.addEventListener('focus', refresh)
    return () => { window.removeEventListener('tw-runs-changed', refresh); window.removeEventListener('focus', refresh) }
  }, [reload])
  return runs
}
