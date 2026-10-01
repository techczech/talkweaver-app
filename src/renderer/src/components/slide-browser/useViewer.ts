// The INSERT-DECISION VIEWER (↵ on a card): a self-contained overlay layer inside the Browser —
// never the editor, never a talk switch. Holds the source talk + the deck index to open on; the
// deck itself derives from the full index snapshot.
import { useMemo, useState } from 'react'
import { notify } from '../../lib/notify'
import { viewerDeckFor, viewerIndexFor } from './browserHelpers'
import type { SearchResult } from './types'

export function useViewer({ fullRows, results, setOpenPop, setPreview, insertRows }: {
  fullRows: SearchResult[]
  results: SearchResult[]
  setOpenPop: (pop: string | null) => void
  setPreview: (open: boolean) => void
  insertRows: (rows: SearchResult[]) => void
}) {
  const [viewer, setViewer] = useState<{ slug: string; order: number } | null>(null)
  const viewerDeck = useMemo<SearchResult[]>(
    () => viewerDeckFor(viewer, fullRows, results),
    [viewer, fullRows, results]
  )
  const viewerIndex = viewerIndexFor(viewer, viewerDeck)

  function openViewer(row: SearchResult): void {
    // The viewer is the topmost Browser layer — anything floating (settings popover, Space
    // preview) closes first; the grid itself (scroll, expansion, selection) stays put so
    // Esc lands back exactly where the user was.
    setOpenPop(null)
    setPreview(false)
    setViewer({ slug: row.talkSlug, order: row.order ?? 0 })
  }
  // The viewer's ⌘↵: the existing insert flow (caret splice, merge nudge, Browser close),
  // then the confirmation toast the spec asks for.
  function viewerInsert(rows: SearchResult[]): void {
    setViewer(null)
    insertRows(rows)
    notify(
      `Inserted ${rows.length} slide${rows.length === 1 ? '' : 's'} at the caret.`,
      'success'
    )
  }

  return { viewer, setViewer, viewerDeck, viewerIndex, openViewer, viewerInsert }
}
