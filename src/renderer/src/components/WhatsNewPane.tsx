import { useEffect, useState } from 'react'
import type { WhatsNewItem } from '@app-patterns/updates'

// The What's new tab in the right-hand column (update notices, ADR-0041; frame 07): the short notes
// shipped inside the app for the running version, so nothing is fetched. It opens only when asked.
export default function WhatsNewPane() {
  const [notes, setNotes] = useState<{ version: string; from: string | null; items: WhatsNewItem[] } | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    const api = window.tw?.updates
    if (!api) { setNotes(null); return }
    void api.whatsNew().then((n) => { if (live) setNotes(n) }).catch(() => { if (live) setNotes(null) })
    return () => { live = false }
  }, [])
  const api = window.tw?.updates
  return (
    <div className="pane pane--whats-new" data-whats-new-pane>
      {notes === undefined && null}
      {notes === null && <div className="tw-update-sub">There are no notes for this version.</div>}
      {notes && (
        <>
          <h2>What&rsquo;s new in {notes.version}</h2>
          <div className="tw-update-sub">{notes.from ? `You updated from ${notes.from}.` : 'Notes for the version you are running.'}</div>
          <dl>
            {notes.items.map((item, index) => (
              <div key={index}>
                {item.title && <dt>{item.title}</dt>}
                <dd>{item.text}</dd>
              </div>
            ))}
          </dl>
          <div className="apu-update-actions" style={{ marginTop: 14 }}>
            <button type="button" className="apu-update-btn" data-whats-new-full onClick={() => void api?.openNotes(notes.version)}>Full release notes on talkweaver.app</button>
          </div>
        </>
      )}
    </div>
  )
}
