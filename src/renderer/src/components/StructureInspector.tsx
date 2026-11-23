import { useState } from 'react'
import { ChevronLeft, ChevronRight, Ellipsis, LayoutTemplate, Palette, Plus, Type } from 'lucide-react'
import { GLOBAL_OPTION_GROUPS, sectionColourChoices } from '../../../shared/layout-registry/entries'
import { parseFrontmatterPairs } from '../../../shared/frontmatter-editor'
import { LAYOUTS } from '../data/layouts'
import InspectorOptionPictures from './InspectorOptionPictures'
import type { LayoutDef, OptionGroup } from '../data/layouts'

const modes = GLOBAL_OPTION_GROUPS.find(group => group.key === 'container-mode')!
const colourEntry = LAYOUTS.find(entry => entry.name === 'section-colour')!
const colours = colourEntry.options![0]
const titleSize = GLOBAL_OPTION_GROUPS.find(group => group.key === 'font-title')!
const sectionDesigns = [
  { token: '', label: 'One after another', description: 'The slides follow this one' },
  { token: 'contents', label: 'Contents', description: 'Lists the slides in this section' },
  { token: 'grid-zoom', label: 'Grid', description: 'The slides as tiles to pick from' }
]
const modeNames: Readonly<Record<string, string>> = {
  '': 'One after another', contents: 'Contents', 'grid-linear': 'Grid', 'grid-zoom': 'Grid and zoom', carousel: 'Carousel'
}

interface Props {
  path: string
  text: string
  line: number
  id: string
  title: string
  label: string
  childCount: number
  sectionCarousel: boolean
  tokenIn: (group: OptionGroup) => string
  commit: (entry: LayoutDef | undefined, group: OptionGroup, token: string) => void
  editTitle: () => void
  more: () => void
  previous: () => void
  next: () => void
  panes?: { title: string; select: () => void }[]
  addSubslide?: () => void
  inheritedColour?: { value: string; selectSection: () => void }
}

export default function StructureInspector({ path, text, line, id, title, label, childCount, sectionCarousel, tokenIn,
  commit, editTitle, more, previous, next, panes, addSubslide, inheritedColour }: Props) {
  const [page, setPage] = useState<'home' | 'colour' | 'title' | 'subslides'>('home')
  const mode = tokenIn(modes)
  const sectionMode = mode === 'grid-linear' ? 'grid-zoom' : mode
  const sectionChoices = sectionCarousel || mode === 'carousel'
    ? [...sectionDesigns, { token: 'carousel', label: 'Carousel', description: 'One subslide at a time' }]
    : sectionDesigns
  const colour = inheritedColour?.value ?? tokenIn(colours)
  const palette = parseFrontmatterPairs(text).find(pair => pair.key === 'palette')?.value
  const colourChoices = sectionColourChoices(palette)
  const colourName = colourChoices.find(value => value.token === colour)?.label ?? 'Rotation'
  return <div className="tw-structure-inspector">
    <div className="tw-structure-inspector-heading">
      <div><strong>{title || `New ${label.toLowerCase()}`}</strong><small>{label}</small></div>
      <button type="button" className="toolbar-btn" aria-label="Previous slide" onClick={previous}><ChevronLeft size={16} /></button>
      <button type="button" className="toolbar-btn" aria-label="Next slide" onClick={next}><ChevronRight size={16} /></button>
    </div>
    {page !== 'home' && <button type="button" className="toolbar-btn tw-structure-back" onClick={() => setPage('home')}><ChevronLeft size={15} />Designs</button>}
    {page === 'home' && <>
      {panes ? <>
        <h3>Designs for this slide</h3>
        <div className="tw-structure-designs">
          {modes.values.map(value => <button type="button" key={value.token} className="toolbar-btn"
            aria-pressed={mode === value.token} disabled={value.token === 'carousel' && panes.length < 2}
            title={value.description} onClick={() => commit(undefined, modes, value.token)}>{modeNames[value.token]}</button>)}
        </div>
      </> : <>
        <h3>Slides in this {label.toLowerCase()}</h3>
        {childCount > 0 ? <>
          <InspectorOptionPictures outlinePath={path} outline={text} slide={id || { headingLine: line }}
            groupKey={modes.key} groupLabel={`Slides in this ${label.toLowerCase()}`}
            set={{ layout: label === 'Section' ? 'section' : 'subsection', pictured: sectionChoices, rest: [] }}
            selectedToken={sectionMode} showDescriptions commitToken={value => value.token}
            onSelect={value => commit(undefined, modes, value.token)} />
          {!sectionCarousel && mode !== 'carousel' && <p className="tw-structure-detail"><strong>Carousel</strong> needs slides with pictures.</p>}
        </> : <p className="tw-structure-detail">Nothing in it yet.</p>}
      </>}
      <h3>Adjust one thing</h3>
      <div className="tw-structure-inspector-rows">
        {panes ? <button type="button" onClick={() => setPage('subslides')}><LayoutTemplate size={16} /><span>Subslides</span><small>{panes.length}, one at a time</small><ChevronRight size={15} /></button>
          : <button type="button" onClick={() => setPage('colour')}><Palette size={16} /><span>Colour</span><small>{colour ? colourName : 'Follows the rotation'}</small><ChevronRight size={15} /></button>}
        <button type="button" onClick={panes ? editTitle : () => setPage('title')}><Type size={16} /><span>Title</span>
          {!panes && <small>{label} name, large</small>}<ChevronRight size={15} /></button>
        <button type="button" onClick={more}><Ellipsis size={16} /><span>More</span><ChevronRight size={15} /></button>
      </div>
    </>}
    {page === 'colour' && <>
      <h3>Section colour</h3>
      {inheritedColour ? <>
        <p>{colourName} · Follows its section</p>
        <button type="button" className="toolbar-btn" onClick={inheritedColour.selectSection}>Change colour on its section</button>
      </> : <>
        <InspectorOptionPictures outlinePath={path} outline={text} slide={id || { headingLine: line }}
          groupKey={colours.key} groupLabel="Section colour"
          set={{ layout: 'section', pictured: colourChoices, rest: [] }} selectedToken={colour}
          commitToken={value => value.token} onSelect={value => commit(colourEntry, colours, value.token)} />
        <p>Rotation gives each section the next colour of the talk’s design. A colour chosen here stays with this section.</p>
      </>}
    </>}
    {page === 'title' && <>
      <h3>Title size</h3>
      <div className="tw-structure-designs">
        {titleSize.values.map(value => <button type="button" className="toolbar-btn" key={value.token}
          aria-pressed={tokenIn(titleSize) === value.token} onClick={() => commit(undefined, titleSize, value.token)}>{value.label}</button>)}
      </div>
      <button type="button" className="toolbar-btn tw-structure-back" onClick={editTitle}>Edit title</button>
    </>}
    {page === 'subslides' && <>
      <h3>Subslides of this slide</h3>
      <div className="tw-structure-inspector-rows">
        {panes?.map((pane, index) => <button type="button" key={index} onClick={pane.select}><span>{index + 1}</span><strong>{pane.title}</strong><ChevronRight size={15} /></button>)}
      </div>
      <button type="button" className="toolbar-btn" onClick={addSubslide}><Plus size={14} />New subslide</button>
      <h3>While presenting</h3>
      <p>Subslides appear one at a time, on Next.</p>
    </>}
  </div>
}
