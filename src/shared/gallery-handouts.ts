import { publishedPages, type PublishedPagesInput, type PublishedPageRow } from './published-pages.ts'
import type { GalleryTalk } from './vault-gallery.ts'
export interface GalleryHandouts { status: 'published' | 'unpublished' | 'unknown'; records: PublishedPageRow[]; unattributed?: PublishedPageRow[]; partial: boolean; note: string | null }
/** Run sources predate outline identity. Never infer ownership from their slug. */
export function galleryHandouts(talk: GalleryTalk, input: PublishedPagesInput | null): GalleryHandouts {
  if (!input) return {status:'unknown',records:[],partial:true,note:'Publication records could not be read.'}
  const talks = input.talks.filter(t=>t.vaultId===talk.vaultId && t.outline===talk.relativeOutline)
  const site=input.site.error ? {...input.site,error:undefined} : input.site
  const records=publishedPages({...input,site,talks,runs:input.runs.filter(r=>r.vaultId===talk.vaultId && r.sourceOutline===talk.relativeOutline)},new Date()).rows
  for(const row of records)row.links=row.links.filter(link=>link.kind==='handout')
  if(input.site.error)for(const row of records){row.site='unclear';row.note=input.site.error}
  const unattributed=publishedPages({...input,site,talks:[],runs:input.runs.filter(r=>r.vaultId===talk.vaultId && r.talkSlug===talk.slug && r.sourceOutline!==talk.relativeOutline)},new Date()).rows
  const ambiguous=unattributed.length>0
  const partial=!!input.unreadable || !!input.site.error || ambiguous
  return {status:records.length?'published':partial?'unknown':'unpublished',records,unattributed,partial,note:ambiguous?'Run records cannot be attributed to this outline.':partial?'Some publication records could not be read.':null}
}
export function handoutLabel(value?:GalleryHandouts) {
 if (!value || value.status==='unknown') return 'Publication status unknown'
 if(value.status==='unpublished')return 'Not published'
 return `${value.records.length} recorded handout${value.records.length===1?'':'s'}${value.partial?' · incomplete':''}`
}
