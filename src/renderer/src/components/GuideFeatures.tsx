import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Cloud, Copy, FileText, GitBranch, LayoutGrid, Link, Mic, Radio, RefreshCw, Sparkles, Upload, type LucideIcon } from 'lucide-react'
import { CONNECTS_NOTE, FEATURE_SECTIONS, TOPIC_STATUS, isRead } from '../../../shared/guide-topics'
import { CONNECTION_TEXT, type ConnectionActionId, type ConnectionRow } from '../../../shared/guide-connections'
import type { GuideLearn } from '../../../shared/guide-learn'

// Features to delight you (onboarding ticket 11; locked drawing states 10, 11 and 18): the first three
// sections list features with where to find each (a key, a menu); a row reads Read once it has been
// opened (clicked), kept in the Guide's record. The fourth section, What it connects to, has ten rows
// whose state is read from this Mac when the segment is opened and again on Check again; the Cloudflare,
// recording, share-address and transcription rows follow the statuses Settings → Cloudflare shows.

const ICONS: Record<string, LucideIcon> = {
  cloud: Cloud, radio: Radio, upload: Upload, mic: Mic, 'file-text': FileText, sparkles: Sparkles, 'git-branch': GitBranch, copy: Copy, 'layout-grid': LayoutGrid, link: Link
}

export interface GuideFeaturesProps {
  learn: GuideLearn
  onRead: (id: string) => void
  /** Reads this Mac and Settings: ten rows. Called when the segment is opened and on Check again, never at startup. */
  readConnections: () => Promise<ConnectionRow[]>
  onAction: (action: ConnectionActionId) => void
}

export default function GuideFeatures({ learn, onRead, readConnections, onAction }: GuideFeaturesProps): JSX.Element {
  return (
    <div data-guide-features>
      {FEATURE_SECTIONS.map((section) => (
        <div className="guide-card" key={section.n} data-feature-section={section.n}>
          <div className="guide-card-bar"><b>{section.n}. {section.title}</b></div>
          {section.n === 4
            ? <Connections readConnections={readConnections} onAction={onAction} />
            : section.groups.map((group, g) => (
              <div key={g}>
                {group.sub && <div className="guide-sub">{group.sub}</div>}
                <ul className="guide-rows">
                  {group.rows.map((row) => {
                    const read = isRead(learn, row.id)
                    return (
                      <li key={row.id}>
                        <button type="button" className="guide-crow guide-frow" data-feature-row={row.id} data-feature-state={read ? 'read' : 'none'} onClick={() => onRead(row.id)}>
                          <span className="guide-n">{row.n}</span>
                          <span className="guide-crow-name">{row.title}</span>
                          {read
                            ? <span className="guide-st guide-st--ok" data-feature-status><Check size={12} aria-hidden />{TOPIC_STATUS.read}</span>
                            : <span className="guide-hint" data-feature-hint>{row.hint}</span>}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
        </div>
      ))}
    </div>
  )
}

function Connections({ readConnections, onAction }: Pick<GuideFeaturesProps, 'readConnections' | 'onAction'>): JSX.Element {
  const [rows, setRows] = useState<ConnectionRow[] | null>(null)
  const [failed, setFailed] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const check = useCallback((): void => {
    setRows(null); setFailed(false)
    readConnections()
      .then((next) => { if (alive.current) { if (next.length) setRows(next); else setFailed(true) } })
      .catch(() => { if (alive.current) setFailed(true) })
  }, [readConnections])
  useEffect(() => { check() }, [check])
  return (
    <div data-guide-connects>
      <div className="guide-cnote">
        <span>{CONNECTS_NOTE}</span>
        <button type="button" className="guide-sq" aria-label={CONNECTION_TEXT.refresh} title={CONNECTION_TEXT.refresh} data-connections-refresh onClick={check}><RefreshCw size={12} aria-hidden /></button>
      </div>
      {rows === null && !failed && <div className="guide-cwait" data-connections-checking>{CONNECTION_TEXT.checking}</div>}
      {failed && <div className="guide-cwait" data-connections-failed>{CONNECTION_TEXT.unavailable}</div>}
      {rows?.map((row) => {
        const Icon = ICONS[row.icon] ?? Cloud
        return (
          <div className="guide-conn" key={row.id} data-connection={row.id} data-connection-state={row.state}>
            <span className="guide-cic"><Icon size={15} aria-hidden /></span>
            <div className="guide-conn-body">
              <div className="guide-conn-head">
                <b className="guide-conn-name">{row.name}</b>
                {row.action && (
                  <button
                    type="button" className="guide-gbtn" data-connection-action={row.action.id} disabled={!row.action.enabled}
                    onClick={() => onAction(row.action!.id)}
                  >{row.action.label}</button>
                )}
              </div>
              <span className={`guide-cstate guide-cstate--${row.state}`} data-connection-text>{row.stateText}</span>
              <span className="guide-cdim">{row.need}</span>
              <span className="guide-cdim">{CONNECTION_TEXT.withoutIt} {row.without}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
