import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import type { TalkActivityEntry } from '../../../preload/index'
import { activityTime } from './talkActivityModel'

// The talk's Activity list in the Inspector (several-vaults ticket 09; architecture.md, "Decisions
// after the locked mockups"; LOCKED-conflict frame 5): what the app did to the talk by itself, such as
// removing a byte-identical conflict copy. Read from app data (never the vault); shown only when the
// talk has a line. Read-only.

export default function TalkActivity({ outlinePath }: { outlinePath: string }) {
  const [lines, setLines] = useState<TalkActivityEntry[]>([])
  useEffect(() => {
    let live = true
    const load = (): void => { void window.tw.vault.talkActivity(outlinePath).then((r) => { if (live) setLines(Array.isArray(r) ? r : []) }).catch(() => {}) }
    load()
    const off = window.tw.vault.onTalkActivityChanged(load)
    return () => { live = false; off() }
  }, [outlinePath])
  if (lines.length === 0) return null
  return (
    <section className="tw-talk-activity" aria-label="Activity" data-talk-activity>
      <h3>Activity</h3>
      {lines.map((line, i) => (
        <div className="tw-talk-activity-row" key={`${line.at}:${i}`} data-activity-kind={line.kind}>
          <span className="tw-talk-activity-mark"><Check size={12} strokeWidth={3} /></span>
          <div className="tw-talk-activity-text">
            <div className="tw-talk-activity-title">{line.title}</div>
            {line.detail && <div className="tw-talk-activity-detail">{line.detail}</div>}
          </div>
          <span className="tw-talk-activity-time" title={line.at}>{activityTime(line.at)}</span>
        </div>
      ))}
    </section>
  )
}
