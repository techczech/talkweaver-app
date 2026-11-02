// The big preview of one item. Pictures and SVG show as images. An agent's HTML page runs only when asked,
// in the same sandbox an `[Embed: assets/….html]` page gets (main builds the document; see
// src/main/scratchpad-html.ts): an iframe with the sandbox main names, an opaque origin, no preload.
import { useEffect, useState } from 'react'
import type { ScratchGroup, ScratchItem } from '../../../../shared/scratchpad'
import { ItemBadges, ItemThumb } from './ScratchpadCard'

export function ScratchpadPreview({ item, group, onBack, actions, note = null, inTalk = false }: {
  inTalk?: boolean
  item: ScratchItem
  group: ScratchGroup | null
  onBack: () => void
  actions: JSX.Element
  /** Where an insert goes (ticket 2's placement note), under the actions. */
  note?: JSX.Element | null
}): JSX.Element {
  const [live, setLive] = useState<{ url: string; sandbox: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setLive(null); setError(null) }, [item.id])
  const run = async (): Promise<void> => {
    const reply = await window.tw.scratchpad.htmlPreview(item.id)
    if (reply.ok) setLive({ url: reply.url, sandbox: reply.sandbox })
    else setError(reply.error)
  }
  const isPage = item.kind === 'file' && item.fileKind === 'html' && !item.missing
  return (
    <div className="sp-preview">
      <div className="sp-preview-top">
        <button type="button" className="sp-btn sp-btn--sm" onClick={onBack}>← Back to the list</button>
        <h2>{item.title}</h2>
        <ItemBadges item={item} inTalk={inTalk} />
        {group && <span className="sp-badge">{group.name}</span>}
      </div>
      <div className="sp-preview-view">
        {isPage ? (
          live ? (
            <iframe
              className="sp-preview-frame"
              title={`Preview: ${item.title}`}
              src={live.url}
              sandbox={live.sandbox}
              // @ts-expect-error `credentialless` is not in React's iframe typings yet; the compiled embeds carry it too.
              credentialless=""
              referrerPolicy="no-referrer"
              allow="autoplay; fullscreen"
            />
          ) : (
            <div className="sp-preview-run">
              <button type="button" className="sp-btn sp-btn--primary" onClick={() => void run()}>Run interactive</button>
              <p className="sp-sandbox-note">Runs in a sandbox: it cannot see your talk or your files.</p>
              {error && <p className="sp-error">{error}</p>}
            </div>
          )
        ) : (
          <ItemThumb item={item} big />
        )}
      </div>
      {item.description && <p className="sp-preview-desc">{item.description}</p>}
      {item.sources.length > 0 && (
        <ul className="sp-preview-sources">
          {item.sources.map((s) => <li key={s.url}>{s.label} <span>{s.url}</span></li>)}
        </ul>
      )}
      <div className="sp-preview-meta">
        {item.kind === 'file' ? <>File <code>{item.file}</code> in this talk&rsquo;s scratch folder</> : <>Picked from {item.slide?.talkTitle}</>}
      </div>
      {item.kind === 'slide' && item.slide && <pre className="sp-preview-text">{item.slide.markdown}</pre>}
      <div className="sp-preview-actions">{actions}</div>
      {note}
    </div>
  )
}
