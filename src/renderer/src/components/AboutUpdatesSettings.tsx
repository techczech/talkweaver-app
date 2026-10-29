import './AboutUpdatesSettings.css'
import { useEffect, useState } from 'react'
import {
  SETTING_HINT, aboutLines, answerView, cardView,
} from '@app-patterns/updates'
import { useUpdateSnapshot, viewContext, answerOf } from '../lib/updateNotices'
import { AnswerButtons } from './UpdateNotices'

// Settings › About and updates (update notices, ADR-0041; frames 03, 04 and 06): the running build's
// version and where this copy came from, and the New versions card with the switch
// `updates.checkForNewVersions`, the state of the last check, Check for updates, and a plain statement
// of what the check sends. A Store copy has no New versions card. Every word is from
// @app-patterns/updates; the style objects are SettingsPanel's own, handed in as `look`.

const STORE_ABOUT_DETAIL = 'TalkWeaver does not check for new versions itself in this copy. To see or change how the Store updates apps, open the Store’s settings.'

const STORE_ABOUT_LINE = 'The Microsoft Store installs new versions of TalkWeaver.'

const WHAT_THE_CHECK_SENDS = 'TalkWeaver reads one file, talkweaver.app/updates.json, and compares versions on this computer. It sends nothing about you, your talks or your version. Like any website, talkweaver.app sees this computer’s internet address.'

type Look = Record<'sectionHead' | 'hint' | 'rowFolder' | 'folderLabel' | 'btn', React.CSSProperties>

const card: React.CSSProperties = { border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden', margin: '8px 0 10px', background: 'var(--panel)' }
const cardHead: React.CSSProperties = { padding: '7px 12px', fontSize: 12.5, fontWeight: 700, background: 'var(--hover)', borderBottom: '1px solid var(--line)' }
const cardRow: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, padding: '9px 12px', borderTop: '1px solid var(--line)' }
const sub: React.CSSProperties = { fontSize: 11.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.4 }

export default function AboutUpdatesSettings({ look, record, onShowWhatsNew }: {
  look: Look
  record: (key: string, label: string, from: string, to: string) => void
  /** Close Settings and open the What's new tab. */
  onShowWhatsNew: () => void
}) {
  const snap = useUpdateSnapshot()
  const [asked, setAsked] = useState(false)
  const [hasNotes, setHasNotes] = useState(false)
  useEffect(() => {
    let live = true
    void window.tw?.updates?.whatsNew().then((n) => { if (live) setHasNotes(n !== null) }).catch(() => {})
    return () => { live = false }
  }, [])
  const api = typeof window === 'undefined' ? undefined : window.tw?.updates
  if (!snap || !api) return null
  const ctx = viewContext(snap)
  const about = aboutLines(ctx)
  // The card always follows the latest snapshot: a check's answer arrives as one, so no older local answer can outlast a newer one.
  const view = snap.waiting || (asked && snap.busy)
    ? answerOf({ ...snap, waiting: true })
    : asked && !snap.checking ? answerView(snap.state, ctx) : cardView(snap.state, ctx)
  const flip = (): void => {
    setAsked(false)
    const was = snap.enabled
    void api.setEnabled(!was).then(() => record('updates.checkForNewVersions', 'Check for new versions', was ? 'on' : 'off', was ? 'off' : 'on'))
  }
  return (
    <>
      <div style={look.sectionHead} data-settings-section="about">About and updates</div>
      <div style={card} data-about-card>
        <div style={cardHead}>TalkWeaver</div>
        <div style={{ ...cardRow, borderTop: 'none' }}>
          <div style={{ minWidth: 0 }}>
            <div style={look.folderLabel} data-about-version>{about.version}</div>
            <div style={sub} data-about-where>{about.where}</div>
          </div>
          {hasNotes && <button style={look.btn} data-about-whats-new onClick={onShowWhatsNew}>What&rsquo;s new in {snap.running}</button>}
        </div>
        {snap.source === 'store' && (
          <div style={cardRow} data-about-store>
            <div style={{ minWidth: 0 }}>
              <div style={look.folderLabel}>{STORE_ABOUT_LINE}</div>
              <div style={sub}>{STORE_ABOUT_DETAIL}</div>
            </div>
            <button style={look.btn} data-update-open-store onClick={() => void api.openStore()}>Open in Microsoft Store</button>
          </div>
        )}
      </div>
      {snap.source !== 'store' && (
        <div style={card} data-updates-card>
          <div style={cardHead}>New versions</div>
          <div style={{ ...cardRow, borderTop: 'none' }} data-setting="check-for-new-versions">
            <div style={{ minWidth: 0 }}>
              <div style={look.folderLabel}>Check for new versions</div>
              <div style={sub}>{SETTING_HINT}</div>
            </div>
            <button type="button" role="switch" aria-checked={snap.enabled} aria-label="Check for new versions" className="st-switch" onClick={flip} />
          </div>
          {view && (
            <div style={cardRow} data-update-state={view.tone}>
              <div style={{ minWidth: 0 }}>
                <div className={`apu-update-state--${view.tone}`} style={{ fontSize: 12.5, fontWeight: 600 }}>{view.title}</div>
                {view.detail && <div style={sub}>{view.detail}</div>}
              </div>
              {snap.checking
                ? <button className="apu-update-btn" disabled>Check for updates</button>
                : (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <AnswerButtons view={view} size="card" onView={() => setAsked(true)} />
                    {view.action !== 'check' && view.action !== 'try-again' && (
                      <button type="button" className="apu-update-btn" data-update-check onClick={() => { void api.check().then(() => setAsked(true)) }}>Check for updates</button>
                    )}
                  </div>
                )}
            </div>
          )}
          <div style={cardRow}>
            <div style={{ minWidth: 0 }}>
              <div style={look.folderLabel}>What the check sends</div>
              <div style={sub} data-update-sends>{WHAT_THE_CHECK_SENDS}</div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
