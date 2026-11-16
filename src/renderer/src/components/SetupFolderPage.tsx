// Settings › Set-up folder (0.45, two Macs): choose the folder your Macs share; the first time, what
// applying another Mac's set-up changes here (Apply / Not now); the Macs seen there; addresses set on
// another Mac to confirm here, and where publishing goes when another Mac changed it; changes that came
// from another Mac, each batch undoable; files and entries that were not read, by file name, with Show
// in Finder; settings whose value stays on this Mac, and why; what this Mac's file holds. Everything comes from main (src/main/setup-folder.ts) through the
// Settings window's preload; this page holds no state of its own beyond the last status.
import { useEffect, useState, type CSSProperties } from 'react'
import { SETUP_FOLDER_TEXT as T, type SetupFolderStatus } from '../../../shared/setup-folder'
import { look, page } from './SettingsWindowPages'

type Reply = { ok: boolean; error?: string; status: SetupFolderStatus | null }
interface SetupFolderBridge {
  status(): Promise<SetupFolderStatus | null>
  choose(): Promise<SetupFolderStatus | null>
  stop(): Promise<SetupFolderStatus | null>
  readNow(): Promise<SetupFolderStatus | null>
  apply(token: string): Promise<Reply>
  notNow(): Promise<SetupFolderStatus | null>
  undo(id: string): Promise<Reply>
  use(kind: string): Promise<Reply>
  removeOwn(): Promise<Reply>
  newFile(): Promise<SetupFolderStatus | null>
  reveal(file: string): Promise<boolean>
  onChange(listener: (status: SetupFolderStatus) => void): () => void
}
const bridge = (): SetupFolderBridge => (window as unknown as { tw: { setupFolder: SetupFolderBridge } }).tw.setupFolder

/** "today 10:02", "16 Nov 10:02", "16 Nov 2025". */
export function whenText(ts: number | null, now = Date.now()): string {
  if (!ts) return 'not yet'
  const d = new Date(ts)
  const n = new Date(now)
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === n.toDateString()) return `today ${time}`
  if (d.getFullYear() !== n.getFullYear()) return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${time}`
}

const row: CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 10, padding: '4px 0', fontSize: 12.5, minWidth: 0 }
const name: CSSProperties = { fontWeight: 600, color: 'var(--ink)', flexShrink: 0 }
const quiet: CSSProperties = { color: 'var(--muted)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }
const card: CSSProperties = { border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', padding: '10px 12px', margin: '8px 0' }
const primary: CSSProperties = { ...look.btn, background: 'var(--oxford)', color: '#fff', borderColor: 'var(--oxford)' }
const cells: CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(140px, 1.2fr) minmax(80px, 1fr) 16px minmax(80px, 1fr)', columnGap: 8, rowGap: 3, fontSize: 12, alignItems: 'baseline' }
const wrapPath: CSSProperties = { ...look.folderPath, whiteSpace: 'normal', overflowWrap: 'anywhere', marginTop: 2 }
const cut: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }

function Changes({ rows }: { rows: Array<{ label: string; from: string; to: string }> }): React.JSX.Element {
  return (
    <div style={cells} data-setup-folder="rows">
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'contents' }} data-setup-folder-row={r.label}>
          <span style={{ ...cut, fontWeight: 600 }} title={r.label}>{r.label}</span>
          <span style={{ ...cut, color: 'var(--muted)' }} title={r.from}>{r.from}</span>
          <span aria-hidden style={{ color: 'var(--faint)' }}>→</span>
          <span style={cut} title={r.to}>{r.to}</span>
        </div>
      ))}
    </div>
  )
}

export function SetupFolderPage(): React.JSX.Element {
  const [status, setStatus] = useState<SetupFolderStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void bridge().status().then(setStatus).catch(() => {})
    return bridge().onChange(setStatus)
  }, [])
  const act = (what: string, run: () => Promise<SetupFolderStatus | Reply | null>): void => {
    setBusy(what); setError(null)
    void run().then((r) => {
      if (!r) return
      if ('state' in r) { setStatus(r); return }
      if (!r.ok && r.error) setError(r.error)
      if (r.status) setStatus(r.status)
    }).catch(() => setError('That did not work. Try again.')).finally(() => setBusy(null))
  }

  const s = status
  const chosen = !!s && s.state !== 'off'
  const dismissedPreview = s?.state === 'joining' && s.notices.some((n) => n.kind === 'not-applied' && n.text.startsWith('Not applied yet'))
  const [showPreview, setShowPreview] = useState(false)
  const previewOpen = !!s?.preview && (!dismissedPreview || showPreview)
  const notices = (s?.notices ?? []).filter((n) => !(n.kind === 'not-applied' && n.text.startsWith('Not applied yet')))

  return (
    <div style={page} data-settings-page="setup-folder" data-setup-folder-state={s?.state ?? 'loading'}>
      <div style={look.sectionHead}>{T.title}</div>
      <div style={look.hint}>{T.intro}</div>

      <div style={{ padding: '6px 0' }}>
        <div style={look.folderLabel}>Folder</div>
        {chosen
          ? <div style={wrapPath} data-setup-folder="path">{s?.folder}</div>
          : <div style={{ ...look.hint, margin: '2px 0 0' }} data-setup-folder="path">{T.off}</div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          <button style={look.btn} disabled={!!busy} data-setup-folder="choose" onClick={() => act('choose', () => bridge().choose())}>{chosen ? T.change : T.choose}</button>
          {chosen && s?.state !== 'unavailable' && <button style={look.btnGhost} onClick={() => void bridge().reveal('')}>{T.showInFinder}</button>}
          {chosen && <button style={look.btnGhost} disabled={!!busy} data-setup-folder="stop" onClick={() => act('stop', () => bridge().stop())}>{T.stop}</button>}
        </div>
      </div>
      {s?.problem && <div style={{ ...look.hint, color: 'var(--crimson)' }} role="alert">{s.problem}</div>}
      {error && !notices.some((n) => n.text === error) && <div style={{ ...look.hint, color: 'var(--crimson)' }} role="alert" data-setup-folder="error">{error}</div>}

      {s?.state === 'joining' && s.preview && (previewOpen ? (
        <div style={card} data-setup-folder="preview">
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}>{T.joinHeading(s.preview.fromMacs)}</div>
          {s.preview.rows.length ? <Changes rows={s.preview.rows} /> : <div style={look.hint}>{T.joinNothing}</div>}
          <div style={{ ...look.hint, marginTop: 8 }}>{T.undoNote}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button style={primary} disabled={!!busy} data-setup-folder="apply" onClick={() => { setShowPreview(false); act('apply', () => bridge().apply(s.preview!.token)) }}>{busy === 'apply' ? 'Applying…' : T.apply}</button>
            <button style={look.btnGhost} disabled={!!busy} data-setup-folder="not-now" onClick={() => { setShowPreview(false); act('not-now', () => bridge().notNow()) }}>{T.notNow}</button>
          </div>
        </div>
      ) : (
        <div style={{ ...look.rowFolder }} data-setup-folder="not-applied">
          <div style={look.hint}>{T.notApplied}</div>
          <button style={look.btn} onClick={() => setShowPreview(true)}>{T.review}</button>
        </div>
      ))}

      {chosen && s && s.state !== 'unavailable' && (
        <>
          <div style={look.sectionHead}>{T.macsHeading}</div>
          {s.macs.map((m, i) => (
            <div key={`${i}-${m.macId}`} style={row} data-setup-folder-mac={m.name}>
              <span style={name}>{m.name}{m.thisMac ? ` (${T.thisMac})` : ''}</span>
              <span style={quiet}>{m.thisMac && s.state === 'joining' ? 'not written yet' : `last active ${whenText(m.lastActive)}`}{m.appVersion ? ` · TalkWeaver ${m.appVersion}` : ''}</span>
            </div>
          ))}
          <div style={{ ...look.rowFolder, paddingTop: 2 }}>
            <div style={look.hint}>Read {whenText(s.lastRead)}. Your other Macs read this Mac’s changes when their sync service brings them.</div>
            <button style={look.btnGhost} disabled={!!busy} data-setup-folder="read-now" onClick={() => act('read', () => bridge().readNow())}>{busy === 'read' ? 'Reading…' : T.readNow}</button>
          </div>
        </>
      )}

      {!!s?.suggestions.length && (
        <>
          <div style={look.sectionHead}>{T.suggestionsHeading}</div>
          {s.suggestions.some((g) => g.kind.startsWith('publishing.')) && <div style={look.hint}>{T.askFirst}</div>}
          {s.suggestions.map((g) => (
            <div key={g.kind} style={look.rowFolder} data-setup-folder-suggestion={g.kind}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={look.folderLabel}>{g.label} · on {g.macName}</div>
                <div style={look.folderPath} title={g.value}>{g.value}</div>
                {!g.canUse && g.why && <div style={look.hint}>{g.why}</div>}
              </div>
              <button style={look.btn} disabled={!!busy || !g.canUse} onClick={() => act(`use-${g.kind}`, () => bridge().use(g.kind))}>{busy === `use-${g.kind}` ? 'Saving…' : T.useHere}</button>
            </div>
          ))}
        </>
      )}

      {notices.length > 0 && (
        <div style={{ margin: '8px 0' }} data-setup-folder="notices">
          {notices.map((n, i) => (
            <div key={i} style={{ ...look.hint, overflowWrap: 'anywhere', color: n.kind === 'foreign' || n.kind === 'not-applied' || n.kind === 'rejected' || n.kind === 'not-restored' ? 'var(--crimson)' : n.kind === 'clock' || n.kind === 'tie' || n.kind === 'interrupted' || n.kind === 'copied' || n.kind === 'read-only' ? 'var(--amber)' : 'var(--muted)' }} data-setup-folder-notice={n.kind}>
              {n.text}
              {n.kind === 'foreign' && n.text.includes('same identity') && <> <button style={{ ...look.btn, marginLeft: 6 }} disabled={!!busy} onClick={() => act('new-file', () => bridge().newFile())}>Start a new file for this Mac</button></>}
            </div>
          ))}
        </div>
      )}

      {chosen && s && s.state === 'joined' && (
        <>
          <div style={look.sectionHead}>{T.recentHeading}</div>
          {s.history.length === 0 && <div style={{ ...look.hint, fontStyle: 'italic' }}>{T.recentNone}</div>}
          {s.history.slice(0, 8).map((h) => (
            <div key={h.id} style={card} data-setup-folder-batch={h.macName}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>From {h.macName}{h.unfinished ? ' (stopped part-way, not all put back)' : ''}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)', flex: 1 }}>{whenText(h.at)}</span>
                {h.undone ? <span style={{ fontSize: 12, color: 'var(--muted)' }}>Undone</span>
                  : <button style={look.btn} disabled={!!busy} data-setup-folder="undo" onClick={() => act(`undo-${h.id}`, () => bridge().undo(h.id))}>{T.undo}</button>}
              </div>
              <Changes rows={h.rows} />
            </div>
          ))}
          {s.history.length > 0 && <div style={look.hint}>{T.undoNote}</div>}
        </>
      )}

      {!!s?.skipped.length && (
        <>
          <div style={look.sectionHead}>{T.skippedHeading}</div>
          {s.skipped.map((k) => (
            <div key={k.file} style={look.rowFolder} data-setup-folder-skipped={k.reason}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ ...look.folderPath, color: 'var(--ink)' }} title={k.file}>{k.file}</div>
                <div style={look.hint}>{k.words}</div>
              </div>
              <button style={look.btnGhost} onClick={() => void bridge().reveal(k.file)}>{T.showInFinder}</button>
            </div>
          ))}
        </>
      )}

      {s?.leftFile && (
        <div style={{ padding: '8px 0' }} data-setup-folder="left-file">
          <div style={look.folderLabel}>This Mac’s file is still in the folder it used before</div>
          <div style={wrapPath}>{s.leftFile.folder}</div>
          <div style={look.hint}>Your other Macs go on reading it until it is removed. Removing it takes nothing away from this Mac.</div>
          <button style={look.btnGhost} disabled={!!busy} data-setup-folder="remove-own" onClick={() => act('remove', () => bridge().removeOwn())}>{T.remove}</button>
        </div>
      )}

      <div style={{ ...look.hint, marginTop: 14 }} data-setup-folder="holds">{T.holds} This Mac is listed there as {s?.thisMac.name ?? 'this Mac'}.</div>
      <div style={look.hint}>{T.never}</div>
      <div style={look.hint}>{T.downloads}</div>
      <div style={look.hint}>{T.reset}</div>
    </div>
  )
}
