// TalkWeaver History — the delivered-talks ledger (ADR-0035, direction-5).
// Full-window Light Table surface joining recorded Sessions with published handout metadata.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart3, CalendarDays, Check, Clock, Copy, ExternalLink, FileText, HardDrive, History as HistoryIcon,
  MoreVertical, PanelLeftClose, PanelLeftOpen, Pencil, Play, Radio,
  Plus, RefreshCw, Search, Settings, Tag, Trash2, UploadCloud, VolumeX, X
} from 'lucide-react'
import type { HistoryLiveCheck, Pathway, RecordingKind, RecordingSession, RunSlideSet, TalkHandouts } from '../../../preload/index'
import '../history.css'

type SortMode = 'newest' | 'talk' | 'length'
type GroupMode = 'date' | 'month' | 'talk'
type KindFilter = Record<RecordingKind, boolean>
type LiveUi = { status: 'live' | 'offline' | 'checking' | 'unpub'; checkedAt: string | null }
type StorageSettings = {
  endpoint: string
  bucket: string
  credsSource: 'bws' | 'settings'
  bwsSecretId: string
  discardSeconds: number
  hasKeys: boolean
}

type Row = {
  session: RecordingSession
  title: string
  handoutUrl: string | null
  evergreenUrl: string | null
  live: LiveUi
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MON_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const KIND_ORDER: RecordingKind[] = ['delivery', 'rehearsal', 'recording']
const DEFAULT_KIND_FILTER: KindFilter = { delivery: true, rehearsal: false, recording: false }

function normaliseUrl(url: string | null): string | null {
  if (!url) return null
  const trimmed = url.trim()
  if (!trimmed) return null
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '')
}

function fmtMins(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000))
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${h}h ${String(m).padStart(2, '0')}m`
}

function fmtDate(iso: string): { dow: string; day: number; mon: string; year: number; time: string; monthName: string } {
  const d = new Date(iso)
  if (isNaN(d.getTime())) {
    return { dow: '—', day: 0, mon: '—', year: 0, time: '—', monthName: 'Unknown date' }
  }
  return {
    dow: DOW[d.getDay()],
    day: d.getDate(),
    mon: MON[d.getMonth()],
    year: d.getFullYear(),
    time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    monthName: `${MON_LONG[d.getMonth()]} ${d.getFullYear()}`
  }
}

function relativePlannedDate(value: string | undefined): string {
  if (!value) return ''
  const target = new Date(`${value}T12:00:00`).getTime()
  if (!Number.isFinite(target)) return ''
  const days = Math.round((target - Date.now()) / 86_400_000)
  if (days === 0) return 'today'
  return days > 0 ? `in ${days} day${days === 1 ? '' : 's'}` : `${Math.abs(days)} day${days === -1 ? '' : 's'} ago`
}

function checkedAgo(iso: string | null): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return `${Math.round(diff / 86_400_000)}d ago`
}

function hasRecordedAudio(s: RecordingSession): boolean {
  return s.audio !== null
}

function trimMs(s: RecordingSession): number {
  if (!s.trims?.length) return 0
  return s.trims.reduce((sum, trim) => {
    const start = Math.max(0, Math.min(s.recordingMs, trim.start))
    const end = Math.max(0, Math.min(s.recordingMs, trim.end))
    return end > start ? sum + end - start : sum
  }, 0)
}

function normaliseKind(kind: RecordingSession['kind'] | undefined): RecordingKind {
  return kind === 'rehearsal' || kind === 'recording' ? kind : 'delivery'
}

function kindLabel(kind: RecordingKind): string {
  return kind === 'delivery' ? 'Delivery' : kind === 'rehearsal' ? 'Rehearsal' : 'Recording'
}

function deliveredMs(s: RecordingSession): number {
  return hasRecordedAudio(s) ? Math.max(0, s.recordingMs - trimMs(s)) : s.wallClockMs
}

function deltaOf(s: RecordingSession): { cls: string; text: string } | null {
  if (!s.timerTargetMin) return null
  const actual = Math.round(deliveredMs(s) / 60000)
  const delta = actual - s.timerTargetMin
  if (Math.abs(delta) < 1) return { cls: 'onpar', text: 'on par' }
  return delta > 0 ? { cls: 'over', text: `+${delta}m` } : { cls: 'under', text: `−${Math.abs(delta)}m` }
}

function waveBars(session: RecordingSession): number[] {
  const seed = session.id.split('').reduce((a, ch) => a + ch.charCodeAt(0), 0) + Math.round(deliveredMs(session) / 1000)
  return Array.from({ length: 11 }, (_v, i) => 4 + ((seed * (i + 3)) % 12))
}

function groupKey(row: Row, group: GroupMode): { key: string; name: string; when: string } {
  const d = new Date(row.session.startedAt)
  if (group === 'talk') return { key: `talk:${row.title}`, name: row.title, when: '' }
  if (group === 'month') {
    const f = fmtDate(row.session.startedAt)
    return { key: `month:${f.year}-${f.mon}`, name: f.monthName, when: '' }
  }
  if (isNaN(d.getTime())) return { key: 'unknown', name: 'Unknown date', when: '' }
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const then = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((today - then) / 86_400_000)
  if (days <= 0) return { key: 'today', name: 'Today', when: '' }
  if (days <= 6) return { key: 'week', name: 'This week', when: 'the last seven days' }
  const f = fmtDate(row.session.startedAt)
  return { key: `month:${f.year}-${f.mon}`, name: f.monthName, when: '' }
}

export default function History({
  isOpen,
  onClose,
  onShowStudio
}: {
  isOpen: boolean
  onClose: () => void
  onShowStudio?: (sessionId?: string) => void
}): JSX.Element | null {
  const [sessions, setSessions] = useState<RecordingSession[]>([])
  const [planned, setPlanned] = useState<RecordingSession[]>([])
  const [handouts, setHandouts] = useState<TalkHandouts>({})
  const [liveMap, setLiveMap] = useState<Record<string, LiveUi>>({})
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortMode>('newest')
  const [group, setGroup] = useState<GroupMode>('date')
  const [hasRecording, setHasRecording] = useState(false)
  const [liveOnly, setLiveOnly] = useState(false)
  const [kinds, setKinds] = useState<KindFilter>(DEFAULT_KIND_FILTER)
  const [talkScope, setTalkScope] = useState<string | null>(null)
  const [railOpen, setRailOpen] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sheet, setSheet] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [storage, setStorage] = useState<StorageSettings | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [kindChoice, setKindChoice] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [contextDraft, setContextDraft] = useState('')
  const [uploadBusy, setUploadBusy] = useState<string | null>(null)
  const [planOpen, setPlanOpen] = useState(true)
  const [planTalk, setPlanTalk] = useState('')
  const [planDate, setPlanDate] = useState(new Date().toISOString().slice(0, 10))
  const [planEvent, setPlanEvent] = useState('')
  const [planAudience, setPlanAudience] = useState('')
  const [planSlideSet, setPlanSlideSet] = useState('full')
  const [planPathways, setPlanPathways] = useState<Pathway[]>([])
  const [planBusy, setPlanBusy] = useState(false)
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [handoutBusy, setHandoutBusy] = useState(false)

  const searchRef = useRef<HTMLInputElement>(null)
  const planEventRef = useRef<HTMLInputElement>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flash = useCallback((msg: string): void => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2400)
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    const [all, talks] = await Promise.all([
      window.tw.history.listRuns(),
      window.tw.history.talkHandouts()
    ])
    // Guard against a malformed/partial session.json (e.g. a write interrupted mid-save): the UI keys,
    // sorts and seeds avatars off id/startedAt/talkSlug, and one missing field would crash the whole
    // window. Drop invalid sessions at this single load boundary rather than defending every access.
    const valid = all.filter(
      (s) => s && typeof s.id === 'string' && typeof s.startedAt === 'string' && typeof s.talkSlug === 'string'
    )
    if (valid.length !== all.length) console.warn(`[history] skipped ${all.length - valid.length} malformed session(s)`)
    setPlanned(valid.filter((run) => run.status === 'planned'))
    setSessions(valid.filter((run) => run.status !== 'planned'))
    setHandouts(talks)
  }, [])

  useEffect(() => {
    if (!planTalk) setPlanTalk(Object.keys(handouts)[0] ?? '')
  }, [handouts, planTalk])

  useEffect(() => {
    let cancelled = false
    const talk = handouts[planTalk]
    if (!talk?.outlinePath) { setPlanPathways([]); return }
    void (async () => {
      const source = await window.tw.talk.readOutline(talk.outlinePath)
      if (source === null) return
      const snapshot = await window.tw.pathways.read(talk.outlinePath, source)
      if (!cancelled && !('error' in snapshot)) setPlanPathways(snapshot.pathways)
    })()
    return () => { cancelled = true }
  }, [handouts, planTalk])

  useEffect(() => {
    const openPlanner = (): void => {
      setPlanOpen(true)
      window.setTimeout(() => planEventRef.current?.focus(), 0)
    }
    window.addEventListener('tw-plan-run', openPlanner)
    return () => window.removeEventListener('tw-plan-run', openPlanner)
  }, [])

  const submitPlan = useCallback(async (): Promise<void> => {
    const talk = handouts[planTalk]
    if (!talk || !planDate || !planEvent.trim()) { flash('Choose a talk, date and event'); return }
    setPlanBusy(true)
    const slideSet: RunSlideSet = planSlideSet === 'full' ? { kind: 'full' } : { kind: 'pathway', pathwayId: planSlideSet }
    const result = editingPlanId
      ? await window.tw.history.updatePlannedRun(planTalk, editingPlanId, { plannedDate: planDate, eventTitle: planEvent.trim(), audience: planAudience.trim(), slideSet })
      : await window.tw.history.createPlannedRun({
        talkSlug: planTalk,
        talkTitle: talk.title,
        plannedDate: planDate,
        eventTitle: planEvent.trim(),
        audience: planAudience.trim(),
        slideSet
      })
    setPlanBusy(false)
    if (!result.ok) { flash(`Could not plan Run: ${result.error ?? 'unknown error'}`); return }
    setPlanEvent('')
    setPlanAudience('')
    setEditingPlanId(null)
    await reload()
    flash(editingPlanId ? 'Planned Run updated' : 'Run planned')
  }, [editingPlanId, flash, handouts, planAudience, planDate, planEvent, planSlideSet, planTalk, reload])

  const beginEditPlanned = useCallback((run: RecordingSession): void => {
    const set = run.slideSet ?? (run.pathwayId ? { kind: 'pathway' as const, pathwayId: run.pathwayId } : { kind: 'full' as const })
    setPlanTalk(run.talkSlug)
    setPlanDate(run.plannedDate ?? new Date().toISOString().slice(0, 10))
    setPlanEvent(run.eventTitle ?? '')
    setPlanAudience(run.audience ?? '')
    setPlanSlideSet(set.kind === 'pathway' ? set.pathwayId : 'full')
    setEditingPlanId(run.id)
    setPlanOpen(true)
    window.setTimeout(() => planEventRef.current?.focus(), 0)
  }, [])

  const removePlanned = useCallback(async (run: RecordingSession): Promise<void> => {
    const result = await window.tw.history.deletePlannedRun(run.talkSlug, run.id)
    if (!result.ok) { flash(`Could not delete Run: ${result.error ?? 'unknown error'}`); return }
    await reload()
    flash('Planned Run deleted')
  }, [flash, reload])

  const presentPlanned = useCallback(async (run: RecordingSession): Promise<void> => {
    const talk = handouts[run.talkSlug]
    if (!talk?.outlinePath) { flash('Talk outline not found'); return }
    const source = await window.tw.talk.readOutline(talk.outlinePath)
    if (source === null) { flash('Talk outline could not be read'); return }
    const set = run.slideSet ?? (run.pathwayId ? { kind: 'pathway' as const, pathwayId: run.pathwayId } : { kind: 'full' as const })
    const result = set.kind === 'pathway'
      ? await window.tw.pathways.present(talk.outlinePath, source, set.pathwayId, run.id)
      : await window.tw.talk.present(talk.outlinePath, source, 'presenter', undefined, run.id)
    if (!result.success) flash(`Could not present Run: ${result.error ?? 'unknown error'}`)
  }, [flash, handouts])

  useEffect(() => {
    if (!isOpen) return
    void reload()
    void window.tw.recording.getStorage().then(setStorage).catch(() => setStorage(null))
  }, [isOpen, reload])

  const rows = useMemo<Row[]>(() => sessions.map((session) => {
    const h = handouts[session.talkSlug]
    const handoutUrl = normaliseUrl(session.handoutUrl ?? null)
    return {
      session,
      title: h?.title || session.talkTitle,
      handoutUrl,
      evergreenUrl: normaliseUrl(h?.handoutUrl ?? null),
      live: handoutUrl ? liveMap[handoutUrl] ?? { status: 'checking', checkedAt: null } : { status: 'unpub', checkedAt: null }
    }
  }), [sessions, handouts, liveMap])

  const detailRow = useMemo(() => rows.find((row) => row.session.id === detailId) ?? null, [detailId, rows])

  const publishRunHandout = useCallback(async (row: Row): Promise<void> => {
    setHandoutBusy(true)
    const result = await window.tw.history.publishRunHandout(row.session.talkSlug, row.session.id)
    setHandoutBusy(false)
    if (!result.success) { flash(`Could not publish Run handout: ${result.error ?? 'unknown error'}`); return }
    await reload()
    if (result.missing?.length) flash(`Run handout published; skipped ${result.missing.length} missing slide id${result.missing.length === 1 ? '' : 's'}`)
    else flash('Run handout published')
  }, [flash, reload])

  const unpublishRunHandout = useCallback(async (row: Row): Promise<void> => {
    setHandoutBusy(true)
    const result = await window.tw.history.unpublishRunHandout(row.session.talkSlug, row.session.id)
    setHandoutBusy(false)
    if (!result.success) { flash(`Could not unpublish Run handout: ${result.error ?? 'unknown error'}`); return }
    await reload()
    flash('Run handout unpublished')
  }, [flash, reload])

  const checkLive = useCallback(async (url: string, force: boolean): Promise<HistoryLiveCheck> => {
    setLiveMap((m) => ({ ...m, [url]: { status: 'checking', checkedAt: null } }))
    const res = await window.tw.history.checkLive(url, force)
    setLiveMap((m) => ({ ...m, [url]: { status: res.status, checkedAt: res.checkedAt } }))
    return res
  }, [])

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    const urls = Array.from(new Set(rows.map((r) => r.handoutUrl).filter((u): u is string => !!u)))
    urls.forEach((url) => {
      if (liveMap[url] && liveMap[url].status !== 'checking') return
      void window.tw.history.checkLive(url, false).then((res) => {
        if (!cancelled) setLiveMap((m) => ({ ...m, [url]: { status: res.status, checkedAt: res.checkedAt } }))
      }).catch(() => {
        if (!cancelled) setLiveMap((m) => ({ ...m, [url]: { status: 'offline', checkedAt: new Date().toISOString() } }))
      })
    })
    return () => { cancelled = true }
  }, [isOpen, rows, liveMap])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = rows.filter((r) => kinds[normaliseKind(r.session.kind)])
    if (hasRecording) list = list.filter((r) => hasRecordedAudio(r.session))
    if (liveOnly) list = list.filter((r) => r.live.status === 'live')
    if (talkScope) list = list.filter((r) => r.session.talkSlug === talkScope)
    if (q) {
      list = list.filter((r) => {
        const f = fmtDate(r.session.startedAt)
        const hay = [
          r.title,
          r.session.context ?? '',
          kindLabel(normaliseKind(r.session.kind)),
          r.handoutUrl ?? '',
          f.dow,
          f.mon,
          f.monthName,
          String(f.day),
          String(f.year)
        ].join(' ').toLowerCase()
        return hay.includes(q)
      })
    }
    const arr = [...list]
    // Null-safe throughout: a malformed/partial session.json (e.g. one whose write was interrupted)
    // can miss startedAt/title, and an unguarded `.localeCompare` on undefined would blank the whole
    // window. Fall back to '' so a bad row sorts to the end instead of crashing History.
    arr.sort((a, b) => {
      const sa = a.session.startedAt || '', sb = b.session.startedAt || ''
      if (sort === 'talk') return (a.title || '').localeCompare(b.title || '') || sb.localeCompare(sa)
      if (sort === 'length') return deliveredMs(b.session) - deliveredMs(a.session) || sb.localeCompare(sa)
      return sb.localeCompare(sa)
    })
    return arr
  }, [rows, kinds, query, hasRecording, liveOnly, talkScope, sort])

  const rowOrder = useMemo(() => visible.map((r) => r.session.id), [visible])

  useEffect(() => {
    if (!isOpen) return
    setSelectedId((cur) => (cur && rowOrder.includes(cur) ? cur : rowOrder[0] ?? null))
  }, [isOpen, rowOrder])

  const grouped = useMemo(() => {
    const map = new Map<string, { name: string; when: string; items: Row[] }>()
    for (const row of visible) {
      const bucket = groupKey(row, group)
      if (!map.has(bucket.key)) map.set(bucket.key, { name: bucket.name, when: bucket.when, items: [] })
      map.get(bucket.key)?.items.push(row)
    }
    return Array.from(map.values()).sort((a, b) => (b.items[0].session.startedAt || '').localeCompare(a.items[0].session.startedAt || ''))
  }, [visible, group])

  const summary = useMemo(() => {
    const deliveries = rows.filter((r) => normaliseKind(r.session.kind) === 'delivery')
    const talks = new Set(deliveries.map((r) => r.session.talkSlug)).size
    const recorded = deliveries.filter((r) => hasRecordedAudio(r.session)).length
    const live = deliveries.filter((r) => r.live.status === 'live').length
    return { talks, recorded, live }
  }, [rows])

  const rail = useMemo(() => {
    const map = new Map<string, { slug: string; title: string; n: number; latest: string; live: boolean }>()
    for (const row of rows) {
      const cur = map.get(row.session.talkSlug) ?? { slug: row.session.talkSlug, title: row.title, n: 0, latest: '', live: false }
      cur.n += 1
      const started = row.session.startedAt || ''
      if (started && (!cur.latest || started > cur.latest)) {
        cur.latest = started
        cur.live = row.live.status === 'live'
      }
      map.set(row.session.talkSlug, cur)
    }
    return Array.from(map.values()).sort((a, b) => (b.latest || '').localeCompare(a.latest || ''))
  }, [rows])

  const selectedRow = useMemo(() => rows.find((r) => r.session.id === selectedId) ?? null, [rows, selectedId])
  const kindFilterDefault = kinds.delivery && !kinds.rehearsal && !kinds.recording
  const anyFilter = !!(query || hasRecording || liveOnly || talkScope || !kindFilterDefault)

  const openStudio = useCallback((sessionId?: string): void => {
    if (onShowStudio) {
      onShowStudio(sessionId)
      return
    }
    window.dispatchEvent(new CustomEvent('tw-open-studio', { detail: sessionId ? { sessionId } : undefined }))
    onClose()
  }, [onClose, onShowStudio])

  const copyHandout = useCallback(async (row: Row | null): Promise<void> => {
    if (!row?.handoutUrl) { flash('No handout link to copy'); return }
    await navigator.clipboard?.writeText(row.handoutUrl)
    flash('Handout link copied')
  }, [flash])

  const openHandout = useCallback((row: Row | null): void => {
    if (!row?.handoutUrl) { flash('No published handout for this session'); return }
    void window.tw.shell.openExternal(row.handoutUrl)
    flash('Opening handout in your browser')
  }, [flash])

  const recheckOne = useCallback(async (row: Row | null): Promise<void> => {
    if (!row?.handoutUrl) { flash('No published handout to check'); return }
    const res = await checkLive(row.handoutUrl, true)
    flash(`Handout re-checked — ${res.status === 'live' ? 'still live' : 'offline'}`)
  }, [checkLive, flash])

  const recheckAll = useCallback(async (): Promise<void> => {
    const urls = Array.from(new Set(rows.map((r) => r.handoutUrl).filter((u): u is string => !!u)))
    if (!urls.length) { flash('No published handouts to check'); return }
    const results: HistoryLiveCheck[] = []
    for (let start = 0; start < urls.length; start += 6) {
      results.push(...await Promise.all(urls.slice(start, start + 6).map((url) => checkLive(url, true))))
    }
    flash(`${urls.length} handout${urls.length === 1 ? '' : 's'} re-checked · ${results.filter((r) => r.status === 'live').length} still live`)
  }, [rows, checkLive, flash])

  const beginEdit = useCallback((row: Row): void => {
    setMenu(null)
    setKindChoice(null)
    setEditingId(row.session.id)
    setContextDraft(row.session.context ?? '')
  }, [])

  const commitContext = useCallback(async (): Promise<void> => {
    if (!editingId) return
    const row = rows.find((r) => r.session.id === editingId)
    if (!row) { setEditingId(null); return }
    const next = contextDraft.trim()
    if (next !== (row.session.context ?? '')) {
      const res = await window.tw.recording.setContext(row.session.talkSlug, row.session.id, next)
      if (res.ok) {
        setSessions((all) => all.map((s) => s.id === row.session.id ? { ...s, context: next } : s))
        flash('Context updated')
      } else flash('Context could not be updated')
    }
    setEditingId(null)
  }, [editingId, rows, contextDraft, flash])

  const uploadRow = useCallback(async (row: Row | null): Promise<void> => {
    if (!row || !row.session.audio || row.session.audio.uploaded || uploadBusy) return
    setUploadBusy(row.session.id)
    try {
      const res = await window.tw.recording.upload(row.session.talkSlug, row.session.id)
      if (res.ok && res.uploaded) {
        flash('Uploaded to R2')
        await reload()
      } else if (res.error === 'r2-not-configured') flash('Set up R2 first: Settings → Recording storage')
      else if (res.error === 'r2-no-credentials') flash('Add your R2 access keys in Settings → Recording storage')
      else flash('Upload failed — the recording is safe on this Mac')
    } finally {
      setUploadBusy(null)
    }
  }, [uploadBusy, flash, reload])

  const toggleKind = useCallback((kind: RecordingKind): void => {
    setKinds((cur) => {
      const active = KIND_ORDER.filter((k) => cur[k])
      if (cur[kind] && active.length === 1) return cur
      return { ...cur, [kind]: !cur[kind] }
    })
  }, [])

  const changeKind = useCallback(async (row: Row, kind: RecordingKind): Promise<void> => {
    const res = await window.tw.recording.setKind(row.session.talkSlug, row.session.id, kind)
    if (res.ok) {
      setSessions((all) => all.map((s) => s.id === row.session.id ? { ...s, kind: res.kind ?? kind } : s))
      setMenu(null)
      setKindChoice(null)
      flash(`Changed to ${kindLabel(res.kind ?? kind)}`)
    } else flash('Kind could not be changed')
  }, [flash])

  const deleteRow = useCallback(async (row: Row): Promise<void> => {
    const res = await window.tw.recording.deleteSession(row.session.talkSlug, row.session.id)
    if (res.ok) {
      setConfirmDelete(null)
      setMenu(null)
      flash('Recording moved to Trash')
      await reload()
    } else flash('Delete failed — the recording is still here')
  }, [flash, reload])

  const clearFilters = useCallback((): void => {
    setQuery('')
    setHasRecording(false)
    setLiveOnly(false)
    setKinds(DEFAULT_KIND_FILTER)
    setTalkScope(null)
  }, [])

  const cycleGroup = useCallback((): void => {
    const order: GroupMode[] = ['date', 'month', 'talk']
    setGroup((g) => order[(order.indexOf(g) + 1) % order.length])
  }, [])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      const typing = !!target && target.matches('input, textarea, [contenteditable="true"]')
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        e.stopPropagation()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '1') {
        e.preventDefault()
        e.stopPropagation()
        openStudio()
        return
      }
      // ⌘2 = History, and we're already here — consumed as a deliberate no-op so nothing else
      // grabs it (mirrors Studio consuming its own ⌘1).
      if ((e.metaKey || e.ctrlKey) && e.key === '2') {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        e.stopPropagation()
        window.dispatchEvent(new Event('tw-open-settings'))
        return
      }
      if (typing) {
        if (e.key === 'Escape') (target as HTMLElement).blur()
        return
      }
      const key = e.key.toLowerCase()
      if (e.key === '?' || (e.shiftKey && e.key === '/')) { e.preventDefault(); setSheet((s) => !s); return }
      if (e.key === 'Escape') {
        e.preventDefault()
        if (sheet) setSheet(false)
        else if (menu) { setMenu(null); setKindChoice(null); setConfirmDelete(null) }
        else if (settingsOpen) setSettingsOpen(false)
        else onClose()
        return
      }
      if (key === 'i') { setRailOpen((r) => !r); return }
      if (key === 'g') { cycleGroup(); return }
      if (key === 'f') { setHasRecording((v) => !v); return }
      if (key === 'r') { void recheckAll(); return }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (!rowOrder.length) return
        const cur = rowOrder.indexOf(selectedId ?? '')
        const next = e.key === 'ArrowDown' ? Math.min(rowOrder.length - 1, cur + 1) : Math.max(0, cur < 0 ? 0 : cur - 1)
        const id = rowOrder[next]
        setSelectedId(id)
        requestAnimationFrame(() => document.querySelector(`[data-history-sid="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' }))
        return
      }
      if (!selectedRow) return
      if (e.key === 'Enter' && hasRecordedAudio(selectedRow.session)) openStudio(selectedRow.session.id)
      else if (key === 'c') void copyHandout(selectedRow)
      else if (key === 'o') openHandout(selectedRow)
      else if (key === 'l') void recheckOne(selectedRow)
      else if (key === 'e') beginEdit(selectedRow)
      else if (key === 'u' && hasRecordedAudio(selectedRow.session)) void uploadRow(selectedRow)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [isOpen, sheet, menu, settingsOpen, onClose, cycleGroup, rowOrder, selectedId, selectedRow, openStudio, copyHandout, openHandout, recheckOne, recheckAll, beginEdit, uploadRow])

  if (!isOpen) return null

  return (
    <div className="lt twhistory" role="dialog" aria-label="TalkWeaver History" onClick={() => { setMenu(null); setKindChoice(null); setConfirmDelete(null) }}>
      <header className="twh-topbar">
        <div className="twh-brand">
          <span className="twh-wordmark">TalkWeaver</span>
          <span className="twh-room">History</span>
        </div>
        <nav className="twh-viewtabs" aria-label="Tools mode">
          <button onClick={() => openStudio()} title="TalkWeaver Studio — review, trim and manage recordings"><Radio className="lt-icon" /> Studio</button>
          <button className="active" title="TalkWeaver History — every talk you have delivered"><BarChart3 className="lt-icon" /> History</button>
        </nav>
        <div className="twh-top-spacer" />
        <button className="twh-tool twh-plan-button" onClick={() => { setPlanOpen(true); window.setTimeout(() => planEventRef.current?.focus(), 0) }}><Plus className="lt-icon" /> Plan a Run</button>
        <button className="twh-tool" onClick={() => void recheckAll()} title="Re-check every published handout against its live URL"><RefreshCw className="lt-icon" /> Re-check live</button>
        <div className="twh-tool twh-iconbtn" style={{ position: 'relative' }}>
          <button aria-label="History settings" title="History settings" onClick={(e) => { e.stopPropagation(); setSettingsOpen((s) => !s) }}>
            <Settings className="lt-icon" />
          </button>
          {settingsOpen && (
            <div className="twh-pop" onClick={(e) => e.stopPropagation()}>
              <div className="twh-pop-title">History settings</div>
              <div className="twh-pop-sub">A glimpse of Settings → Recording storage. Uploads stay on request.</div>
              <div className="twh-prow"><span>Discard runs under</span><b>{storage ? `${storage.discardSeconds}s` : '—'}</b></div>
              <div className="twh-prow"><span>R2 bucket</span><b>{storage?.bucket || 'not set'}</b></div>
              <div className="twh-prow"><span>Storage endpoint</span><b>{storage?.endpoint || 'not set'}</b></div>
              <div className="twh-pop-foot">{storage?.hasKeys ? 'R2 keys are available.' : 'R2 keys are not configured yet.'}</div>
            </div>
          )}
        </div>
        <button className="twh-tool twh-iconbtn twh-help" aria-label="Keyboard cheat-sheet" title="Keyboard cheat-sheet (?)" onClick={() => setSheet(true)}>?</button>
        <button className="twh-tool twh-iconbtn" aria-label="Close History" title="Close (Esc)" onClick={onClose}><X className="lt-icon" /></button>
      </header>

      <div className="twh-searchrow">
        <div className="twh-searchbar">
          <label className="twh-searchfield">
            <Search className="lt-icon" />
            <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search delivered talks, context or dates…" aria-label="Search History" />
            <kbd>⌘F</kbd>
          </label>
          <span className="twh-result-count">{visible.length}{anyFilter ? ` of ${rows.length}` : ''} session{visible.length === 1 ? '' : 's'}</span>
          <div className="twh-summary">
            <span><b>{summary.talks}</b> talks delivered</span>
            <span className="twh-sdot" />
            <span><b>{summary.recorded}</b> recorded</span>
            <span className="twh-sdot" />
            <span><b>{summary.live}</b> still live</span>
          </div>
        </div>
        <div className="twh-filters">
          <span className="twh-flabel">Filter</span>
          {KIND_ORDER.map((kind) => (
            <button key={kind} className={`twh-chip kind ${kind} ${kinds[kind] ? 'on' : ''}`} onClick={() => toggleKind(kind)}>
              <Tag className="lt-icon" /> {kindLabel(kind)}<X className="lt-icon x" />
            </button>
          ))}
          <button className={`twh-chip ${hasRecording ? 'on' : ''}`} onClick={() => setHasRecording((v) => !v)}><Radio className="lt-icon" /> Has recording<X className="lt-icon x" /></button>
          <button className={`twh-chip ${liveOnly ? 'on' : ''}`} onClick={() => setLiveOnly((v) => !v)}><RefreshCw className="lt-icon" /> Handout still live<X className="lt-icon x" /></button>
          {talkScope && (
            <button className="twh-chip on" onClick={() => setTalkScope(null)}><FileText className="lt-icon" /> Talk: {rail.find((r) => r.slug === talkScope)?.title ?? talkScope}<X className="lt-icon x" /></button>
          )}
          <button className={`twh-chip clear ${anyFilter ? 'show' : ''}`} onClick={clearFilters}><X className="lt-icon" /> Clear filters</button>
          <div className="twh-fspacer" />
          <div className="twh-segwrap"><span>Sort</span><div className="twh-seg">{(['newest', 'talk', 'length'] as SortMode[]).map((s) => <button key={s} className={sort === s ? 'active' : ''} onClick={() => setSort(s)}>{s === 'newest' ? 'Newest' : s === 'talk' ? 'Talk' : 'Length'}</button>)}</div></div>
          <div className="twh-segwrap"><span>Group</span><div className="twh-seg">{(['date', 'month', 'talk'] as GroupMode[]).map((g) => <button key={g} className={group === g ? 'active' : ''} onClick={() => setGroup(g)}>{g === 'date' ? 'Date' : g === 'month' ? 'Month' : 'Talk'}</button>)}</div></div>
        </div>
      </div>

      <div className="twh-body">
        <button className={`twh-rail-reopen ${railOpen ? '' : 'show'}`} onClick={() => setRailOpen(true)} title="Show talks index (I)"><PanelLeftOpen className="lt-icon" /></button>
        <aside className={`twh-rail ${railOpen ? '' : 'collapsed'}`}>
          <div className="twh-rail-head">
            <span>Index — Talks delivered</span>
            <button onClick={() => setRailOpen(false)} title="Collapse index (I)"><PanelLeftClose className="lt-icon" /></button>
          </div>
          <div className="twh-rail-note">The green dot marks a talk whose most recent handout is still live. Click a talk to scope the ledger to it.</div>
          {rail.map((talk) => (
            <button key={talk.slug} className={`twh-talk-row ${talkScope === talk.slug ? 'active' : ''}`} onClick={() => setTalkScope((s) => s === talk.slug ? null : talk.slug)} title={talk.title}>
              <span className={`tdot ${talk.live ? '' : 'off'}`} />
              <span className="t-name">{talk.title}</span>
              <span className="t-count">{talk.n}</span>
            </button>
          ))}
        </aside>

        <div className="twh-ledger-wrap">
          <section className="twh-planned-wrap" aria-label="Planned Runs">
            <div className="twh-section-label"><span>Planned</span><i /><small>{planned.length} upcoming</small></div>
            <div className="twh-planned-table">
              <div className="twh-plan-grid head"><span>Date</span><span>Event / audience</span><span>Slide set</span><span /></div>
              {planned.map((run) => {
                const set = run.slideSet ?? (run.pathwayId ? { kind: 'pathway' as const, pathwayId: run.pathwayId } : { kind: 'full' as const })
                const pathwayName = set.kind === 'pathway' ? planPathways.find((pathway) => pathway.id === set.pathwayId)?.name ?? set.pathwayId : ''
                return (
                  <div className="twh-plan-grid" key={run.id} data-planned-run={run.id}>
                    <span className="twh-plan-date"><b>{run.plannedDate ? new Date(`${run.plannedDate}T12:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '—'}</b><small>{relativePlannedDate(run.plannedDate)}</small></span>
                    <span className="twh-plan-event"><b>{run.eventTitle || run.talkTitle}</b>{run.audience && <small> · {run.audience}</small>}</span>
                    <span><span className={`twh-slide-set ${set.kind}`}>{set.kind === 'full' ? '▣ Full talk' : `◇ ${pathwayName}`}</span></span>
                    <span className="twh-plan-actions"><details><summary aria-label="Planned Run actions">•••</summary><div><button onClick={() => void presentPlanned(run)}><Play className="lt-icon" /> Present</button><button onClick={() => beginEditPlanned(run)}><Pencil className="lt-icon" /> Edit</button><button className="danger" onClick={() => void removePlanned(run)}><Trash2 className="lt-icon" /> Delete</button></div></details></span>
                  </div>
                )
              })}
              {planOpen && (
                <div className="twh-plan-add" data-plan-run-form>
                  <label><span>Talk</span><select value={planTalk} onChange={(event) => { setPlanTalk(event.target.value); setPlanSlideSet('full') }}>{Object.entries(handouts).map(([slug, talk]) => <option value={slug} key={slug}>{talk.title}</option>)}</select></label>
                  <label><span>Date</span><input type="date" value={planDate} onChange={(event) => setPlanDate(event.target.value)} /></label>
                  <label><span>Event / audience</span><input ref={planEventRef} value={planEvent} onChange={(event) => setPlanEvent(event.target.value)} placeholder="e.g. Agents for researchers day" /><input value={planAudience} onChange={(event) => setPlanAudience(event.target.value)} placeholder="Audience" /></label>
                  <label><span>Slide set</span><select value={planSlideSet} onChange={(event) => setPlanSlideSet(event.target.value)}><option value="full">▣ Full talk</option>{planPathways.map((pathway) => <option value={pathway.id} key={pathway.id}>◇ {pathway.name}</option>)}</select></label>
                  <button className="twh-btn primary" disabled={planBusy} onClick={() => void submitPlan()}>{planBusy ? 'Saving…' : editingPlanId ? 'Save' : 'Add'}</button>
                </div>
              )}
            </div>
          </section>
          <div className="twh-section-label delivered"><span>Delivered</span><i /><small>latest first</small></div>
          <div className="twh-ledger-head">
            <div>Date</div><div>Event / audience</div><div>Slide set</div><div>Handout</div>
          </div>
          <div className="twh-scroll">
            {rows.length === 0 ? (
              <EmptyNone openStudio={() => openStudio()} openSheet={() => setSheet(true)} />
            ) : visible.length === 0 ? (
              <EmptyFilter clearFilters={clearFilters} />
            ) : (
              <div className="twh-ledger">
                {grouped.map((g) => (
                  <div className="twh-group" key={g.name + g.when}>
                    <div className="twh-group-head"><span className="g-name">{g.name}</span>{g.when && <span className="g-when">{g.when}</span>}<span className="g-count">{g.items.length} {g.items.length === 1 ? 'talk' : 'talks'}</span></div>
                    {g.items.map((row, i) => (
                      <HistoryEntry
                        key={row.session.id}
                        row={row}
                        index={i}
                        selected={selectedId === row.session.id}
                        editing={editingId === row.session.id}
                        contextDraft={contextDraft}
                        uploadBusy={uploadBusy === row.session.id}
                        onSelect={() => setSelectedId(row.session.id)}
                        onOpenStudio={() => openStudio(row.session.id)}
                        onBeginEdit={() => beginEdit(row)}
                        onDraft={setContextDraft}
                        onCommit={() => void commitContext()}
                        onCopy={() => void copyHandout(row)}
                        onOpenHandout={() => openHandout(row)}
                        onRecheck={() => void recheckOne(row)}
                        onUpload={() => void uploadRow(row)}
                        onMenu={(x, y) => { setSelectedId(row.session.id); setMenu({ id: row.session.id, x, y }); setKindChoice(null); setConfirmDelete(null) }}
                      />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="twh-hintbar">
        <span><kbd>↑</kbd><kbd>↓</kbd> <b>move</b></span>
        <span><kbd>↵</kbd> <b>open in Studio</b></span>
        <span><kbd>C</kbd> <b>copy handout</b></span>
        <span><kbd>O</kbd> <b>open handout</b></span>
        <span><kbd>G</kbd> <b>cycle grouping</b></span>
        <span className="push" />
        <span><kbd>?</kbd> <b>cheat-sheet</b></span>
      </div>

      {menu && selectedRow && (
        <div className="twh-menu open" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {confirmDelete === selectedRow.session.id ? (
            <div className="twh-confirm">
              <p>Delete this session?</p>
              <button className="danger" onClick={() => void deleteRow(selectedRow)}>Delete</button>
              <button onClick={() => setConfirmDelete(null)}>Cancel</button>
            </div>
          ) : kindChoice === selectedRow.session.id ? (
            <div className="twh-confirm twh-kind-choice">
              <p>Change kind</p>
              {KIND_ORDER.map((kind) => (
                <button
                  key={kind}
                  className={normaliseKind(selectedRow.session.kind) === kind ? 'active' : ''}
                  onClick={() => void changeKind(selectedRow, kind)}
                >
                  <Tag className="lt-icon" /> {kindLabel(kind)}
                </button>
              ))}
              <button onClick={() => setKindChoice(null)}>Cancel</button>
            </div>
          ) : (
            <>
              {hasRecordedAudio(selectedRow.session) && (
                <button onClick={() => openStudio(selectedRow.session.id)}><Play className="lt-icon" /> Open in Studio</button>
              )}
              <button onClick={() => { setDetailId(selectedRow.session.id); setMenu(null) }}><FileText className="lt-icon" /> Run details</button>
              {selectedRow.handoutUrl
                ? <button onClick={() => void unpublishRunHandout(selectedRow)}><Trash2 className="lt-icon" /> Unpublish Run handout</button>
                : <button onClick={() => void publishRunHandout(selectedRow)}><UploadCloud className="lt-icon" /> Publish handout for this Run</button>}
              <button onClick={() => void copyHandout(selectedRow)}><Copy className="lt-icon" /> Copy link</button>
              <button onClick={() => openHandout(selectedRow)}><ExternalLink className="lt-icon" /> Open handout</button>
              <button onClick={() => void recheckOne(selectedRow)}><RefreshCw className="lt-icon" /> Re-check</button>
              <button onClick={() => beginEdit(selectedRow)}><Pencil className="lt-icon" /> Edit context</button>
              <button onClick={() => setKindChoice(selectedRow.session.id)}><Tag className="lt-icon" /> Change kind…</button>
              <div className="msep" />
              <button className="danger" onClick={() => setConfirmDelete(selectedRow.session.id)}><Trash2 className="lt-icon" /> Delete…</button>
            </>
          )}
        </div>
      )}

      {detailRow && (
        <div className="twh-run-detail" role="dialog" aria-label={`Run · ${detailRow.session.eventTitle ?? detailRow.title}`}>
          <header><span>History <small>Run · {detailRow.session.eventTitle ?? detailRow.title} · {detailRow.session.plannedDate ?? fmtDate(detailRow.session.startedAt).mon}</small></span><button onClick={() => setDetailId(null)}>Back to list <kbd>⌘[</kbd></button></header>
          <div className="twh-run-detail-body">
            <div className="twh-talkbar"><b>{detailRow.title}</b><span className="badge-ever">✦ EVERGREEN handout</span>{detailRow.evergreenUrl ? <button onClick={() => void window.tw.shell.openExternal(detailRow.evergreenUrl!)}>{displayUrl(detailRow.evergreenUrl)}</button> : <span className="muted">not published</span>}<small>the talk’s canonical latest-full-talk link · Run handouts never touch it</small></div>
            <section className="twh-run-card">
              <div className="twh-run-head"><span className={`twh-slide-set ${detailRow.session.slideSet?.kind ?? (detailRow.session.pathwayId ? 'pathway' : 'full')}`}>{detailRow.session.slideSet?.kind === 'pathway' || detailRow.session.pathwayId ? `◇ ${detailRow.session.slideSet?.kind === 'pathway' ? detailRow.session.slideSet.pathwayId : detailRow.session.pathwayId}` : '▣ Full talk'}</span><b>{detailRow.session.eventTitle ?? detailRow.title}</b><span>· {[detailRow.session.audience, detailRow.session.plannedDate].filter(Boolean).join(' · ')}</span></div>
              <div className="twh-run-handout-line"><b>Run handout</b>{detailRow.handoutUrl ? <><span className="badge-run">RUN</span><button className="url" onClick={() => openHandout(detailRow)}>{displayUrl(detailRow.handoutUrl)}</button><span className="push" /><button className="twh-btn" onClick={() => void copyHandout(detailRow)}>Copy URL</button><button className="twh-btn" disabled={handoutBusy} onClick={() => void unpublishRunHandout(detailRow)}>Unpublish</button></> : <><span className="muted">Not yet published</span><span className="push" /><button className="twh-btn primary" disabled={handoutBusy} onClick={() => void publishRunHandout(detailRow)}>{handoutBusy ? 'Publishing…' : 'Publish handout for this Run'}</button></>}</div>
              <p>Built from this Run’s slide set · title and event printed on the cover · own URL, listed here only</p>
            </section>
          </div>
        </div>
      )}

      {sheet && <CheatSheet onClose={() => setSheet(false)} />}
      {toast && <div className="twh-toast show"><Check className="lt-icon" /><span>{toast}</span></div>}
    </div>
  )
}

function HistoryEntry(props: {
  row: Row
  index: number
  selected: boolean
  editing: boolean
  contextDraft: string
  uploadBusy: boolean
  onSelect: () => void
  onOpenStudio: () => void
  onBeginEdit: () => void
  onDraft: (v: string) => void
  onCommit: () => void
  onCopy: () => void
  onOpenHandout: () => void
  onRecheck: () => void
  onUpload: () => void
  onMenu: (x: number, y: number) => void
}): JSX.Element {
  const { row, index, selected, editing, contextDraft, uploadBusy } = props
  const f = fmtDate(row.session.startedAt)
  const delta = deltaOf(row.session)
  const recorded = hasRecordedAudio(row.session)
  const kind = normaliseKind(row.session.kind)
  return (
    <div
      className={`twh-entry ${selected ? 'selected' : ''}`}
      style={{ ['--i' as string]: index }}
      data-history-sid={row.session.id}
      onClick={props.onSelect}
    >
      <button
        className="twh-kebab"
        title="More actions"
        onClick={(e) => {
          e.stopPropagation()
          const r = e.currentTarget.getBoundingClientRect()
          props.onMenu(Math.max(8, r.right - 212), Math.min(window.innerHeight - 270, r.bottom + 4))
        }}
      >
        <MoreVertical className="lt-icon" />
      </button>
      <div className="twh-cell twh-stamp">
        <span className="dow">{f.dow}</span>
        <span className="dnum">{f.day || '—'} <small>{f.mon}</small></span>
        <span className="dtime">{f.time}</span>
        <span className="dyear">{f.year || ''}</span>
      </div>
      <div className="twh-cell twh-talk">
        <div className="tk-title-line">
          <div className="tk-title">{row.session.eventTitle || row.title}</div>
          <span className={`twh-kind-tag ${kind}`}><Tag className="lt-icon" />{kindLabel(kind)}</span>
        </div>
        <div className="tk-ctx">
          {editing ? (
            <input
              className="ctx-input"
              value={contextDraft}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => props.onDraft(e.target.value)}
              onBlur={props.onCommit}
              onKeyDown={(e) => { if (e.key === 'Enter') props.onCommit() }}
            />
          ) : (
            <>
              <span className="ctx-text">{row.session.audience ? `· ${row.session.audience}` : row.session.context || row.title}</span>
              <button className="ctx-edit" title="Edit context (E)" onClick={(e) => { e.stopPropagation(); props.onBeginEdit() }}><Pencil className="lt-icon" /></button>
            </>
          )}
        </div>
      </div>
      <div className="twh-cell twh-rec">
        <span className={`twh-slide-set ${row.session.slideSet?.kind ?? (row.session.pathwayId ? 'pathway' : 'full')}`}>{row.session.slideSet?.kind === 'pathway' || row.session.pathwayId ? `◇ ${row.session.slideSet?.kind === 'pathway' ? row.session.slideSet.pathwayId : row.session.pathwayId}` : '▣ Full talk'}</span>
        <div className="rec-line">
          <span className={`wave ${recorded ? '' : 'muted'}`}>
            {recorded
              ? waveBars(row.session).map((h, i) => <span key={i} style={{ height: h }} />)
              : <VolumeX className="lt-icon" />}
          </span>
          {recorded ? (
            <>
              <span className="rec-len">{fmtMins(deliveredMs(row.session))}</span>
              {row.session.trims?.length ? <span className="rec-raw">raw {fmtMins(row.session.recordingMs)}</span> : null}
            </>
          ) : (
            <>
              <span className="rec-none">not recorded</span>
              <span className="rec-len">{fmtMins(row.session.wallClockMs)} delivered</span>
            </>
          )}
          {row.session.timerTargetMin ? <span className="rec-plan">planned {row.session.timerTargetMin}m</span> : null}
          {delta ? <span className={`rec-delta ${delta.cls}`}>{delta.text}</span> : null}
        </div>
        {recorded && (
          <>
            <button className="studio-link" onClick={(e) => { e.stopPropagation(); props.onOpenStudio() }}><Play className="lt-icon" /> Open in Studio</button>
            {row.session.audio?.uploaded ? (
              <span className="upl r2"><Check className="lt-icon" /> in R2</span>
            ) : (
              <span className="upl local"><HardDrive className="lt-icon" /> on this Mac <button onClick={(e) => { e.stopPropagation(); props.onUpload() }}>{uploadBusy ? 'Uploading…' : 'Upload'}</button></span>
            )}
          </>
        )}
      </div>
      <div className="twh-cell twh-ho">
        {row.handoutUrl ? (
          <>
            <div className="ho-line">
              <span className="badge-run">RUN</span>
              <button className="ho-url" title={row.handoutUrl} onClick={(e) => { e.stopPropagation(); props.onOpenHandout() }}>{displayUrl(row.handoutUrl)}</button>
              <button className="ho-ico" title="Copy handout link (C)" onClick={(e) => { e.stopPropagation(); props.onCopy() }}><Copy className="lt-icon" /></button>
              <button className="ho-ico" title="Open handout in browser (O)" onClick={(e) => { e.stopPropagation(); props.onOpenHandout() }}><ExternalLink className="lt-icon" /></button>
            </div>
            <LiveBadge live={row.live} onRecheck={props.onRecheck} />
          </>
        ) : (
          <>
            <span className="ho-none">no handout published</span>
            <LiveBadge live={row.live} onRecheck={props.onRecheck} />
          </>
        )}
      </div>
    </div>
  )
}

function LiveBadge({ live, onRecheck }: { live: LiveUi; onRecheck: () => void }): JSX.Element {
  if (live.status === 'checking') return <span className="live-badge checking"><span className="dot" />checking…</span>
  if (live.status === 'unpub') return <span className="live-badge unpub"><span className="dot" />not published</span>
  return (
    <>
      <span className={`live-badge ${live.status}`}><span className="dot" />{live.status === 'live' ? 'still live' : 'offline'}</span>
      <span className="ho-checked">checked {checkedAgo(live.checkedAt)}<button onClick={(e) => { e.stopPropagation(); onRecheck() }}>re-check</button></span>
    </>
  )
}

function EmptyNone({ openStudio, openSheet }: { openStudio: () => void; openSheet: () => void }): JSX.Element {
  return (
    <div className="twh-empty show">
      <div className="e-frame"><HistoryIcon className="lt-icon" /></div>
      <h3>No presentations recorded yet</h3>
      <p>When you deliver a talk, record a run in the presenter. Every delivery lands here as a dated entry with its recording, published handout, and live status.</p>
      <div className="e-actions">
        <button className="twh-btn primary" onClick={openStudio}><Play className="lt-icon" /> Open Studio</button>
        <button className="twh-btn" onClick={openSheet}>?</button>
      </div>
    </div>
  )
}

function EmptyFilter({ clearFilters }: { clearFilters: () => void }): JSX.Element {
  return (
    <div className="twh-empty show">
      <div className="e-frame"><Search className="lt-icon" /></div>
      <h3>No talks match these filters</h3>
      <p>Nothing in the ledger meets the current search and filter set. Loosen a filter to see more of what you have delivered.</p>
      <div className="e-actions"><button className="twh-btn" onClick={clearFilters}><X className="lt-icon" /> Clear filters</button></div>
    </div>
  )
}

function CheatSheet({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <div className="twh-scrim open" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="twh-panel">
        <div className="twh-panel-head">
          <h2>Keyboard cheat-sheet</h2>
          <span>every click has a key</span>
          <button onClick={onClose} aria-label="Close"><X className="lt-icon" /></button>
        </div>
        <div className="twh-cs-groups">
          <SheetGroup title="Everywhere" rows={[['TalkWeaver Studio', '⌘1'], ['TalkWeaver History', '⌘2'], ['Settings', '⌘,'], ['This cheat-sheet', '?'], ['Close / step back out', 'Esc']]} />
          <SheetGroup title="History — moving about" rows={[['Move through the ledger', '↑ ↓'], ['Search field', '⌘F'], ['Collapse / show talks index', 'I'], ['Cycle grouping', 'G'], ['Filter: has recording', 'F']]} />
          <SheetGroup title="History — a run" rows={[['Open audio run in Studio', '↵'], ['Copy handout link', 'C'], ['Open handout', 'O'], ['Re-check if still live', 'L'], ['Edit context label', 'E'], ['Upload local audio', 'U']]} />
          <SheetGroup title="Recording (in the presenter)" rows={[['Start / stop recording', '⇧R'], ['Pause / resume', '⇧P'], ['Save run to History', 'L']]} />
          <SheetGroup title="Handout status" rows={[['Re-check every handout', 'R'], ['Copy selected handout', 'C']]} />
          <div className="twh-cs-group"><h3>Reserved</h3><div className="twh-cs-row muted">Feedback fills in once the live-audience feature ships.</div></div>
        </div>
      </div>
    </div>
  )
}

function SheetGroup({ title, rows }: { title: string; rows: Array<[string, string]> }): JSX.Element {
  return (
    <div className="twh-cs-group">
      <h3>{title}</h3>
      {rows.map(([label, key]) => (
        <div className="twh-cs-row" key={label}>{label}<span className="keys">{key.split(' ').map((k) => <kbd key={k}>{k}</kbd>)}</span></div>
      ))}
    </div>
  )
}
