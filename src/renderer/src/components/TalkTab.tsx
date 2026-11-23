import { useEffect, useMemo, useState } from 'react'
import type { TalkInfo } from '../../../preload/index'
import { editFrontmatterText, parseFrontmatterPairs, type FrontmatterEdit } from '../../../shared/frontmatter-editor'
import { readOutlineSlides } from '../../../shared/feedback-accept'
import { inheritedTitleLookForSlide, inheritedTitleToneForSlide } from '../../../shared/deck-frame'
import RightPanelPictures from './RightPanelPictures'
import { PageHead } from './RightPanelPages'
import { TITLE_STYLES, type Design } from './rightPanelDesigns'
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
export default function TalkTab({ talk, outlineContent, onSaveDesign, flushBeforeIO, onSaved, startPage, onCopy, onMarkdown, onAbstract, onTry }: {
  talk: TalkInfo
  outlineContent: string
  startPage: 'details' | 'design'
  onCopy: (aspect: string) => void
  onMarkdown: () => void
  onAbstract: () => void
  onTry: (preview: import('./RightPanelPictures').PanelTry | null) => void
  onSaveDesign: (edits: FrontmatterEdit[]) => void
  /** Awaited before Advanced reads the outline from disk, so the live editor's autosave lands first. */
  flushBeforeIO: () => Promise<void>
  /** A write through Advanced landed: the Talks list's title, subtitle and event may have changed. */
  onSaved: () => void
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [page, setPage] = useState(startPage)
  useEffect(() => { setPage(startPage) }, [startPage])
  const read = useMemo(() => readOutlineSlides(outlineContent), [outlineContent])
  const sample = read.slides.find(slide => slide.level >= 3 && !slide.folded)
  const palette = parseFrontmatterPairs(outlineContent).find(pair => pair.key === 'palette')?.value ?? ''
  const look = inheritedTitleLookForSlide(outlineContent, sample?.line ?? null)
  const tone = inheritedTitleToneForSlide(outlineContent, sample?.line ?? null)
  const themes = [['Ocean', ''], ['Ocean, bold amber', 'bold'], ['Forest', 'forest'], ['Slate', 'slate'], ['Classic', 'classic'], ['Green (classic)', 'green']] as const
  const themeEdits = (design: Design): FrontmatterEdit[] => [{ key: 'palette', value: themes.find(([label]) => label === design.label)?.[1] || null }]
  const titleEdits = (design: Design): FrontmatterEdit[] => {
    const style = TITLE_STYLES.find(([label]) => label === design.label)
    return style ? [
      { key: 'title_look', aliases: ['title-look'], value: style[1].split('=')[1] ?? 'default' },
      { key: 'title_look_tone', aliases: ['title-look-tone'], value: style[2] ? 'soft' : null }
    ] : []
  }
  const pictureProps = sample ? {
    path: talk.outlinePath, text: outlineContent, slide: sample.id || { headingLine: sample.line },
    layout: 'list', onTry, currentLabel: 'Talk'
  } : null
  return <div className="pane pane--talk" data-talk-tab>
    <div className="tw-talk-switch tw-right-choice" role="group" aria-label="Talk settings">
      {(['details', 'design'] as const).map(tab => <button type="button" key={tab} className="toolbar-btn" aria-pressed={page === tab}
        onClick={() => { onTry(null); setPage(tab) }}>{tab === 'details' ? 'Details' : 'Design'}</button>)}
    </div>
    <div className="tw-talk-settings">
      {page === 'design' && <>
        <p className="tw-right-origin">Applies to every slide that has not been changed on its own.</p>
        {pictureProps && <><PageHead label="Theme" aspect="talkdesign" />
          <RightPanelPictures {...pictureProps} group="talk-theme" choices={themes.map(([label, value]) => ({ label, current: palette === value }))}
            previewChoice={design => editFrontmatterText(outlineContent, themeEdits(design))} onKeep={design => onSaveDesign(themeEdits(design))} />
          <PageHead label="Titles" aspect="talkdesign" onCopy={onCopy} />
          <RightPanelPictures {...pictureProps} group="talk-titles" choices={TITLE_STYLES.slice(0, 6).map(([label, token, strength]) => ({
            label, current: (token.split('=')[1] ?? '') === look && (label !== 'Tab' && label !== 'Soft tab' || !!strength === !!tone)
          }))} previewChoice={design => editFrontmatterText(outlineContent, titleEdits(design))} onKeep={design => onSaveDesign(titleEdits(design))} />
        </>}
        {!pictureProps && <PageHead label="Design" aspect="talkdesign" onCopy={onCopy} />}
      </>}
      <DeckDesignPanel isOpen outlineContent={outlineContent} activeTalk={talk} onSave={onSaveDesign} page={page} />
      {page === 'details' && <>
        <h3>For the audience</h3><button type="button" className="toolbar-btn" onClick={onAbstract}>Edit abstract</button>
        <details className="talk-tab-advanced" data-talk-section="advanced" open={advancedOpen}
          onToggle={event => setAdvancedOpen(event.currentTarget.open)}>
          <summary>Advanced: more details</summary>
          <button type="button" className="toolbar-btn" onClick={onMarkdown}>Show in Markdown</button>
          {advancedOpen && <MetadataPanel talk={talk} isOpen flushBeforeIO={flushBeforeIO} onSaved={onSaved} />}
        </details>
      </>}
    </div>
  </div>
}
