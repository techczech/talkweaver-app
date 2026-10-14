import { useEffect, useRef, useState } from 'react'
import type { CloudflareReply, CloudflareStatus, GoingLiveRow, LiveSetUpReply, RecordingStorageRow } from '../../../preload/index'
import {
  HOW_TO_MAKE_A_TOKEN, PUBLISHING_ROW_NAME, TOKEN_PERMISSIONS, connectionActions, connectionLabel,
  publishingRowDetail, publishingRowEdge, publishingRowLink, SHARE_LINK_ROW_NAME, shareLinkRowDetail, shareLinkRowEdge, type RowEdge,
} from '../../../shared/cloudflare-status'
import { GOING_LIVE_ROW_NAME, TRY_AGAIN, goingLiveRowDetail, goingLiveRowEdge, goingLiveRowRetries } from '../../../shared/live-service-status'
import { RECORDING_ROW_NAME, SET_UP_RECORDING_STORAGE, recordingRowCanCheck, recordingRowDetail, recordingRowEdge } from '../../../shared/recording-storage-status'
import { notify } from '../lib/notify'

// Settings → Cloudflare: the connection header (its buttons at the right) and the feature rows, one
// bounded list of bordered rows with the state at the right-hand edge (spec
// docs/plans/cloudflare-setup-in-app, "States" and Dominik's answers of 8 Oct). Every word shown for a state comes from
// src/shared/cloudflare-status.ts; this file only lays them out, in the look of the other Settings
// sections (the style objects are SettingsPanel's own, handed in as `look`).
//
// The token is typed here and goes one way, into the main process. It is never read back: the
// window only ever holds a CloudflareStatus. Nothing here waits for Cloudflare: each call returns to
// the main process's queue and the rows follow the statuses it pushes, so editing and presenting go
// on while a check runs.
//
// The Going live and sharing row (ticket 05) follows what the main process pushes (live-service.ts):
// "Set up going live" sets the live service up there, with its progress pushed back as the row.
//
// The Recording storage row is not the token's: recordings use their own access keys, typed under
// Recording storage further down and never read back. This window holds only a RecordingStorageRow
// (a state, the bucket's name, fixed sentences). Its Check lists the bucket once: a read. While
// storage is not set up the row offers "Set up recording storage", which brings those fields into
// view (they sit below the Cloudflare fields, too far down to be found from the row's words alone).

type Look = Record<'sectionHead' | 'hint' | 'rowFolder' | 'folderLabel' | 'folderPath' | 'btn' | 'btnGhost' | 'inputStyle' | 'kbd', React.CSSProperties>

interface Props {
  look: Look
  /** Record a change in the settings changelog (presence only for the token). */
  record: (key: string, label: string, from: string, to: string) => void
  /** The main process may have filled in the account or the site: the fields below are read again. */
  onStatus: () => void
  /** "Set up recording storage": bring Settings → Recording storage (endpoint, bucket, access keys) into view. */
  onSetUpRecording: () => void
}

export const tone = { good: 'var(--oxford)', quiet: 'var(--faint)', warn: '#b8860b' }
// The feature rows: one bounded list, a rule between rows (Settings → Transcription's row uses the same form), in the Settings panel's own colours and
// corner radius (the same border the panel's inputs and buttons use).
export const featureList: React.CSSProperties = { border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden', margin: '8px 0 10px', background: 'var(--panel)' }
export const featureRow: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, padding: '9px 12px', borderTop: '1px solid var(--line)', marginTop: -1,
}
/** A row's one line of detail: the Settings panel's small grey text, in the reading face, never cut off. */
export const rowDetail = (look: Pick<Look, 'folderPath'>): React.CSSProperties => ({ ...look.folderPath, fontFamily: 'inherit', whiteSpace: 'normal', overflow: 'visible' })
export const rowState: React.CSSProperties = { fontSize: 12.5, fontWeight: 600, flexShrink: 0, textAlign: 'right', maxWidth: '46%' }

export default function CloudflareSettings({ look, record, onStatus, onSetUpRecording }: Props) {
  const [status, setStatus] = useState<CloudflareStatus | null>(null)
  const [token, setToken] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [howTo, setHowTo] = useState(false)
  const [details, setDetails] = useState(false)
  const [account, setAccount] = useState('')
  const [recording, setRecording] = useState<RecordingStorageRow | null>(null)
  const [live, setLive] = useState<GoingLiveRow | null>(null)
  const told = useRef(onStatus)
  told.current = onStatus

  useEffect(() => {
    let open = true
    const take = (next: CloudflareStatus): void => { if (open) { setStatus(next); told.current() } }
    const stop = window.tw.cloudflare.onStatus(take)
    void window.tw.cloudflare.status().then(take).catch(() => {})
    // Opening this screen asks Cloudflare (the main process does so at most once a minute).
    void window.tw.cloudflare.check('opened').catch(() => {})
    return () => { open = false; stop(); setToken('') }
  }, [])

  // The Recording storage row follows what the main process pushes (keys saved, settings saved, a check).
  useEffect(() => {
    let open = true
    const take = (next: RecordingStorageRow): void => { if (open) setRecording(next) }
    const stop = window.tw.recording.onStorageStatus(take)
    void window.tw.recording.storageStatus().then(take).catch(() => {})
    return () => { open = false; stop() }
  }, [])

  // The Going live and sharing row follows what the main process pushes (a set-up's progress, a lookup, a change of connection).
  useEffect(() => {
    let open = true
    const take = (next: GoingLiveRow): void => { if (open) setLive(next) }
    const stop = window.tw.liveService.onStatus(take)
    void window.tw.liveService.status().then(take).catch(() => {})
    return () => { open = false; stop() }
  }, [])
  const setUpLive = (): void => {
    void window.tw.liveService.setUp().then((reply: LiveSetUpReply) => {
      setLive(reply.row)
      // The row says what happened; a refusal that is not the row's own words is shown too.
      if (!reply.ok && reply.row.state !== 'failed' && reply.row.state !== 'no-permission') notify(reply.error, 'error')
      // A success with something to say: the update was uploaded and Cloudflare has not switched to it yet.
      if (reply.ok && reply.notice) notify(reply.notice, 'info')
    }).catch(() => {})
  }

  /** Show a refusal; the rows themselves follow the pushed statuses. */
  const settle = (reply: CloudflareReply): CloudflareReply => {
    setStatus(reply.status)
    if (!reply.ok && reply.error !== reply.status.notice) notify(reply.error, 'error')
    return reply
  }
  const saveToken = (): void => {
    const had = status && status.connection.state !== 'no-token' && status.connection.state !== 'storage-unavailable' ? 'set' : 'not set'
    const typed = token
    setToken('') // the field never keeps a token once it has been handed over
    void window.tw.cloudflare.saveToken(typed).then(settle).then((reply) => {
      if (!reply.ok) return
      setReplacing(false)
      record('publish.token', 'Cloudflare — token', had, 'set') // presence only: a secret's value never enters the changelog
    }).catch(() => notify('The token could not be saved.', 'error'))
  }
  const disconnect = (): void => {
    void window.tw.cloudflare.disconnect().then(settle).then((reply) => {
      if (reply.ok) { setReplacing(false); record('publish.token', 'Cloudflare — token', 'set', 'not set') }
    }).catch(() => {})
  }

  if (!status) {
    return (<>
      <div style={look.sectionHead}>Cloudflare</div>
      <div style={look.hint}>Loading…</div>
    </>)
  }

  const { connection, publishing, liveService, shareLink } = status
  const actions = connectionActions(connection)
  const offers = (action: (typeof actions)[number]): boolean => actions.includes(action)
  const busy = status.busy
  const pasting = offers('paste-token') || (replacing && offers('replace-token'))
  const greyed = (stale: boolean): React.CSSProperties => (stale ? { opacity: 0.5 } : {})
  const connectionTone = connection.state === 'connected' ? tone.good : connection.state === 'no-token' || connection.state === 'checking' ? tone.quiet : tone.warn
  const chosen = connection.state === 'choose-account' ? (connection.accounts.some((entry) => entry.id === account) ? account : connection.accounts[0]?.id ?? '') : ''
  /** A row's right-hand edge: its state in words, its one action, or nothing at all (never a dash). */
  const edge = (shown: RowEdge, name: string, act?: () => void, beside = false): React.ReactNode => {
    if (shown.kind === 'none') return null
    if (shown.kind === 'action') {
      return <button style={{ ...look.btn, borderColor: 'var(--oxford)', color: 'var(--oxford)' }} disabled={busy} onClick={act} data-cloudflare={name}>{shown.label}</button>
    }
    // A state that stands beside a button keeps to one line (its width is then its own, not a share of the row's).
    return <div style={{ ...rowState, ...(beside ? { maxWidth: 'none', whiteSpace: 'nowrap' } : {}), color: tone[shown.tone] }} data-cloudflare={name}>{shown.text}</div>
  }

  return (<>
    <div style={look.sectionHead} data-cloudflare="section">Cloudflare</div>
    <div style={look.hint}>
      One Cloudflare token publishes handouts, runs going live and sharing, and attaches the share-link address.
      It is kept in this computer&apos;s secure storage, never in a file.
    </div>

    {/* ── The connection ─────────────────────────────────────── */}
    <div style={look.rowFolder} data-cloudflare="connection" data-state={connection.state} data-busy={busy ? 'yes' : 'no'}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ ...look.folderLabel, color: connectionTone }} data-cloudflare="connection-label">{connectionLabel(connection)}</div>
        {busy && connection.state !== 'checking' && <div style={look.folderPath}>Checking…</div>}
        {status.notice && <div style={{ ...look.folderPath, color: tone.warn, whiteSpace: 'normal' }} data-cloudflare="notice">{status.notice}</div>}
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        {offers('check-again') && (
          <button style={look.btn} disabled={busy} onClick={() => void window.tw.cloudflare.check('asked').then(settle).catch(() => {})}>Check again</button>
        )}
        {offers('replace-token') && !replacing && (
          <button style={look.btn} onClick={() => setReplacing(true)}>Replace token</button>
        )}
        {offers('disconnect') && (
          <button style={look.btnGhost} onClick={disconnect}>Disconnect</button>
        )}
      </div>
    </div>

    {offers('choose-account') && connection.state === 'choose-account' && connection.accounts.length > 0 && (
      <div style={look.rowFolder} data-cloudflare="account-picker">
        <div style={{ minWidth: 0, flex: 1 }}>
          <select
            style={look.inputStyle}
            aria-label="Cloudflare account"
            value={chosen}
            onChange={(event) => setAccount(event.target.value)}
          >
            {connection.accounts.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
        </div>
        <button style={look.btn} disabled={busy || !chosen} onClick={() => void window.tw.cloudflare.chooseAccount(chosen).then(settle).catch(() => {})}>
          Use this account
        </button>
      </div>
    )}

    {pasting && (
      <form style={look.rowFolder} data-cloudflare="token" onSubmit={(event) => { event.preventDefault(); if (token.trim()) saveToken() }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <input
            style={look.inputStyle}
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label="Cloudflare API token"
            value={token}
            placeholder="Cloudflare API token"
            onChange={(event) => setToken(event.target.value)}
          />
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'flex-end' }}>
          {replacing && <button type="button" style={look.btnGhost} onClick={() => { setReplacing(false); setToken('') }}>Cancel</button>}
          <button type="submit" style={{ ...look.btn, opacity: token.trim() ? 1 : 0.5 }} disabled={!token.trim()}>Save token</button>
        </div>
      </form>
    )}

    {(offers('how-to') || pasting) && (
      <div style={{ padding: '2px 0 6px' }}>
        <button style={look.btnGhost} aria-expanded={howTo} onClick={() => setHowTo((shown) => !shown)}>How to make a token</button>
        {howTo && (
          <div style={{ ...look.hint, marginTop: 8 }} data-cloudflare="how-to">
            <ol style={{ margin: '0 0 8px', paddingLeft: 18 }}>
              {HOW_TO_MAKE_A_TOKEN.map((step) => <li key={step}>{step}</li>)}
            </ol>
            {TOKEN_PERMISSIONS.map((entry) => (
              <div key={entry.feature} style={{ padding: '2px 0' }}>
                <b>{entry.feature}</b>{': '}
                {entry.permissions.map((permission) => <kbd key={permission} style={look.kbd}>{permission}</kbd>)}
                {entry.note && <span>{entry.permissions.length ? ` (${entry.note})` : entry.note}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    )}

    {/* ── The feature rows: one bounded list of bordered rows. Name and one line of detail at the
        left; the state, or the one action, at the right-hand edge (the approved sketch). ───────── */}
    <div style={featureList} role="list" aria-label="Cloudflare features" data-cloudflare="features">
      <div
        role="listitem"
        style={{ ...featureRow, ...greyed(publishing.stale) }}
        data-cloudflare="publishing" data-state={publishing.state} data-stale={publishing.stale ? 'yes' : 'no'}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={look.folderLabel}>{PUBLISHING_ROW_NAME}</div>
          <div style={rowDetail(look)} data-cloudflare="publishing-detail">
            {(() => {
              // Ready: the handout web address itself, a link that opens it.
              const link = publishingRowLink(publishing)
              if (!link) return publishingRowDetail(publishing)
              const text = publishingRowDetail(publishing)
              return (<>
                {text.slice(0, text.length - link.label.length)}
                <a
                  href={link.href}
                  data-cloudflare="publishing-address"
                  style={{ color: 'var(--oxford)' }}
                  onClick={(event) => { event.preventDefault(); void window.tw.shell.openExternal(link.href) }}
                >{link.label}</a>
              </>)
            })()}
          </div>
        </div>
        {edge(publishingRowEdge(publishing), 'publishing-label', () => void window.tw.cloudflare.createSite().then(settle).catch(() => {}))}
      </div>

      {live && (
        <div
          role="listitem"
          style={{ ...featureRow, ...greyed(live.state === 'no-permission' && liveService.stale) }}
          data-cloudflare="live-service" data-state={live.state} data-phase={live.phase ?? ''}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={look.folderLabel}>{GOING_LIVE_ROW_NAME}</div>
            <div style={rowDetail(look)} data-cloudflare="live-service-detail">{goingLiveRowDetail(live)}</div>
          </div>
          {goingLiveRowRetries(live) ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
              {edge(goingLiveRowEdge(live), 'live-service-label', undefined, true)}
              <button style={look.btn} onClick={setUpLive} data-cloudflare="live-service-retry">{TRY_AGAIN}</button>
            </div>
          ) : edge(goingLiveRowEdge(live), 'live-service-label', setUpLive)}
        </div>
      )}

      <div
        role="listitem"
        style={{ ...featureRow, ...greyed(shareLink.stale) }}
        data-cloudflare="share-link" data-state={shareLink.state} data-stale={shareLink.stale ? 'yes' : 'no'}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={look.folderLabel}>{SHARE_LINK_ROW_NAME}</div>
          <div style={rowDetail(look)} data-cloudflare="share-link-detail">{shareLinkRowDetail(shareLink)}</div>
        </div>
        {edge(shareLinkRowEdge(shareLink), 'share-link-label', () => void window.tw.cloudflare.useShareDomain().then(settle).catch(() => {}))}
      </div>

      {recording && (
        <div role="listitem" style={featureRow} data-cloudflare="recording-storage" data-state={recording.state} data-checking={recording.checking ? 'yes' : 'no'}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={look.folderLabel}>{RECORDING_ROW_NAME}</div>
            <div style={rowDetail(look)} data-cloudflare="recording-storage-detail">{recordingRowDetail(recording)}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            {edge(recordingRowEdge(recording), 'recording-storage-label', undefined, true)}
            {recording.state === 'not-set-up' && (
              <button style={look.btn} data-cloudflare="recording-storage-set-up" onClick={onSetUpRecording}>{SET_UP_RECORDING_STORAGE}</button>
            )}
            {recording.state !== 'not-set-up' && (
              <button
                style={look.btn}
                disabled={!recordingRowCanCheck(recording)}
                data-cloudflare="recording-storage-check"
                onClick={() => void window.tw.recording.checkStorage().then(setRecording).catch(() => {})}
              >
                Check
              </button>
            )}
          </div>
        </div>
      )}

    </div>

    {(status.details || live?.details) && (
      <div style={{ padding: '0 0 6px' }}>
        <button style={look.btnGhost} aria-expanded={details} onClick={() => setDetails((shown) => !shown)}>Details</button>
        {details && status.details && <div style={{ ...look.folderPath, whiteSpace: 'normal', marginTop: 6 }} data-cloudflare="details">{status.details}</div>}
        {/* The live service's build and address, or which step of its set-up failed (numbers only). */}
        {details && live?.details && <div style={{ ...look.folderPath, whiteSpace: 'normal', marginTop: 6 }} data-cloudflare="live-service-details">Going live: {live.details}</div>}
      </div>
    )}
  </>)
}
