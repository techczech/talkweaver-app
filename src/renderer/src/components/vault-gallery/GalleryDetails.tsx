import { Clipboard, FileText, Folder, HardDrive, Ruler } from 'lucide-react'
import { plainTalkTitle } from '../../../../shared/plain-title'
import type { GalleryFacts, GalleryTalk } from '../../../../shared/vault-gallery'
import { formatBytes, formatBytesAtLeast, plural, talkDirectory } from '../../../../shared/vault-gallery-browse'
import { galleryIdentity } from '../../../../shared/vault-gallery'
import type { GalleryHandouts } from '../../../../shared/gallery-handouts'
import { scanSize, type TalkSize } from '../../../../shared/vault-gallery-storage'
import { isDirectoryKind, type GalleryItem } from './galleryItems'
import { entryKindName, sizeCell, type Known } from './galleryValues'
import { EntryIcon } from './GalleryList'
import { Mosaic } from './GalleryTiles'
import { UI } from './galleryItems'

export interface DetailsTarget {
  item: GalleryItem | null
  /** Current folder or vault, shown when nothing is selected. */
  context: { kind: 'folder' | 'vault' | 'all'; path: string; count: number | null; folders: number | null } | null
  /** All vaults view: the vault is described, not browsed. */
  overview?: boolean
  vaultName: string
  root?: string
  status?: string
  foldersInside?(path: string): number
}
const Fact = ({ label, value }: { label: string; value: string }) => <><dt>{label}</dt><dd>{value}</dd></>
/** Exact total, else an honest floor from an incomplete measurement, else Unknown. */
const sizeText = (s: TalkSize | null) => s?.allocated != null ? formatBytes(s.allocated) : s?.allocatedAtLeast != null ? formatBytesAtLeast(s.allocatedAtLeast) : 'Unknown'
const fileText = (s: TalkSize | null) => s?.logical == null ? 'Unknown' : s.partial && s.logical > 0 ? formatBytesAtLeast(s.logical) : formatBytes(s.logical)
const handoutsText = (h?: GalleryHandouts) => !h ? 'Reading…' : h.status === 'unknown' ? 'Unknown' : h.status === 'unpublished' ? UI.notPublished : plural(h.records.length, 'handout') + (h.partial ? ' · incomplete' : '')
/** Details: one pane for a talk, a folder, a stored entry, or the folder you are in. Facts only; actions live in the toolbar. */
export default function GalleryDetails({ target, known, previewUrl, onPreview, copy, copied, mosaicTalks, onMeasureVault }: {
  target: DetailsTarget; known: Known; previewUrl: string | null; onPreview(): void; onHandouts(talk: GalleryTalk): void; copy(text: string): void; copied: boolean
  mosaicTalks(path: string): GalleryTalk[]; onMeasureVault?(): void
}) {
  const { item, context } = target
  const foldersInside = (path: string) => (target.foldersInside ? target.foldersInside(path) : 0)
  const where = (path: string) => [target.vaultName, ...path.split('/').filter(Boolean)].join(' / ')
  const copyLocation = (display: string, relative: string) => <button className="vg-linkbtn" onClick={() => copy(target.root ? `${target.root.replace(/\/+$/, '')}${relative ? '/' + relative : ''}` : display)}><Clipboard size={14} aria-hidden />{copied ? 'Copied' : UI.copyLocation}</button>
  if (item?.kind === 'talk') {
    const talk = item.talk, f: GalleryFacts | undefined = known.facts[galleryIdentity(talk)], size = scanSize(known.scans, talkDirectory(talk))
    const h = known.handouts[galleryIdentity(talk)], display = where(talkDirectory(talk))
    return <aside className="vg-details" aria-label="Details">
      {previewUrl ? <button className="vg-thumb vg-thumbbtn" aria-label={`Preview title slide: ${plainTalkTitle(talk.title)}`} onClick={onPreview}><img src={previewUrl} alt={`Title slide of ${talk.title}`} /></button> : <span className="vg-thumb"><span className="vg-nopreview"><FileText size={20} aria-hidden />{f?.preview === 'unavailable' ? 'Title preview unavailable' : 'Title preview pending'}</span></span>}
      <h2 className="vg-dtitle">{plainTalkTitle(talk.title)}</h2>
      <dl className="vg-facts">
        <Fact label="Slides" value={f ? (f.slideCount == null ? 'Unknown' : String(f.slideCount)) : 'Reading…'} />
        <Fact label="Images used" value={f ? (f.imageCount == null ? 'Unknown' : String(f.imageCount)) : 'Reading…'} />
        <Fact label="Size on disk" value={sizeText(size)} />
        <Fact label="File size" value={fileText(size)} />
        <Fact label="Modified" value={f ? (f.editedMs == null ? 'Unknown' : new Date(f.editedMs).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })) : 'Reading…'} />
        <Fact label="Handouts" value={handoutsText(h)} />
      </dl>
      {size?.partial && <p className="vg-dnote">Incomplete total. Some stored files could not be measured.</p>}
      {h?.status === 'unknown' && <p className="vg-dnote">Status could not be read. This does not mean the talk is unpublished.</p>}
      <div className="vg-dsect"><h3>{'Location'}</h3><p>{display}</p>{copyLocation(display, talkDirectory(talk))}</div>
    </aside>
  }
  if (item?.kind === 'folder') {
    const size = scanSize(known.scans, item.path), display = where(item.path)
    return <aside className="vg-details" aria-label="Details">
      <span className="vg-thumb"><Mosaic talks={mosaicTalks(item.path)} known={known} /></span>
      <h2 className="vg-dtitle vg-dicon"><Folder size={20} className="vg-ic vg-ic-folder" aria-hidden />{item.name}</h2>
      <dl className="vg-facts"><Fact label="Kind" value="Folder" /><Fact label="Talks, including subfolders" value={`${item.count.toLocaleString()} known`} /><Fact label="Folders inside" value={String(foldersInside(item.path))} /><Fact label="Size on disk" value={sizeText(size)} /><Fact label="File size" value={fileText(size)} /></dl>
      <p className="vg-dnote">Counts come from the known catalogue and may be incomplete.{size?.partial ? ' Size is an incomplete total.' : ''}</p>
      <div className="vg-dsect"><h3>Location</h3><p>{display}</p>{copyLocation(display, item.path)}</div>
    </aside>
  }
  if (item?.kind === 'entry') {
    // Folder-like entries (assets, research, system folders) show a measured size; a listing row carries none.
    const e = item.entry, display = where(item.path), size = isDirectoryKind(e.kind) ? scanSize(known.scans, item.path) : null
    const sizes = size ? [sizeText(size), fileText(size)] : e.kind === 'link' ? [sizeCell(item, known).text, sizeCell(item, known).text] : [formatBytes(e.allocated), formatBytes(e.logical)]
    return <aside className="vg-details" aria-label="Details">
      <h2 className="vg-dtitle vg-dicon"><EntryIcon kind={e.kind} size={20} />{item.name}</h2>
      <dl className="vg-facts"><Fact label="Kind" value={entryKindName(e.kind)} /><Fact label="Size on disk" value={sizes[0]} /><Fact label="File size" value={sizes[1]} /></dl>
      {size?.partial && <p className="vg-dnote">Incomplete total. Some stored files could not be measured.</p>}
      {e.reason && <p className="vg-dnote">{e.reason}</p>}
      <p className="vg-dnote">{UI.systemNote}</p>
      <div className="vg-dsect"><h3>Location</h3><p>{display}</p>{copyLocation(display, item.path)}</div>
    </aside>
  }
  const c = context
  const size = c && c.kind !== 'all' ? scanSize(known.scans, c.path) : null
  return <aside className="vg-details" aria-label="Details">
    <h2 className="vg-dtitle vg-dicon">{c?.kind === 'vault' ? <HardDrive size={20} className="vg-ic vg-ic-sys" aria-hidden /> : <Folder size={20} className="vg-ic vg-ic-folder" aria-hidden />}{c?.kind === 'folder' && c.path ? c.path.split('/').at(-1) : c?.kind === 'all' ? UI.allTalks : target.vaultName}</h2>
    <dl className="vg-facts"><Fact label="Kind" value={c?.kind === 'folder' && c.path ? 'Folder' : c?.kind === 'all' ? 'All talks' : 'Vault'} /><Fact label="Talks, including subfolders" value={c?.count == null ? 'Unknown' : `${c.count.toLocaleString()} known`} />{c?.kind !== 'all' && <Fact label="Folders inside" value={c?.folders == null ? 'Unknown' : String(c.folders)} />}{c?.kind === 'vault' && target.status && <Fact label="Status" value={target.status} />}<Fact label="Size on disk" value={sizeText(size)} />{c?.kind === 'vault' && <Fact label="File size" value={fileText(size)} />}</dl>
    {size?.partial && <p className="vg-dnote">Incomplete total. Some stored files could not be measured.</p>}
    {!(target.overview && target.status === 'Not connected') && <p className="vg-dnote">{target.overview ? 'Open the vault to browse its talks and folders.' : 'Select a talk or folder to see its details.'}</p>}
    {c?.kind === 'vault' && target.root && <div className="vg-dsect"><h3>Location</h3><p>{target.root}</p><button className="vg-linkbtn" onClick={() => copy(target.root!)}><Clipboard size={14} aria-hidden />{copied ? 'Copied' : UI.copyLocation}</button>{onMeasureVault && <button className="vg-linkbtn" onClick={onMeasureVault}><Ruler size={14} aria-hidden />{UI.measureVault}</button>}</div>}
  </aside>
}
