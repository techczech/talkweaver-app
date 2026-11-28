import { useMemo, useState } from 'react'
import type { TalkInfo } from '../../../preload/index'
import { editFrontmatterText, parseFrontmatterPairs, type FrontmatterEdit } from '../../../shared/frontmatter-editor'
import { readOutlineSlides } from '../../../shared/feedback-accept'
import { inheritedTitleLookForSlide, inheritedTitleToneForSlide } from '../../../shared/deck-frame'
import RightPanelPictures from './RightPanelPictures'
import { PageHead } from './RightPanelPages'
import { TITLE_STYLES, type Design } from './rightPanelDesigns'
import DeckDesignPanel from './DeckDesignPanel'
import MetadataPanel from './MetadataPanel'
import type { TalkMetadata } from './useTalkMetadata'

// Both pages edit the open outline. Only raw YAML maps are held for explicit Save.
export default function TalkTab({ talk, outlineContent, onSaveDesign, metadata, page, onPage, onCopy, onMarkdown, onAbstract, onTry }: {
  talk: TalkInfo
  outlineContent: string
  page: 'details' | 'design'
  onPage: (page: 'details' | 'design') => void
  onCopy: (aspect: string) => void
  onMarkdown: () => void
  onAbstract: () => void
  onTry: (preview: import('./RightPanelPictures').PanelTry | null) => void
  onSaveDesign: (edits: FrontmatterEdit[]) => boolean
  metadata: TalkMetadata
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
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
        onClick={() => onPage(tab)}>{tab === 'details' ? 'Details' : 'Design'}</button>)}
    </div>
    {metadata.staged && <div className="tw-talk-draft-bar" data-talk-draft-bar>
      <span role="status">Unsaved changes to {metadata.staged}</span>
      <button type="button" className="toolbar-btn tw-agent-primary" disabled={metadata.busy}
        onClick={() => { void metadata.save() }}>Save changes</button>
    </div>}
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
      <DeckDesignPanel outlineContent={outlineContent} metadata={metadata} onSave={onSaveDesign} page={page} />
      {page === 'details' && <>
        <h3>For the audience</h3><button type="button" className="toolbar-btn" onClick={onAbstract}>Edit abstract</button>
        <details className="talk-tab-advanced" data-talk-section="advanced" open={advancedOpen}
          onToggle={event => setAdvancedOpen(event.currentTarget.open)}>
          <summary>Advanced: more details</summary>
          <button type="button" className="toolbar-btn" onClick={onMarkdown}>Show in Markdown</button>
          {advancedOpen && <MetadataPanel talk={talk} outlineContent={outlineContent} metadata={metadata} onEdit={onSaveDesign} />}
        </details>
      </>}
    </div>
  </div>
}
