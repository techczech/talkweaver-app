import { useState } from 'react'
import type { TalkInfo } from '../../../preload/index'
import type { FrontmatterEdit } from '../../../shared/frontmatter-editor'
import { plainTalkTitle } from '../../../shared/plain-title'
import DeckDesignPanel from './DeckDesignPanel'
import MetadataPanel from './MetadataPanel'

// The Talk tab of the right sidebar (house rules R11 and R11a): the one place a talk's details are edited.
// It holds what the Talk design dialog and the Metadata dialog edited, with the same field components and the same
// writes (`onSaveDesign` is WorkspaceLayout's handleDeckDesignSave, the Advanced part writes through
// `window.tw.metadata.editFrontmatter`), grouped in plain words:
//   Details   title, subtitle, event, author, date …           (Talk design's fields, the identity ones)
//   Design    the talk-wide design settings                     (Talk design's other fields)
//   Advanced  the keys outside the deck, unrecognised keys and the keys TalkWeaver manages, behind a disclosure
// Every other way in (the Talk menu's Talk design… and Metadata…, the palette, the Plain view's Talk details line,
// the Markdown view's Metadata table, the Talks list's Metadata…) opens this tab.
export default function TalkTab({ talk, outlineContent, onSaveDesign, flushBeforeIO, onSaved }: {
  talk: TalkInfo
  outlineContent: string
  onSaveDesign: (edits: FrontmatterEdit[]) => void
  /** Awaited before Advanced reads the outline from disk, so the live editor's autosave lands first. */
  flushBeforeIO: () => Promise<void>
  /** A write through Advanced landed: the Talks list's title, subtitle and event may have changed. */
  onSaved: () => void
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  return (
    <div className="pane pane--talk" data-talk-tab>
      <div className="talk-tab-head">
        <div className="talk-tab-title" data-talk-tab-title>{plainTalkTitle(talk.title)}</div>
        <div className="talk-tab-sub">Details and design for this talk</div>
      </div>
      <DeckDesignPanel isOpen outlineContent={outlineContent} activeTalk={talk} onSave={onSaveDesign} />
      <details
        className="talk-tab-advanced"
        data-talk-section="advanced"
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen((event.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>Advanced: more details</summary>
        {advancedOpen && (
          <MetadataPanel talk={talk} isOpen flushBeforeIO={flushBeforeIO} onSaved={onSaved} />
        )}
      </details>
    </div>
  )
}
