import { useEffect, useMemo, useRef, useState } from 'react'
import { History, RotateCcw, Search } from 'lucide-react'
import type { BackupSettings, SettingsChangeEntry, TimerSettings, TranscriptionSettings } from '../../../preload/index'
import { EDITOR_COMMANDS, displayKeys } from '../keymap/registry'
import {
  readOverrides,
  setOverride,
  clearOverride,
  clearAllOverrides,
  effectiveKeys,
  eventToCMKey,
  KEYMAP_CHANGED_EVENT
} from '../keymap/store'
import { notify } from '../lib/notify'

interface Props {
  isOpen: boolean
  onClose: () => void
  /** Current vault root (shown read-only). */
  vaultRoot: string
  /** Open the system folder picker for the vault and reload talks (lives in App). */
  onChangeVault: () => void | Promise<void>
}

type Paths = {
  vaultRoot: string | null
  archiveRoot: string | null
  archiveDefault: string | null
  archiveAvailable: boolean
}

// One Settings modal (⌘,). Two jobs: the folders the app reads from, and customising the editor
// keyboard shortcuts. Shortcut edits persist to localStorage and re-bind the editor live (the
// Editor listens for KEYMAP_CHANGED_EVENT) — no reload, no drift with the help popup.
//
// Gate-5 additions (v0.15): settings are SEARCHABLE (the box under the title filters sections,
// and shortcut rows by label), and every change is RECORDED in the per-machine settings
// changelog (old → new + when), shown in the Changes section with a per-entry Reset. Secrets
// (tokens, access keys) are logged as presence only — never their values — and have no Reset.

// Sections the search box matches against: id → searchable keyword blob (title + contents).
const SECTION_KEYWORDS: Record<string, string> = {
  folders: 'folders vault root image archive powerpoint',
  backup: 'presentation backup onedrive dropbox folder interval check every back up now',
  timer: 'timer presenter clock amber dark warning minutes warn urgent',
  publishing: 'publishing cloudflare pages handout account id project custom domain short urls api token wrangler',
  recording: 'recording storage r2 s3 endpoint bucket credentials bitwarden secrets keychain access keys discard seconds',
  transcription: 'transcription parakeet python script ffmpeg speech to text runs',
  shortcuts: 'keyboard shortcuts keys chord bindings reset all',
  changes: 'changes changelog history recent settings log reset undo'
}
type SectionId = keyof typeof SECTION_KEYWORDS

// Sentinel display values for unset folder settings (also drive the Reset applier).
const NOT_SET = '(not set)'
const AUTO = '(auto)'

export default function SettingsPanel({ isOpen, onClose, vaultRoot, onChangeVault }: Props) {
  const [paths, setPaths] = useState<Paths | null>(null)
  // Presentation backup settings + a "backing up now" flag for the manual button.
  const [backup, setBackup] = useState<BackupSettings | null>(null)
  const [backingUp, setBackingUp] = useState(false)
  // Presenter clock amber/dark-amber thresholds — the Settings global default (a deck's own
  // frontmatter warn-at:/urgent-at: overrides these per-talk).
  const [timer, setTimer] = useState<TimerSettings | null>(null)
  // Cloudflare publishing config (token is write-only here — we only ever learn hasToken).
  const [pub, setPub] = useState<{
    accountId: string
    project: string
    baseUrl: string
    useShortIds: boolean
    hasToken: boolean
  } | null>(null)
  const [tokenInput, setTokenInput] = useState('')
  const [pubSaved, setPubSaved] = useState(false)
  // Settings search (Gate-5): filters sections (and shortcut rows) by keyword.
  const [sq, setSq] = useState('')
  // The settings changelog — every change on this machine, newest first (null = loading).
  const [changes, setChanges] = useState<SettingsChangeEntry[] | null>(null)
  // Baselines for blur/save-time diffing: the last values READ from the main process, so a
  // change can be logged as old → new even after the controlled inputs already hold the new text.
  const pubBaseRef = useRef<{ accountId: string; project: string; baseUrl: string; useShortIds: boolean } | null>(null)
  const recBaseRef = useRef<{ endpoint: string; bucket: string; credsSource: 'bws' | 'settings'; bwsSecretId: string; discardSeconds: number } | null>(null)
  const trBaseRef = useRef<{ python: string; script: string; ffmpeg: string } | null>(null)
  const timerBaseRef = useRef<TimerSettings | null>(null)

  // Record one settings change into the per-machine changelog (no-op when nothing changed).
  const record = (key: string, label: string, from: string, to: string): void => {
    if (from === to) return
    void window.tw.settings.logChange({ key, label, from, to }).then(setChanges).catch(() => {})
  }

  const refreshPub = (): void => {
    window.tw.publish.getConfig().then((p) => {
      setPub(p)
      pubBaseRef.current = { accountId: p.accountId, project: p.project, baseUrl: p.baseUrl, useShortIds: p.useShortIds }
    }).catch(() => setPub(null))
  }
  // Diff the current publishing draft against the last-read baseline and log each changed field.
  const recordPubDiff = (next: { accountId: string; project: string; baseUrl: string; useShortIds: boolean }): void => {
    const base = pubBaseRef.current
    if (!base) return
    record('publish.accountId', 'Publishing — account ID', base.accountId, next.accountId)
    record('publish.project', 'Publishing — Pages project', base.project, next.project)
    record('publish.baseUrl', 'Publishing — custom domain', base.baseUrl, next.baseUrl)
    record('publish.useShortIds', 'Publishing — short URLs', base.useShortIds ? 'on' : 'off', next.useShortIds ? 'on' : 'off')
  }
  // Publishing text fields persist on blur. The Short-URLs toggle already saved immediately, so
  // account/project/domain edits abandoned without the explicit Save button were silently lost.
  const persistPub = (): void => {
    if (!pub) return
    const next = { accountId: pub.accountId, project: pub.project, baseUrl: pub.baseUrl, useShortIds: pub.useShortIds }
    recordPubDiff(next)
    void window.tw.publish.setConfig(next).then(refreshPub)
  }
  // Recording storage (ADR-0035): where presenter recordings upload. Access keys are write-only
  // here — we only ever learn hasKeys (the keys live OS-keychain-encrypted in the main process).
  const [rec, setRec] = useState<{
    endpoint: string
    bucket: string
    credsSource: 'bws' | 'settings'
    bwsSecretId: string
    discardSeconds: number
    hasKeys: boolean
  } | null>(null)
  const [recKeyId, setRecKeyId] = useState('')
  const [recKeySecret, setRecKeySecret] = useState('')
  const [recSaved, setRecSaved] = useState(false)
  const refreshRec = (): void => {
    window.tw.recording.getStorage().then((r) => {
      setRec(r)
      recBaseRef.current = {
        endpoint: r.endpoint, bucket: r.bucket, credsSource: r.credsSource,
        bwsSecretId: r.bwsSecretId, discardSeconds: r.discardSeconds
      }
    }).catch(() => setRec(null))
  }
  // Transcription engine paths (non-secret): the local speech-to-text skill Python + script.
  const [transcription, setTranscription] = useState<TranscriptionSettings | null>(null)
  const [transcriptionSaved, setTranscriptionSaved] = useState(false)
  const refreshTranscription = (): void => {
    window.tw.settings.getTranscription().then((t) => {
      setTranscription(t)
      trBaseRef.current = { python: t.python, script: t.script, ffmpeg: t.ffmpeg }
    }).catch(() => setTranscription(null))
  }
  // Bumped whenever overrides change, to re-render the shortcut rows from the live store.
  const [, setTick] = useState(0)
  // Command currently capturing a new chord, or null.
  const [capturingId, setCapturingId] = useState<string | null>(null)

  const refreshPaths = (): void => {
    window.tw.settings
      .getPaths()
      .then(setPaths)
      .catch(() => setPaths(null))
  }
  const refreshBackup = (): void => {
    window.tw.settings
      .getBackup()
      .then(setBackup)
      .catch(() => setBackup(null))
  }
  const refreshTimer = (): void => {
    window.tw.settings
      .getTimer()
      .then(setTimer)
      .catch(() => setTimer(null))
  }

  useEffect(() => {
    if (!isOpen) return
    setCapturingId(null)
    setTokenInput('') // never carry a half-typed token across opens (write-only field)
    setRecKeyId('')
    setRecKeySecret('')
    setSq('')
    window.tw.settings.getChangelog().then(setChanges).catch(() => setChanges([]))
    refreshPaths()
    refreshBackup()
    refreshTimer()
    refreshPub()
    refreshRec()
    refreshTranscription()
    // Live status pushes while a sweep runs (the timer or the manual button).
    const unsub = window.tw.backup.onStatus((run) => setBackup((b) => (b ? { ...b, lastRun: run } : b)))
    const onChanged = (): void => setTick((t) => t + 1)
    window.addEventListener(KEYMAP_CHANGED_EVENT, onChanged)
    return () => {
      window.removeEventListener(KEYMAP_CHANGED_EVENT, onChanged)
      unsub()
    }
  }, [isOpen])

  // While capturing, the NEXT keydown becomes the new chord (Escape cancels). Capture-phase +
  // stopPropagation so the keystroke never reaches the editor or the global shortcuts.
  useEffect(() => {
    if (!capturingId) return
    function onKey(e: KeyboardEvent): void {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setCapturingId(null)
        return
      }
      const cm = eventToCMKey(e)
      if (!cm) return // a modifier pressed alone — keep waiting
      const id = capturingId!
      const old = effectiveKeys(id)
      setOverride(id, cm)
      const label = EDITOR_COMMANDS.find((c) => c.id === id)?.label ?? id
      record(`keys.${id}`, `Shortcut — ${label}`, old, cm)
      setCapturingId(null)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [capturingId])

  // Close on Escape when NOT mid-capture (capture consumes Escape itself).
  useEffect(() => {
    if (!isOpen) return
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape' && !capturingId) {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [isOpen, capturingId, onClose])

  // Group commands by category, preserving registry order, and flag chord collisions.
  const groups = useMemo(() => {
    readOverrides() // touch so this recomputes when tick changes (deps below)
    const order: string[] = []
    const map = new Map<string, typeof EDITOR_COMMANDS>()
    for (const c of EDITOR_COMMANDS) {
      if (!map.has(c.category)) {
        map.set(c.category, [])
        order.push(c.category)
      }
      ;(map.get(c.category) as typeof EDITOR_COMMANDS).push(c)
    }
    return order.map((cat) => ({ cat, cmds: map.get(cat) as typeof EDITOR_COMMANDS }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, capturingId])

  // Which effective chords are bound more than once (so we can warn).
  const duplicates = useMemo(() => {
    const seen = new Map<string, number>()
    for (const c of EDITOR_COMMANDS) {
      const k = effectiveKeys(c.id)
      seen.set(k, (seen.get(k) ?? 0) + 1)
    }
    const dup = new Set<string>()
    for (const [k, n] of seen) if (n > 1) dup.add(k)
    return dup
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, capturingId])

  // Which changelog entries carry a usable per-entry Reset. Secrets (presence-only logs) and
  // one-way acts (reset-all, folder picks that can only be re-chosen via the OS dialog) don't.
  function canReset(en: SettingsChangeEntry): boolean {
    if (en.key === 'keys.reset-all') return false // one-way: the old per-command chords are gone
    if (en.key === 'backup.enabled' || en.key === 'backup.intervalMin') return true
    if (en.key === 'backup.folder') return en.from === NOT_SET
    if (en.key === 'archive.folder') return en.from === AUTO
    if (en.key === 'timer.warnAtMinutes' || en.key === 'timer.urgentAtMinutes') return true
    if (en.key.startsWith('publish.') && en.key !== 'publish.token') return true
    if (en.key.startsWith('recording.') && en.key !== 'recording.keys') return true
    if (en.key.startsWith('transcription.')) return true
    if (en.key.startsWith('keys.')) return true
    return false
  }

  // Per-entry Reset: re-apply the entry's OLD value through the same setter the section uses.
  // The reset is itself recorded (new → old), so the trail stays honest.
  async function resetEntry(en: SettingsChangeEntry): Promise<void> {
    const v = en.from
    try {
      if (en.key === 'backup.enabled') setBackup(await window.tw.settings.setBackup({ enabled: v === 'on' }))
      else if (en.key === 'backup.intervalMin') setBackup(await window.tw.settings.setBackup({ intervalMin: Number(v) }))
      else if (en.key === 'backup.folder' && v === NOT_SET) setBackup(await window.tw.settings.clearBackupFolder())
      else if (en.key === 'archive.folder' && v === AUTO) { await window.tw.settings.clearArchive(); refreshPaths() }
      else if (en.key === 'timer.warnAtMinutes') setTimer(await window.tw.settings.setTimer({ warnAtMinutes: Number(v) }))
      else if (en.key === 'timer.urgentAtMinutes') setTimer(await window.tw.settings.setTimer({ urgentAtMinutes: Number(v) }))
      else if (en.key.startsWith('publish.')) {
        const cur = await window.tw.publish.getConfig()
        const next = { accountId: cur.accountId, project: cur.project, baseUrl: cur.baseUrl, useShortIds: cur.useShortIds }
        const field = en.key.slice('publish.'.length)
        if (field === 'useShortIds') next.useShortIds = v === 'on'
        else if (field === 'accountId' || field === 'project' || field === 'baseUrl') next[field] = v
        else throw new Error('unknown publish field')
        await window.tw.publish.setConfig(next)
        refreshPub()
      } else if (en.key.startsWith('recording.')) {
        const cur = await window.tw.recording.getStorage()
        const next = {
          endpoint: cur.endpoint, bucket: cur.bucket, credsSource: cur.credsSource,
          bwsSecretId: cur.bwsSecretId, discardSeconds: cur.discardSeconds
        }
        const field = en.key.slice('recording.'.length)
        if (field === 'discardSeconds') next.discardSeconds = Number(v)
        else if (field === 'credsSource') next.credsSource = v === 'bws' ? 'bws' : 'settings'
        else if (field === 'endpoint' || field === 'bucket' || field === 'bwsSecretId') next[field] = v
        else throw new Error('unknown recording field')
        await window.tw.recording.setStorage(next)
        refreshRec()
      } else if (en.key.startsWith('transcription.')) {
        const cur = await window.tw.settings.getTranscription()
        const next = { python: cur.python, script: cur.script, ffmpeg: cur.ffmpeg }
        const field = en.key.slice('transcription.'.length)
        if (field === 'python' || field === 'script' || field === 'ffmpeg') next[field] = v
        else throw new Error('unknown transcription field')
        await window.tw.settings.setTranscription(next)
        refreshTranscription()
      } else if (en.key.startsWith('keys.')) {
        const id = en.key.slice('keys.'.length)
        const def = EDITOR_COMMANDS.find((c) => c.id === id)?.keys
        if (v === def) clearOverride(id)
        else setOverride(id, v)
      } else {
        notify('This change can’t be reset from here — reapply it in its own section.', 'info')
        return
      }
      record(en.key, en.label, en.to, en.from)
      notify('Setting restored.', 'success')
    } catch {
      notify('Couldn’t restore this setting — reapply it in its own section.', 'error')
    }
  }

  if (!isOpen) return null

  const archiveShown = paths?.archiveRoot ?? paths?.archiveDefault ?? '—'
  const archiveIsDefault = !paths?.archiveRoot

  // Section visibility under the settings search: every query token must appear in the
  // section's keyword blob — or, for Shortcuts, in one of its command labels.
  const tokens = sq.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const shortcutLabelBlob = EDITOR_COMMANDS.map((c) => c.label.toLowerCase()).join(' ')
  function show(id: SectionId): boolean {
    if (tokens.length === 0) return true
    const blob = SECTION_KEYWORDS[id] + (id === 'shortcuts' ? ' ' + shortcutLabelBlob : '')
    return tokens.every((t) => blob.includes(t))
  }
  const visibleSections = (Object.keys(SECTION_KEYWORDS) as SectionId[]).filter(show)
  // Under a query, the Shortcuts section narrows to matching command rows.
  const shortcutRowMatches = (label: string): boolean =>
    tokens.length === 0 || tokens.every((t) => label.toLowerCase().includes(t) || SECTION_KEYWORDS.shortcuts.includes(t))
  // Display a recorded value: shortcut chords as glyphs, empty strings as the unset sentinel.
  const fmtVal = (en: SettingsChangeEntry, v: string): string => {
    if (en.key.startsWith('keys.')) return displayKeys(v).join('')
    return v === '' ? NOT_SET : v
  }

  return (
    <>
      <div style={backdrop} onClick={onClose} />
      <div style={modal} role="dialog" aria-modal="true" aria-label="Settings">
        <div style={titleBar}>
          <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)' }}>Settings</span>
          <button onClick={onClose} aria-label="Close" style={closeBtn}>×</button>
        </div>

        {/* Settings search (Gate-5): filters the sections below (and shortcut rows by label). */}
        <div style={searchRow}>
          <Search size={13} style={{ color: 'var(--faint)', flexShrink: 0 }} />
          <input
            type="text"
            value={sq}
            onChange={(e) => setSq(e.target.value)}
            placeholder="Search settings…"
            aria-label="Search settings"
            autoComplete="off"
            style={searchInput}
            onKeyDown={(e) => { if (e.key === 'Escape' && sq !== '') { e.preventDefault(); e.stopPropagation(); setSq('') } }}
          />
          {sq !== '' && (
            <button style={resetX} aria-label="Clear settings search" title="Clear" onClick={() => setSq('')}>×</button>
          )}
        </div>

        <div style={body}>
          {visibleSections.length === 0 && (
            <div style={{ ...hint, padding: '18px 0', textAlign: 'center' }}>
              No settings match “{sq.trim()}” — try a section name like <i>backup</i>, <i>timer</i>, <i>publishing</i> or <i>shortcuts</i>.
            </div>
          )}

          {show('folders') && (<>
          {/* ── Folders ─────────────────────────────────────────── */}
          <div style={sectionHead}>Folders</div>

          <div style={rowFolder}>
            <div style={{ minWidth: 0 }}>
              <div style={folderLabel}>Vault root</div>
              <div style={folderPath} title={vaultRoot}>{vaultRoot || '—'}</div>
            </div>
            <button
              style={btn}
              onClick={() => {
                const old = vaultRoot || NOT_SET
                Promise.resolve(onChangeVault()).then(async () => {
                  refreshPaths()
                  try {
                    const p = await window.tw.settings.getPaths()
                    if (p.vaultRoot && p.vaultRoot !== old) record('vault.root', 'Vault root', old, p.vaultRoot)
                  } catch { /* log-only */ }
                })
              }}
            >
              Change…
            </button>
          </div>

          <div style={rowFolder}>
            <div style={{ minWidth: 0 }}>
              <div style={folderLabel}>
                Image archive{' '}
                {paths && (
                  <span style={{ color: paths.archiveAvailable ? 'var(--oxford)' : 'var(--faint)', fontWeight: 500 }}>
                    {paths.archiveAvailable ? '· connected' : '· not found'}
                  </span>
                )}
                {archiveIsDefault && paths?.archiveDefault && <span style={{ color: 'var(--faint)', fontWeight: 500 }}> · auto</span>}
              </div>
              <div style={folderPath} title={archiveShown}>{archiveShown}</div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              {!archiveIsDefault && (
                <button
                  style={btnGhost}
                  onClick={() => {
                    const old = paths?.archiveRoot ?? AUTO
                    window.tw.settings.clearArchive().then(() => { refreshPaths(); record('archive.folder', 'Image archive folder', old, AUTO) })
                  }}
                >
                  Reset
                </button>
              )}
              <button
                style={btn}
                onClick={() => {
                  const old = paths?.archiveRoot ?? AUTO
                  window.tw.settings.chooseArchive().then((chosen) => {
                    refreshPaths()
                    if (chosen) record('archive.folder', 'Image archive folder', old, chosen)
                  })
                }}
              >
                Change…
              </button>
            </div>
          </div>
          </>)}

          {show('backup') && (<>
          {/* ── Presentation backup ─────────────────────────────── */}
          <div style={sectionHead}>Presentation backup</div>
          <div style={hint}>
            Auto-saves each talk as a full, self-contained presenter HTML (with your speaker notes) into a
            folder inside OneDrive/Dropbox — so you can present from any browser even without your laptop.
            Files are named <kbd style={kbd}>&lt;talk&gt;-backup.html</kbd>; only changed talks are re-written.
          </div>

          <div style={rowFolder}>
            <div style={{ minWidth: 0 }}>
              <div style={folderLabel}>
                Status{' '}
                <span style={{ color: backup?.enabled ? 'var(--oxford)' : 'var(--faint)', fontWeight: 500 }}>
                  {backup?.enabled ? '· on' : '· off'}
                </span>
              </div>
              <div style={folderPath}>{backupStatusLine(backup)}</div>
            </div>
            <button
              style={backup?.enabled ? btn : { ...btn, borderColor: 'var(--oxford)', color: 'var(--oxford)' }}
              onClick={() => {
                const old = backup?.enabled ? 'on' : 'off'
                window.tw.settings.setBackup({ enabled: !backup?.enabled }).then((b) => {
                  setBackup(b)
                  record('backup.enabled', 'Presentation backup', old, b.enabled ? 'on' : 'off')
                })
              }}
            >
              {backup?.enabled ? 'Turn off' : 'Turn on'}
            </button>
          </div>

          <div style={rowFolder}>
            <div style={{ minWidth: 0 }}>
              <div style={folderLabel}>
                Backup folder
                {!backup?.folder && <span style={{ color: 'var(--faint)', fontWeight: 500 }}> · not set</span>}
              </div>
              <div style={folderPath} title={backup?.folder ?? ''}>
                {backup?.folder || 'Pick a folder inside OneDrive/Dropbox'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              {backup?.folder && (
                <button
                  style={btnGhost}
                  onClick={() => {
                    const old = backup?.folder ?? NOT_SET
                    window.tw.settings.clearBackupFolder().then((b) => { setBackup(b); record('backup.folder', 'Backup folder', old, NOT_SET) })
                  }}
                >
                  Reset
                </button>
              )}
              <button
                style={btn}
                onClick={() => {
                  const old = backup?.folder ?? NOT_SET
                  window.tw.settings.chooseBackupFolder().then((b) => {
                    setBackup(b)
                    if (b.folder && b.folder !== old) record('backup.folder', 'Backup folder', old, b.folder)
                  })
                }}
              >
                Change…
              </button>
            </div>
          </div>

          <div style={rowFolder}>
            <div style={{ minWidth: 0 }}>
              <div style={folderLabel}>Check every</div>
              <div style={folderPath}>How often TalkWeaver re-saves changed talks</div>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
              <select
                value={backup?.intervalMin ?? 15}
                onChange={(e) => {
                  const old = String(backup?.intervalMin ?? 15)
                  window.tw.settings.setBackup({ intervalMin: Number(e.target.value) }).then((b) => {
                    setBackup(b)
                    record('backup.intervalMin', 'Backup interval (minutes)', old, String(b.intervalMin))
                  })
                }}
                style={selectStyle}
              >
                <option value={5}>5 min</option>
                <option value={15}>15 min</option>
                <option value={30}>30 min</option>
                <option value={60}>60 min</option>
              </select>
              <button
                style={{ ...btn, opacity: backingUp || !backup?.folder ? 0.5 : 1 }}
                disabled={backingUp || !backup?.folder}
                onClick={() => {
                  setBackingUp(true)
                  window.tw.backup
                    .runNow()
                    .then((r) => setBackup((b) => (b ? { ...b, lastRun: r } : b)))
                    .finally(() => setBackingUp(false))
                }}
              >
                {backingUp ? 'Backing up…' : 'Back up now'}
              </button>
            </div>
          </div>

          </>)}

          {show('timer') && (<>
          {/* ── Timer ────────────────────────────────────────────── */}
          <div style={sectionHead}>Timer</div>
          <div style={hint}>
            The presenter clock turns amber, then dark amber, as a talk nears its end. Set the
            default warning minutes here, or override per talk with <kbd style={kbd}>warn-at:</kbd>{' '}
            / <kbd style={kbd}>urgent-at:</kbd> in that deck's frontmatter.
          </div>

          <div style={rowFolder}>
            <div style={{ minWidth: 0 }}>
              <div style={folderLabel}>Amber warning</div>
              <div style={folderPath}>Minutes remaining when the clock turns amber</div>
            </div>
            <input
              type="number"
              min={1}
              max={60}
              value={timer?.warnAtMinutes ?? 5}
              onFocus={() => { timerBaseRef.current = timer }}
              onBlur={() => {
                // Log once per edit (focus → blur), not per keystroke.
                const old = timerBaseRef.current?.warnAtMinutes
                if (old != null && timer) record('timer.warnAtMinutes', 'Timer — amber warning (minutes)', String(old), String(timer.warnAtMinutes))
              }}
              onChange={(e) => {
                const warnAtMinutes = Number(e.target.value)
                setTimer((t) => (t ? { ...t, warnAtMinutes } : t))
                window.tw.settings.setTimer({ warnAtMinutes }).then(setTimer)
              }}
              style={numberInputStyle}
            />
          </div>

          <div style={rowFolder}>
            <div style={{ minWidth: 0 }}>
              <div style={folderLabel}>Dark-amber warning</div>
              <div style={folderPath}>Minutes remaining when the clock turns dark amber</div>
            </div>
            <input
              type="number"
              min={1}
              max={60}
              value={timer?.urgentAtMinutes ?? 1}
              onFocus={() => { timerBaseRef.current = timer }}
              onBlur={() => {
                const old = timerBaseRef.current?.urgentAtMinutes
                if (old != null && timer) record('timer.urgentAtMinutes', 'Timer — dark-amber warning (minutes)', String(old), String(timer.urgentAtMinutes))
              }}
              onChange={(e) => {
                const urgentAtMinutes = Number(e.target.value)
                setTimer((t) => (t ? { ...t, urgentAtMinutes } : t))
                window.tw.settings.setTimer({ urgentAtMinutes }).then(setTimer)
              }}
              style={numberInputStyle}
            />
          </div>

          </>)}

          {show('publishing') && (<>
          {/* ── Publishing (Cloudflare) ─────────────────────────── */}
          <div style={sectionHead}>Publishing (Cloudflare)</div>
          <div style={hint}>
            Publish a talk's handout to your own Cloudflare Pages site. Install <kbd style={kbd}>wrangler</kbd>{' '}
            (<kbd style={kbd}>npm&nbsp;i&nbsp;-g&nbsp;wrangler</kbd>) and enter your account id, project, and an API
            token scoped to <em>Cloudflare Pages → Edit</em>. The token is stored in your OS keychain — never in a
            config file. See <kbd style={kbd}>docs/PUBLISHING.md</kbd>.
          </div>

          <div style={rowFolder}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={folderLabel}>Account ID</div>
              <input
                style={inputStyle}
                value={pub?.accountId ?? ''}
                placeholder="Cloudflare account id"
                onChange={(e) => setPub((p) => (p ? { ...p, accountId: e.target.value } : p))}
                onBlur={persistPub}
              />
            </div>
          </div>
          <div style={rowFolder}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={folderLabel}>Pages project</div>
              <input
                style={inputStyle}
                value={pub?.project ?? ''}
                placeholder="my-handouts"
                onChange={(e) => setPub((p) => (p ? { ...p, project: e.target.value } : p))}
                onBlur={persistPub}
              />
            </div>
          </div>
          <div style={rowFolder}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={folderLabel}>Custom domain <span style={{ color: 'var(--faint)', fontWeight: 500 }}>· optional</span></div>
              <input
                style={inputStyle}
                value={pub?.baseUrl ?? ''}
                placeholder="https://handouts.example.com"
                onChange={(e) => setPub((p) => (p ? { ...p, baseUrl: e.target.value } : p))}
                onBlur={persistPub}
              />
            </div>
          </div>

          <div style={rowFolder}>
            <div style={{ minWidth: 0 }}>
              <div style={folderLabel}>Short URLs</div>
              <div style={folderPath}>Share <kbd style={kbd}>{'<base>/<id>'}</kbd> links instead of <kbd style={kbd}>{'<base>/<slug>/'}</kbd></div>
            </div>
            <button
              style={pub?.useShortIds ? { ...btn, borderColor: 'var(--oxford)', color: 'var(--oxford)' } : btn}
              onClick={() => {
                const next = !(pub?.useShortIds ?? false)
                setPub((p) => (p ? { ...p, useShortIds: next } : p))
                if (pub) {
                  record('publish.useShortIds', 'Publishing — short URLs', pub.useShortIds ? 'on' : 'off', next ? 'on' : 'off')
                  window.tw.publish.setConfig({ accountId: pub.accountId, project: pub.project, baseUrl: pub.baseUrl, useShortIds: next }).then(refreshPub)
                }
              }}
            >
              {pub?.useShortIds ? 'On' : 'Off'}
            </button>
          </div>

          <div style={rowFolder}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={folderLabel}>
                API token{' '}
                <span style={{ color: pub?.hasToken ? 'var(--oxford)' : 'var(--faint)', fontWeight: 500 }}>
                  {pub?.hasToken ? '· saved' : '· not set'}
                </span>
              </div>
              <input
                style={inputStyle}
                type="password"
                value={tokenInput}
                placeholder={pub?.hasToken ? '•••••••• (enter a new token to replace)' : 'Cloudflare API token'}
                onChange={(e) => setTokenInput(e.target.value)}
              />
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'flex-end' }}>
              {pub?.hasToken && (
                <button
                  style={btnGhost}
                  onClick={() => window.tw.publish.clearToken().then(() => {
                    setTokenInput('')
                    refreshPub()
                    // Presence only — a secret's value never enters the changelog.
                    record('publish.token', 'Publishing — API token', 'set', 'not set')
                  })}
                >
                  Clear
                </button>
              )}
              <button
                style={{ ...btn, opacity: tokenInput.trim() ? 1 : 0.5 }}
                disabled={!tokenInput.trim()}
                onClick={() =>
                  window.tw.publish.setToken(tokenInput).then((r) => {
                    if (r.success) {
                      const had = pub?.hasToken ? 'set' : 'not set'
                      setTokenInput(''); refreshPub(); notify('API token saved to the OS keychain.', 'success')
                      record('publish.token', 'Publishing — API token', had, 'set')
                    }
                    else notify('Could not store the token: ' + (r.error || 'unknown error'), 'error')
                  })
                }
              >
                Save token
              </button>
            </div>
          </div>

          <div style={{ ...rowFolder, justifyContent: 'flex-end' }}>
            <button
              style={{ ...btn, borderColor: 'var(--oxford)', color: 'var(--oxford)' }}
              onClick={() => {
                if (!pub) return
                const next = { accountId: pub.accountId, project: pub.project, baseUrl: pub.baseUrl, useShortIds: pub.useShortIds }
                recordPubDiff(next)
                window.tw.publish
                  .setConfig(next)
                  .then(() => { setPubSaved(true); setTimeout(() => setPubSaved(false), 1500); refreshPub() })
              }}
            >
              {pubSaved ? 'Saved ✓' : 'Save publishing settings'}
            </button>
          </div>

          </>)}

          {show('recording') && (<>
          {/* ── Recording storage (R2) ──────────────────────────── */}
          <div style={sectionHead}>Recording storage</div>
          <div style={hint}>
            Where presenter recordings upload. Recording is always saved to this machine first, so an
            empty or offline destination never loses anything — uploads just queue and retry. Point this
            at an S3-compatible bucket (Cloudflare R2). Access keys are stored in your OS keychain — never
            in a config file. Leave blank to keep everything local.
          </div>

          <div style={rowFolder}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={folderLabel}>Endpoint <span style={{ color: 'var(--faint)', fontWeight: 500 }}>· S3-compatible</span></div>
              <input
                style={inputStyle}
                value={rec?.endpoint ?? ''}
                placeholder="https://<account>.r2.cloudflarestorage.com"
                onChange={(e) => setRec((r) => (r ? { ...r, endpoint: e.target.value } : r))}
              />
            </div>
          </div>
          <div style={rowFolder}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={folderLabel}>Bucket</div>
              <input
                style={inputStyle}
                value={rec?.bucket ?? ''}
                placeholder="my-bucket"
                onChange={(e) => setRec((r) => (r ? { ...r, bucket: e.target.value } : r))}
              />
            </div>
          </div>

          <div style={rowFolder}>
            <div style={{ minWidth: 0 }}>
              <div style={folderLabel}>Credentials from</div>
              <div style={folderPath}>
                {rec?.credsSource === 'bws'
                  ? <>a <kbd style={kbd}>bws</kbd> secret holding <kbd style={kbd}>{'{accessKeyId, secretAccessKey}'}</kbd></>
                  : <>the keys entered below (OS keychain)</>}
              </div>
            </div>
            <button
              style={btn}
              onClick={() => {
                const next = rec?.credsSource === 'bws' ? 'settings' : 'bws'
                setRec((r) => (r ? { ...r, credsSource: next } : r))
              }}
            >
              {rec?.credsSource === 'bws' ? 'Bitwarden Secrets' : 'Keychain keys'}
            </button>
          </div>

          {rec?.credsSource === 'bws' ? (
            <div style={rowFolder}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={folderLabel}>bws secret id</div>
                <input
                  style={inputStyle}
                  value={rec?.bwsSecretId ?? ''}
                  placeholder="the Bitwarden Secrets secret id"
                  onChange={(e) => setRec((r) => (r ? { ...r, bwsSecretId: e.target.value } : r))}
                />
              </div>
            </div>
          ) : (
            <div style={rowFolder}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={folderLabel}>
                  Access keys{' '}
                  <span style={{ color: rec?.hasKeys ? 'var(--oxford)' : 'var(--faint)', fontWeight: 500 }}>
                    {rec?.hasKeys ? '· saved' : '· not set'}
                  </span>
                </div>
                <input
                  style={{ ...inputStyle, marginBottom: 6 }}
                  value={recKeyId}
                  placeholder={rec?.hasKeys ? '•••••••• access key id (enter to replace)' : 'access key id'}
                  onChange={(e) => setRecKeyId(e.target.value)}
                />
                <input
                  style={inputStyle}
                  type="password"
                  value={recKeySecret}
                  placeholder={rec?.hasKeys ? '•••••••• secret access key (enter to replace)' : 'secret access key'}
                  onChange={(e) => setRecKeySecret(e.target.value)}
                />
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'flex-end' }}>
                {rec?.hasKeys && (
                  <button
                    style={btnGhost}
                    onClick={() => window.tw.recording.clearKeys().then(() => {
                      setRecKeyId(''); setRecKeySecret(''); refreshRec()
                      // Presence only — secret values never enter the changelog.
                      record('recording.keys', 'Recording — access keys', 'set', 'not set')
                    })}
                  >
                    Clear
                  </button>
                )}
                <button
                  style={{ ...btn, opacity: recKeyId.trim() && recKeySecret.trim() ? 1 : 0.5 }}
                  disabled={!(recKeyId.trim() && recKeySecret.trim())}
                  onClick={() =>
                    window.tw.recording.setKeys({ accessKeyId: recKeyId, secretAccessKey: recKeySecret }).then((r) => {
                      if (r.success) {
                        const had = rec?.hasKeys ? 'set' : 'not set'
                        setRecKeyId(''); setRecKeySecret(''); refreshRec()
                        record('recording.keys', 'Recording — access keys', had, 'set')
                      }
                      else notify('Could not store the keys: ' + (r.error || 'unknown error'), 'error')
                    })
                  }
                >
                  Save keys
                </button>
              </div>
            </div>
          )}

          <div style={rowFolder}>
            <div style={{ minWidth: 0 }}>
              <div style={folderLabel}>Auto-discard under</div>
              <div style={folderPath}>Recordings shorter than this are dropped as accidental opens</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="number"
                min={0}
                max={600}
                value={rec?.discardSeconds ?? 20}
                onChange={(e) => setRec((r) => (r ? { ...r, discardSeconds: Number(e.target.value) } : r))}
                style={numberInputStyle}
              />
              <span style={{ color: 'var(--faint)' }}>s</span>
            </div>
          </div>

          <div style={{ ...rowFolder, justifyContent: 'flex-end' }}>
            <button
              style={{ ...btn, borderColor: 'var(--oxford)', color: 'var(--oxford)' }}
              onClick={() => {
                if (!rec) return
                const base = recBaseRef.current
                if (base) {
                  record('recording.endpoint', 'Recording — endpoint', base.endpoint, rec.endpoint)
                  record('recording.bucket', 'Recording — bucket', base.bucket, rec.bucket)
                  record('recording.credsSource', 'Recording — credentials source', base.credsSource, rec.credsSource)
                  record('recording.bwsSecretId', 'Recording — bws secret id', base.bwsSecretId, rec.bwsSecretId)
                  record('recording.discardSeconds', 'Recording — auto-discard (seconds)', String(base.discardSeconds), String(rec.discardSeconds))
                }
                window.tw.recording
                  .setStorage({
                    endpoint: rec.endpoint,
                    bucket: rec.bucket,
                    credsSource: rec.credsSource,
                    bwsSecretId: rec.bwsSecretId,
                    discardSeconds: rec.discardSeconds
                  })
                  .then(() => { setRecSaved(true); setTimeout(() => setRecSaved(false), 1500); refreshRec() })
              }}
            >
              {recSaved ? 'Saved ✓' : 'Save recording settings'}
            </button>
          </div>

          </>)}

          {show('transcription') && (<>
          {/* ── Transcription ──────────────────────────────────── */}
          <div style={sectionHead}>Transcription</div>
          <div style={hint}>
            TalkWeaver uses the local speech-to-text skill to transcribe recorded Runs. Defaults:{' '}
            <kbd style={pathKbd}>{transcription?.defaultPython ?? '—'}</kbd> and{' '}
            <kbd style={pathKbd}>{transcription?.defaultScript ?? '—'}</kbd>. Leave these as-is unless
            this machine keeps the skill somewhere else. Leave ffmpeg blank to auto-detect Homebrew or system ffmpeg.
          </div>

          <div style={rowFolder}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={folderLabel}>Python</div>
              <input
                style={inputStyle}
                value={transcription?.python ?? ''}
                placeholder={transcription?.defaultPython ?? ''}
                onChange={(e) => setTranscription((t) => (t ? { ...t, python: e.target.value } : t))}
              />
            </div>
          </div>

          <div style={rowFolder}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={folderLabel}>Parakeet script</div>
              <input
                style={inputStyle}
                value={transcription?.script ?? ''}
                placeholder={transcription?.defaultScript ?? ''}
                onChange={(e) => setTranscription((t) => (t ? { ...t, script: e.target.value } : t))}
              />
            </div>
          </div>

          <div style={rowFolder}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={folderLabel}>ffmpeg <span style={{ color: 'var(--faint)', fontWeight: 500 }}>· optional</span></div>
              <input
                style={inputStyle}
                value={transcription?.ffmpeg ?? ''}
                placeholder="/opt/homebrew/bin/ffmpeg"
                onChange={(e) => setTranscription((t) => (t ? { ...t, ffmpeg: e.target.value } : t))}
              />
            </div>
          </div>

          <div style={{ ...rowFolder, justifyContent: 'flex-end' }}>
            <button
              style={{ ...btn, borderColor: 'var(--oxford)', color: 'var(--oxford)' }}
              onClick={() => {
                if (!transcription) return
                const base = trBaseRef.current
                if (base) {
                  record('transcription.python', 'Transcription — Python', base.python, transcription.python)
                  record('transcription.script', 'Transcription — Parakeet script', base.script, transcription.script)
                  record('transcription.ffmpeg', 'Transcription — ffmpeg', base.ffmpeg, transcription.ffmpeg)
                }
                window.tw.settings
                  .setTranscription({ python: transcription.python, script: transcription.script, ffmpeg: transcription.ffmpeg })
                  .then(() => { setTranscriptionSaved(true); setTimeout(() => setTranscriptionSaved(false), 1500); refreshTranscription() })
              }}
            >
              {transcriptionSaved ? 'Saved ✓' : 'Save transcription settings'}
            </button>
          </div>

          </>)}

          {show('shortcuts') && (<>
          {/* ── Keyboard shortcuts ──────────────────────────────── */}
          <div style={{ ...sectionHead, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Keyboard shortcuts</span>
            <button
              style={btnGhost}
              onClick={() => {
                const hadOverrides = Object.keys(readOverrides()).length > 0
                clearAllOverrides()
                if (hadOverrides) record('keys.reset-all', 'Keyboard shortcuts — reset all overrides', '(custom)', '(defaults)')
              }}
            >
              Reset all
            </button>
          </div>
          <div style={hint}>
            Click a shortcut, then press the keys you want. <kbd style={kbd}>Esc</kbd> cancels. Chords are
            re-bound instantly. (Avoid <kbd style={kbd}>⌃</kbd>+arrows — macOS reserves those.)
          </div>

          {groups
            .map(({ cat, cmds }) => ({ cat, cmds: cmds.filter((c) => shortcutRowMatches(c.label)) }))
            .filter(({ cmds }) => cmds.length > 0)
            .map(({ cat, cmds }) => (
            <div key={cat} style={{ marginBottom: 6 }}>
              <div style={catHead}>{cat}</div>
              {cmds.map((c) => {
                const keys = effectiveKeys(c.id)
                const overridden = keys !== c.keys
                const capturing = capturingId === c.id
                const collides = !capturing && duplicates.has(keys)
                return (
                  <div key={c.id} style={rowShortcut} data-shortcut-id={c.id}>
                    <span style={{ fontSize: 12.5, color: 'var(--ink)', lineHeight: 1.3 }}>{c.label}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                      {collides && <span title="Also bound to another command" style={warnDot}>⚠</span>}
                      <button
                        style={{
                          ...chordBtn,
                          ...(capturing ? chordBtnActive : null),
                          ...(overridden ? chordBtnOverridden : null)
                        }}
                        onClick={() => setCapturingId(capturing ? null : c.id)}
                        aria-label={`Change shortcut for ${c.label}`}
                      >
                        {capturing ? 'Press keys…' : displayKeys(keys).map((g, i) => (
                          <kbd key={i} style={kbd}>{g}</kbd>
                        ))}
                      </button>
                      {overridden && !capturing && (
                        <button
                          style={resetX}
                          title="Reset to default"
                          onClick={() => {
                            const old = effectiveKeys(c.id)
                            clearOverride(c.id)
                            record(`keys.${c.id}`, `Shortcut — ${c.label}`, old, c.keys)
                          }}
                        >×</button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
          </>)}

          {show('changes') && (<>
          {/* ── Changes (Gate-5 settings changelog) ─────────────── */}
          <div style={{ ...sectionHead, display: 'flex', alignItems: 'center', gap: 6 }}>
            <History size={12} style={{ color: 'var(--faint)' }} />
            <span>Changes</span>
          </div>
          <div style={hint}>
            Every settings change on this machine, newest first — old → new. <b>Reset</b> restores
            the previous value (secrets are logged as set/not&nbsp;set only and can’t be reset here).
          </div>
          {changes === null && <div style={hint}>Reading the settings changelog…</div>}
          {changes !== null && changes.length === 0 && (
            <div style={hint}>No changes recorded yet — adjust any setting above and it will appear here.</div>
          )}
          {changes !== null && changes.slice(0, 30).map((en, i) => (
            <div key={`${en.at}-${en.key}-${i}`} style={rowChange}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={folderLabel}>{en.label}</div>
                <div style={changeVals} title={`${fmtVal(en, en.from)} → ${fmtVal(en, en.to)}`}>
                  {fmtVal(en, en.from)} <span style={{ color: 'var(--faint)' }}>→</span> {fmtVal(en, en.to)}
                  <span style={{ color: 'var(--faint)' }}> · {relTime(en.at)}</span>
                </div>
              </div>
              {canReset(en) && (
                <button
                  style={{ ...btnGhost, display: 'flex', alignItems: 'center', gap: 5 }}
                  title={`Restore ${fmtVal(en, en.from)}`}
                  onClick={() => void resetEntry(en)}
                >
                  <RotateCcw size={11} /> Reset
                </button>
              )}
            </div>
          ))}
          {changes !== null && changes.length > 30 && (
            <div style={hint}>…{changes.length - 30} older entries kept in the changelog file.</div>
          )}
          </>)}
        </div>

        <div style={footer}>
          <kbd style={kbd}>⌘</kbd><kbd style={kbd}>,</kbd> opens settings · <kbd style={kbd}>⌃</kbd><kbd style={kbd}>/</kbd> shortcuts list
        </div>
      </div>
    </>
  )
}

// A one-line human summary of the last backup run for the Settings status row.
function backupStatusLine(b: BackupSettings | null): string {
  if (!b) return '—'
  if (!b.folder) return 'Set a backup folder to begin'
  const r = b.lastRun
  if (!r) return b.enabled ? 'Waiting for the first backup…' : 'Off'
  const when = relTime(r.at)
  if (!r.ok && r.error) return `Last run failed: ${r.error} (${when})`
  const parts = [`${r.exported} saved`]
  if (r.skipped) parts.push(`${r.skipped} unchanged`)
  if (r.failed) parts.push(`${r.failed} failed`)
  return `Last backup: ${parts.join(', ')} · ${when}`
}
function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  return `${Math.round(m / 60)} h ago`
}

// ── styles (inline, warm palette — matches KeyboardHelp / ArchiveImageSearch) ──
const selectStyle: React.CSSProperties = {
  fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--line)',
  background: 'var(--panel)', color: 'var(--ink)', cursor: 'pointer'
}
const inputStyle: React.CSSProperties = {
  fontSize: 12, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--line)',
  background: 'var(--panel)', color: 'var(--ink)', width: '100%', marginTop: 3,
  fontFamily: 'var(--font-mono)', boxSizing: 'border-box'
}
const numberInputStyle: React.CSSProperties = {
  fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--line)',
  background: 'var(--panel)', color: 'var(--ink)', width: 56, flexShrink: 0, textAlign: 'right'
}
const backdrop: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(23,32,42,0.35)' }
const modal: React.CSSProperties = {
  position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 1001,
  width: 640, maxWidth: '92vw', maxHeight: '86vh', display: 'flex', flexDirection: 'column',
  background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 'var(--radius)',
  boxShadow: '0 12px 40px #17202a2e, 0 2px 10px #17202a18', fontFamily: 'var(--font-ui)', overflow: 'hidden'
}
const titleBar: React.CSSProperties = {
  padding: '12px 14px', borderBottom: '1px solid var(--line)', display: 'flex',
  justifyContent: 'space-between', alignItems: 'center', flexShrink: 0
}
const closeBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--muted)',
  lineHeight: 1, padding: '2px 6px', borderRadius: 4
}
const body: React.CSSProperties = { padding: '10px 14px 14px', overflowY: 'auto', flex: 1 }
const searchRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 7, padding: '8px 14px',
  borderBottom: '1px solid var(--line)', flexShrink: 0
}
const searchInput: React.CSSProperties = {
  flex: 1, fontSize: 12.5, border: 'none', outline: 'none', background: 'transparent',
  color: 'var(--ink)', fontFamily: 'var(--font-ui)'
}
const rowChange: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
  padding: '5px 0', borderBottom: '1px solid var(--line)'
}
const changeVals: React.CSSProperties = {
  fontSize: 11.5, color: 'var(--muted)', fontFamily: 'var(--font-mono)', marginTop: 2,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
}
const sectionHead: React.CSSProperties = {
  padding: '12px 0 6px', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
  textTransform: 'uppercase', color: 'var(--faint)', borderBottom: '1px solid var(--line)', marginBottom: 8
}
const catHead: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: 'var(--muted)', padding: '6px 0 3px' }
const rowFolder: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '6px 0'
}
const folderLabel: React.CSSProperties = { fontSize: 12.5, fontWeight: 600, color: 'var(--ink)' }
const folderPath: React.CSSProperties = {
  fontSize: 11.5, color: 'var(--muted)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap',
  overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 2
}
const rowShortcut: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
  padding: '4px 0', borderBottom: '1px solid var(--line)'
}
const btn: React.CSSProperties = {
  fontSize: 12, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--line)',
  background: 'var(--hover)', color: 'var(--ink)', cursor: 'pointer', flexShrink: 0
}
const btnGhost: React.CSSProperties = { ...btn, background: 'transparent', color: 'var(--muted)' }
const chordBtn: React.CSSProperties = {
  fontSize: 12, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--line)',
  background: 'var(--panel)', color: 'var(--ink)', cursor: 'pointer', minWidth: 96, textAlign: 'center'
}
const chordBtnActive: React.CSSProperties = {
  borderColor: 'var(--oxford)', boxShadow: '0 0 0 2px color-mix(in srgb, var(--oxford) 25%, transparent)',
  color: 'var(--oxford)', fontWeight: 600
}
const chordBtnOverridden: React.CSSProperties = { borderColor: 'var(--oxford)' }
const resetX: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', fontSize: 15, color: 'var(--faint)', lineHeight: 1, padding: '0 2px'
}
const warnDot: React.CSSProperties = { color: '#b8860b', fontSize: 13 }
const hint: React.CSSProperties = { fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5, margin: '2px 0 8px' }
const footer: React.CSSProperties = {
  padding: '6px 14px', borderTop: '1px solid var(--line)', fontSize: 11, color: 'var(--faint)',
  textAlign: 'center', flexShrink: 0
}
const kbd: React.CSSProperties = {
  fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--hover)', border: '1px solid var(--line)',
  borderRadius: 3, padding: '2px 5px', color: 'var(--ink)', display: 'inline-block', margin: '0 1px'
}
const pathKbd: React.CSSProperties = { ...kbd, maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere' }
