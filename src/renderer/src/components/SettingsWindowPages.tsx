// TalkWeaver's own pages in the shared Settings window (0.42): what the old Settings panel held
// beside its schema settings, which now live in the window's generated sections.
//
//   Get started   Open the Guide, Show the example vault again, Add a vault…, and the transcription
//                 set-up row (whether it can run; the paths are Recording › Transcription rows).
//   Backups       What the last backup did, which talks are backed up, Back up now (On / off, the
//                 folder and the interval are Presenting › Present from anywhere rows).
//   Cloudflare    Settings › Cloudflare as it was (CloudflareSettings.tsx), and the account, site
//                 and live-service fields the connection fills in, which are not preferences.
//
// Each page calls the Settings window's own preload (src/preload/settings.ts): the same channels
// the editor window uses, never a key. The look objects are the old panel's, so the reused rows
// keep their layout.
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import CloudflareSettings from './CloudflareSettings'
import TranscriptionStatusRow from './TranscriptionStatusRow'
import type { BackupSettings } from '../../../preload/index'
import { GUIDE_TEXT } from '../../../shared/guide'
import { EXAMPLE_REMOVAL_TEXT } from '../../../shared/example-vault-removal'

const look = {
  sectionHead: { padding: '12px 0 6px', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--faint)', borderBottom: '1px solid var(--line)', marginBottom: 8 },
  hint: { fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5, margin: '2px 0 8px' },
  rowFolder: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '6px 0' },
  folderLabel: { fontSize: 12.5, fontWeight: 600, color: 'var(--ink)' },
  folderPath: { fontSize: 11.5, color: 'var(--muted)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 2 },
  btn: { fontSize: 12, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--hover)', color: 'var(--ink)', cursor: 'pointer', flexShrink: 0 },
  btnGhost: { fontSize: 12, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--line)', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', flexShrink: 0 },
  inputStyle: { fontSize: 12, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--ink)', width: '100%', marginTop: 3, fontFamily: 'var(--font-mono)', boxSizing: 'border-box' },
  kbd: { fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--hover)', border: '1px solid var(--line)', borderRadius: 3, padding: '2px 5px', color: 'var(--ink)', display: 'inline-block', margin: '0 1px' }
} satisfies Record<string, CSSProperties>

const page: CSSProperties = { padding: '4px 20px 20px', fontFamily: 'var(--font-ui)' }

/** The two calls only the Settings window's preload has (src/preload/settings.ts). */
interface SettingsWindowOnly {
  editorAction(action: EditorAction): Promise<boolean>
  exampleRemoved(): Promise<boolean>
}
const windowOnly = (): Partial<SettingsWindowOnly> => (window as unknown as { tw: { settings: Partial<SettingsWindowOnly> } }).tw.settings

// ── Get started ────────────────────────────────────────────────────────────────────────────────
type EditorAction = 'open-guide' | 'restore-example' | 'add-vault'

export function GetStartedPage(): React.JSX.Element {
  const [exampleRemoved, setExampleRemoved] = useState(false)
  useEffect(() => { void windowOnly().exampleRemoved?.().then((v) => setExampleRemoved(v === true)).catch(() => {}) }, [])
  return <GetStartedRows exampleRemoved={exampleRemoved} onAction={(action) => { void windowOnly().editorAction?.(action) }} />
}

/** The Get started page as drawn (no IPC: the tests render it as it is). */
export function GetStartedRows({ exampleRemoved, onAction }: { exampleRemoved: boolean; onAction: (action: EditorAction) => void }): React.JSX.Element {
  const run = onAction
  return (
    <div style={page} data-settings-page="get-started">
      <div style={look.sectionHead}>{GUIDE_TEXT.settings.section}</div>
      <div style={look.rowFolder} data-setting="get-started">
        <div style={{ minWidth: 0 }}>
          <div style={look.folderLabel}>{GUIDE_TEXT.settings.row}</div>
          {exampleRemoved && <div style={look.hint} data-example-removed-note>{EXAMPLE_REMOVAL_TEXT.settingsNote}</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, flex: '0 0 auto' }}>
          {exampleRemoved && <button style={look.btn} data-restore-example onClick={() => run('restore-example')}>{EXAMPLE_REMOVAL_TEXT.settingsShow}</button>}
          <button style={look.btn} data-open-guide onClick={() => run('open-guide')}>{GUIDE_TEXT.settings.open}</button>
        </div>
      </div>
      <div style={look.sectionHead} data-setting="vaults">Vaults</div>
      <div style={look.rowFolder}>
        <div style={{ minWidth: 0 }}>
          <div style={look.folderLabel}>Add a vault</div>
          <div style={look.hint}>A folder of talks. Vaults are listed, edited and closed in the Talks panel.</div>
        </div>
        <button style={look.btn} data-add-vault onClick={() => run('add-vault')}>Add vault…</button>
      </div>
      <div style={look.sectionHead}>Transcription</div>
      <div style={look.hint}>
        Optional. TalkWeaver can transcribe recorded Runs on this computer with a speech engine you set up once. The paths are under
        Recording › Transcription.
      </div>
      <TranscriptionStatusRow look={look} version={0} />
    </div>
  )
}

// ── Backups ────────────────────────────────────────────────────────────────────────────────────
function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  return `${Math.round(m / 60)} h ago`
}
export function backupStatusLine(b: BackupSettings | null): string {
  if (!b) return '—'
  if (!b.folder) return 'Choose a backup folder under Presenting to begin'
  const r = b.lastRun
  if (!r) return b.enabled ? 'Waiting for the first backup…' : 'Off'
  const when = relTime(r.at)
  if (!r.ok && r.error) return `Last run failed: ${r.error} (${when})`
  const parts = [`${r.exported} saved`]
  if (r.skipped) parts.push(`${r.skipped} unchanged`)
  if (r.failed) parts.push(`${r.failed} failed`)
  return `Last backup: ${parts.join(', ')} · ${when}`
}

export function BackupsPage({ version }: { version: number }): React.JSX.Element {
  const [backup, setBackup] = useState<BackupSettings | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { void window.tw.settings.getBackup().then(setBackup).catch(() => {}) }, [version])
  useEffect(() => window.tw.backup.onStatus((run) => setBackup((b) => (b ? { ...b, lastRun: run } : b))), [])
  return (
    <div style={page} data-settings-page="backups">
      <div style={look.sectionHead}>Presentation backup</div>
      <div style={look.hint}>
        Each talk you work on is saved as one presenter file in the backup folder, so you can present from any browser without your
        laptop. Turn it on and choose the folder under Presenting › Present from anywhere.
      </div>
      <div style={look.rowFolder}>
        <div style={{ minWidth: 0 }}>
          <div style={look.folderLabel}>Status · {backup?.enabled ? 'on' : 'off'}</div>
          <div style={{ ...look.folderPath, whiteSpace: 'normal' }} data-backup-status>{backupStatusLine(backup)}</div>
        </div>
        <button
          style={{ ...look.btn, opacity: busy || !backup?.folder ? 0.5 : 1 }}
          disabled={busy || !backup?.folder}
          onClick={() => {
            setBusy(true)
            void window.tw.backup.runNow().then((r) => setBackup((b) => (b ? { ...b, lastRun: r } : b))).finally(() => setBusy(false))
          }}
        >
          {busy ? 'Backing up…' : 'Back up now'}
        </button>
      </div>
      <div style={look.sectionHead}>Talks being backed up</div>
      <div style={look.hint}>The talks you have edited in TalkWeaver. A talk drops out after 14 days without being opened.</div>
      {(backup?.talks ?? []).length === 0 && <div style={{ ...look.hint, fontStyle: 'italic' }}>Nothing yet: edit a talk and it joins this list.</div>}
      {(backup?.talks ?? []).map((t) => (
        <label key={t.slug} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, padding: '3px 0' }}>
          <input type="checkbox" checked={t.enrolled} onChange={(e) => { void window.tw.backup.setEnrolled(t.slug, e.target.checked).then(setBackup) }} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
          <span style={{ color: 'var(--faint)', flexShrink: 0 }}>{t.lastBackupAt ? `saved ${relTime(t.lastBackupAt)}` : 'not saved yet'}</span>
        </label>
      ))}
    </div>
  )
}

// ── Cloudflare ─────────────────────────────────────────────────────────────────────────────────
type Pub = Awaited<ReturnType<typeof window.tw.publish.getConfig>>

/** `onSetUpRecording`: "Set up recording storage" goes to Recording with Storage endpoint focused (settings-main.tsx). */
export function CloudflarePage({ onSetUpRecording }: { onSetUpRecording: () => void }): React.JSX.Element {
  const [pub, setPub] = useState<Pub | null>(null)
  const saved = useRef<Pub | null>(null)
  const refresh = (): void => { void window.tw.publish.getConfig().then((p) => { saved.current = p; setPub(p) }).catch(() => {}) }
  useEffect(refresh, [])
  const persist = (): void => {
    if (!pub) return
    const next = { accountId: pub.accountId, project: pub.project, baseUrl: pub.baseUrl, workerBaseUrl: pub.workerBaseUrl, useShortIds: pub.useShortIds, shareDomain: pub.shareDomain }
    const was = saved.current
    if (was && was.accountId === next.accountId && was.project === next.project && was.workerBaseUrl === next.workerBaseUrl && was.shareDomain === next.shareDomain) return
    void window.tw.publish.setConfig(next).then((r) => { if (!r.success) window.alert(r.error || 'That could not be saved.'); refresh() })
  }
  const field = (key: 'accountId' | 'project' | 'workerBaseUrl' | 'shareDomain', label: string, placeholder: string, note?: string): React.JSX.Element => (
    <div style={look.rowFolder}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={look.folderLabel}>{label}</div>
        <input style={look.inputStyle} value={pub?.[key] ?? ''} placeholder={placeholder} data-cloudflare={`${key}-field`}
          onChange={(e) => setPub((p) => (p ? { ...p, [key]: e.target.value } : p))} onBlur={persist} />
        {note && <div style={{ ...look.hint, marginTop: 4 }}>{note}</div>}
      </div>
    </div>
  )
  return (
    <div style={page} data-settings-page="cloudflare">
      <CloudflareSettings
        look={look}
        record={() => { /* main logs the token's Save and Disconnect in Changes itself (connected / missing, as Accounts and keys does) */ }}
        onStatus={refresh}
        onSetUpRecording={onSetUpRecording}
      />
      <div style={look.sectionHead}>Found from the token</div>
      {field('accountId', 'Account ID', 'Cloudflare account id', 'Found from the token; type one only to override it.')}
      {field('project', 'Pages project', 'talkweaver-handouts')}
      {field('workerBaseUrl', 'Live Worker URL · optional', 'https://talkweaver-live-sessions.example.workers.dev')}
      {field('shareDomain', 'Share link domain · optional', 'drafts.example.com', 'A colleague’s Share for comments link opens here instead of the live Worker’s own address.')}
      <div style={look.hint}>The handout address, short links, the site folder and the branch are under Publishing. Recording storage is under Recording.</div>
    </div>
  )
}
