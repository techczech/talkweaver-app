import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { GalleryHandouts } from '../../../../shared/gallery-handouts'
import { galleryIdentity, type GalleryFacts, type GalleryTalk } from '../../../../shared/vault-gallery'
import { createVisibleDemand } from './galleryModel'

/** A plain facts reply never takes away a title slide already delivered for the same revision (replies can arrive in either order). */
const keepCover = (old: GalleryFacts | undefined, value: GalleryFacts): GalleryFacts => old?.coverUrl && !value.coverUrl && old.revision === value.revision ? { ...value, coverUrl: old.coverUrl, preview: old.preview } : value
const unavailable: GalleryFacts = { revision: null, slideCount: null, imageCount: null, editedMs: null, coverUrl: null, preview: 'unavailable' }
/** Facts and handout status for the rows on screen, at most two at a time (createVisibleDemand).
 *  Title slides are only asked for when `covers` is set (Gallery) or for one chosen talk. */
export function useGalleryFacts(talks: GalleryTalk[], scope: string, host: RefObject<HTMLElement>, covers: boolean, mosaicKeys?: string, reload = 0) {
  const [facts, setFacts] = useState<Record<string, GalleryFacts>>({})
  const [handouts, setHandouts] = useState<Record<string, GalleryHandouts>>({})
  const membership = talks.map(galleryIdentity).sort().join('|') + '#' + (mosaicKeys ?? '')
  const previewing = useRef(new Set<string>())
  const known = useRef({ facts }); known.current = { facts }
  const lastScope = useRef('')
  /** Bumped whenever the scope changes: a one-off reply that left before then must not overwrite the current facts. */
  const epoch = useRef(0)
  useEffect(() => {
    // The same scope loading again (the catalogue was re-read, which cancels main's reads in flight) keeps what is on screen and asks again for the
    // visible rows: an outline may have changed meanwhile, and a cancelled read may have left "unavailable" behind. A different scope starts clean.
    const sameScope = lastScope.current === `${scope}#${membership}#${covers}`
    lastScope.current = `${scope}#${membership}#${covers}`
    if (sameScope) setFacts(old => Object.fromEntries(Object.entries(old).filter(([, v]) => v !== unavailable).map(([k, v]) => [k, v.revision && v.preview === 'unavailable' ? { ...v, preview: 'pending' as const } : v])))
    else { setFacts({}); setHandouts({}) }
    previewing.current.clear(); epoch.current++
    let live = true
    // A reply of null on a live request means the facts are settled and unreadable, not still on their way: a title slide still promised is not coming.
    const publish = (key: string, value: GalleryFacts | null) => { if (live) setFacts(old => value ? { ...old, [key]: keepCover(old[key], value) } : old[key]?.preview === 'pending' ? { ...old, [key]: { ...old[key], preview: 'unavailable' } } : old[key] ? old : { ...old, [key]: unavailable }) }
    const demand = createVisibleDemand<GalleryFacts | null>(async key => {
      try {
        const [id, path] = JSON.parse(key)
        const metadata = await window.tw.vault.galleryFacts(id, path, false)
        publish(key, metadata)
        if (!covers || !live || !metadata?.revision || metadata.coverUrl || !demand.isVisible(key)) return metadata
        // The title slide already on screen for this revision stays; only a new revision reads it again.
        if (known.current.facts[key]?.coverUrl && known.current.facts[key]?.revision === metadata.revision) return metadata
        return await window.tw.vault.galleryFacts(id, path, true)
      } catch { return unavailable }
    }, publish)
    const publications = createVisibleDemand<GalleryHandouts | null>(async key => {
      const [id, path] = JSON.parse(key)
      return window.tw.vault.galleryHandouts(id, path)
    }, (key, value) => { if (live && value) setHandouts(old => ({ ...old, [key]: value })) })
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      const el = entry.target as HTMLElement
      // A folder tile shows up to four title slides of the talks inside it, through the same bounded queue.
      const mosaic: string[] = el.dataset.mosaic ? JSON.parse(el.dataset.mosaic) : []
      for (const m of mosaic) { if (entry.isIntersecting) demand.show(m); else demand.hide(m) }
      const key = el.dataset.identity
      if (!key) return
      if (entry.isIntersecting) { demand.show(key); publications.show(key) } else { demand.hide(key); publications.hide(key) }
    }), { threshold: 0 })
    host.current?.querySelectorAll('[data-identity],[data-mosaic]').forEach(el => observer.observe(el))
    return () => { live = false; observer.disconnect(); publications.dispose(); demand.dispose(); void window.tw.vault.galleryCancelFacts?.() }
  }, [scope, membership, covers, reload])
  /** One title slide for one talk, even in List, even before its facts arrived (Space, the preview button, Details). */
  const wantCover = useCallback((talk: GalleryTalk) => {
    const key = galleryIdentity(talk)
    const known = facts[key]
    if (known?.coverUrl || known?.preview === 'unavailable' || (known && !known.revision) || previewing.current.has(key)) return
    previewing.current.add(key)
    const mine = epoch.current
    const settle = (value: GalleryFacts | null) => { if (epoch.current === mine) setFacts(old => value ? { ...old, [key]: keepCover(old[key], value) } : { ...old, [key]: old[key] ? { ...old[key], preview: 'unavailable' } : unavailable }) }
    void window.tw.vault.galleryFacts(talk.vaultId, talk.relativeOutline, true).then(settle).catch(() => settle(null))
  }, [facts])
  /** Handout status on demand, for the sheet of a row that has not scrolled into view. */
  const loadHandouts = useCallback((talk: GalleryTalk) => {
    const key = galleryIdentity(talk)
    if (handouts[key]) return
    const mine = epoch.current
    void window.tw.vault.galleryHandouts(talk.vaultId, talk.relativeOutline).then(value => { if (value && epoch.current === mine) setHandouts(old => ({ ...old, [key]: value })) }).catch(() => { })
  }, [handouts])
  const dropCover = useCallback((key: string) => setFacts(old => old[key] ? { ...old, [key]: { ...old[key], coverUrl: null, preview: 'unavailable' } } : old), [])
  return { facts, handouts, wantCover, dropCover, loadHandouts }
}
