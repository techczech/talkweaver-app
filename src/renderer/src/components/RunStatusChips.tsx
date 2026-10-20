import { useEffect, useMemo, useState } from 'react'
import { ListChecks, Lock, MessageSquareHeart } from 'lucide-react'
import { statusChip, type StatusChip, type StatusChipTone } from '../../../shared/status-chip'
import type { SessionSource } from '../../../shared/sessions-list'

// The talk's next Run, as one chip at the right end of the status bar (work-files-and-sessions
// ticket 21; locked mockup section 6). The text and tone come from the chip model
// (src/shared/status-chip.ts); a click opens the Tools window on Sessions with that Run selected.

const REFRESH_MS = 30_000

/** The Runs of this talk (this vault) and which are live, reloaded when a Run changes, on focus and every 30 s. */
function useTalkSessions(slug: string, vaultId: string | undefined): { runs: SessionSource[]; live: Set<string>; now: Date } {
  const [state, setState] = useState<{ runs: SessionSource[]; live: string[]; now: Date }>({ runs: [], live: [], now: new Date() })
  useEffect(() => {
    let cancelled = false
    const reload = async (): Promise<void> => {
      try {
        const all = await window.tw.sessions.list()
        if (cancelled) return
        setState({ runs: all.runs.filter((run) => run.talkSlug === slug && (!vaultId || run.vaultId === vaultId)), live: all.live, now: new Date() })
      } catch { if (!cancelled) setState({ runs: [], live: [], now: new Date() }) }
    }
    setState({ runs: [], live: [], now: new Date() })
    void reload()
    const refresh = (): void => { void reload() }
    window.addEventListener('tw-runs-changed', refresh)
    window.addEventListener('focus', refresh)
    const timer = window.setInterval(refresh, REFRESH_MS)
    return () => { cancelled = true; window.removeEventListener('tw-runs-changed', refresh); window.removeEventListener('focus', refresh); window.clearInterval(timer) }
  }, [slug, vaultId])
  const live = useMemo(() => new Set(state.live), [state.live])
  return { runs: state.runs, live, now: state.now }
}

export default function RunStatusChips({ talk }: { talk: { slug: string; vaultId?: string } }): JSX.Element | null {
  const { runs, live, now } = useTalkSessions(talk.slug, talk.vaultId)
  const chip = useMemo<StatusChip | null>(() => statusChip(runs, live, now), [runs, live, now])
  if (!chip) return null
  const tone = TONES[chip.tone]
  return (
    <button type="button" data-testid="status-run" data-tone={chip.tone} title="Open run in Tools"
      style={{ ...base, ...tone }}
      onClick={() => { void window.tw.tools.openRun(chip.ref.talkSlug, chip.ref.runId, chip.ref.vaultId) }}>
      {chip.icon === 'list-checks' && <ListChecks size={13} strokeWidth={2} aria-hidden />}
      {chip.icon === 'lock' && <Lock size={13} strokeWidth={2} aria-hidden />}
      {chip.icon === 'message-square-heart' && <MessageSquareHeart size={13} strokeWidth={2} aria-hidden />}
      {chip.icon === 'live-dot' && <span className="tw-chip-dot" aria-hidden />}
      <span>{chip.text}</span>
    </button>
  )
}

const base: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', height: '18px', padding: '0 9px', borderRadius: '9px',
  fontFamily: 'inherit', fontSize: '11px', fontWeight: 700, lineHeight: 1, whiteSpace: 'nowrap', cursor: 'pointer', flexShrink: 0, borderStyle: 'solid', borderWidth: '1px'
}
const TONES: Record<StatusChipTone, React.CSSProperties> = {
  blue: { background: '#e6ecf4', borderColor: '#c2d0e3', color: '#0b3a6b' },
  amber: { background: '#f5e8d2', borderColor: '#e5cc9c', color: '#a3630e' },
  red: { background: '#f3e0da', borderColor: '#e3bdb3', color: '#8c3a2e' }
}
