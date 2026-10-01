// Slide tags (ADR-0037, `t`): the tray-anchored picker writes via tags:apply. `tagBusy` guards one
// in-flight write; `tagsVersion` bumps after an optimistic per-row `tags` update (the rows are
// mutated in place — the same objects the display model holds — so applying a tag never re-runs
// the whole search or reflows the grid).
import { useEffect, useState } from 'react'
import { notify } from '../../lib/notify'
import { tagTargetsFromRows } from '../slideBrowserModel'
import { rowTagsOf, tagsAfter } from './browserHelpers'
import type { SearchResult } from './types'

export function useTagging({ selected, selectedRows }: { selected: Set<string>; selectedRows: SearchResult[] }) {
  const [tagPickerOpen, setTagPickerOpen] = useState(false)
  const [tagBusy, setTagBusy] = useState(false)
  const [, setTagsVersion] = useState(0)

  function openTagPicker(): void {
    if (selected.size === 0) {
      notify('Select slides first — X selects, ⇧-click ranges, S takes a section.', 'info')
      return
    }
    setTagPickerOpen(true)
  }
  // Selection emptied (Esc / Clear) → the picker has nothing to write to.
  useEffect(() => {
    if (selected.size === 0) setTagPickerOpen(false)
  }, [selected])

  // One tag across the whole selection (merge-only; per-occurrence targets — an identical
  // stack's card targets the SELECTED occurrence, aggregation-by-identity is a read concern).
  async function applyTag(tag: string, action: 'add' | 'remove'): Promise<void> {
    const rows = selectedRows
    if (rows.length === 0 || tagBusy) return
    const targets = tagTargetsFromRows(rows)
    setTagBusy(true)
    try {
      // Every target talk is written by main's one writer (talk-writer.ts): a talk open in an editor
      // window gets its tags in that window's buffer (then saved through its queue), any other talk
      // on disk under its file lock — so no flush before and no reload after (one-writer spec D1).
      const res = await window.tw.tags.apply(
        targets,
        action === 'add' ? [tag] : [],
        action === 'remove' ? [tag] : []
      )
      if (!res || res.ok !== true) {
        notify('Couldn’t write the tags — nothing was changed.', 'error')
        return
      }
      // Optimistic row update so the picker/chips reflect the write instantly (the search
      // index catches up in the background — tags:apply invalidated the touched talks).
      for (const r of rows) r.tags = tagsAfter(rowTagsOf(r), tag, action)
      setTagsVersion((n) => n + 1)
      if (res.failed.length > 0) {
        notify(`Tagged, but ${res.failed.length} outline${res.failed.length === 1 ? '' : 's'} failed — see the log.`, 'error')
        console.error('[tags] failed outlines', res.failed)
      }
    } finally {
      setTagBusy(false)
    }
  }

  return {
    tagPickerOpen, setTagPickerOpen, tagBusy, openTagPicker, applyTag,
    selectedTagLists: selectedRows.map(rowTagsOf)
  }
}
