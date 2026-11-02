import { useCallback, useEffect, useRef, useState } from 'react'
import type { InventoryEntry, InventoryResult } from '../../../../shared/vault-gallery-storage'
let sequence = Date.now()
const running = (vaultId: string, relativePath: string, generation: number): InventoryResult => ({ vaultId, relativePath, generation, rootIdentity: null, checkedAt: new Date().toISOString(), state: 'running', entries: [], counted: 0, unreadable: 0, excluded: 0, truncated: false, logicalBytes: null, allocatedBytes: null, allocationUnknown: 0 })
/** Storage inventory for the folder you are in, in three separate slots:
 *  - `listing`: the latest non-recursive directory listing (the folder's direct rows), never touched by a measurement;
 *  - `scan`: the latest recursive request (a search in a folder, or an explicit Measure), progress included;
 *  - `search`: the last scan of the search base, kept while a re-scan runs so a query update or Refresh never drops a match.
 *  Recursion happens only for a folder search or Measure; the vault root needs the explicit confirmation first.
 *  Main allows one request per window at a time, so requests are issued one after another. */
export function useGalleryInventory(vaultId: string | null, folder: string, scope: string, query: string) {
  const [listing, setListing] = useState<InventoryResult | null>(null)
  const [scan, setScan] = useState<InventoryResult | null>(null)
  const [search, setSearch] = useState<InventoryResult | null>(null)
  const [confirming, setConfirming] = useState(false)
  const listingToken = useRef(0), scanToken = useRef(0)
  const idle = useRef<Promise<unknown>>(Promise.resolve())
  const live = useRef({ vaultId, folder, searching: false })
  live.current = { vaultId, folder, searching: !!query.trim() }
  const cancel = (token: { current: number }) => { const id = token.current; token.current = 0; if (id) void window.tw.vault.galleryInventoryCancel(id) }
  const scanRunning = useRef(false), scanBase = useRef(''), scanOrigin = useRef<'search' | 'measure' | ''>('')
  const applyScan = useCallback((r: InventoryResult) => {
    scanRunning.current = r.state === 'running'; scanBase.current = r.relativePath
    setScan(r)
    const { folder: base, searching } = live.current
    if (searching && r.relativePath === base) setSearch(old => r.state !== 'running' || !old || old.state === 'running' ? r : old)
  }, [])
  const stop = useCallback(() => {
    cancel(scanToken)
    const stopped = (r: InventoryResult | null) => r?.state === 'running' ? { ...r, state: 'cancelled' as const, reason: 'Stopped; coverage incomplete' } : r
    // A search re-scan that is stopped leaves the older matches on screen but no longer claims full coverage.
    const base = scanBase.current
    setScan(stopped); setSearch(r => r && base === r.relativePath && scanRunning.current ? { ...r, state: 'cancelled' as const, reason: 'Stopped; coverage incomplete' } : stopped(r))
  }, [])
  const list = useCallback((path: string) => {
    if (!vaultId) return Promise.resolve()
    cancel(listingToken)
    const generation = ++sequence; listingToken.current = generation
    setListing(old => old?.vaultId === vaultId && old.relativePath === path ? old : running(vaultId, path, generation))
    const request = { vaultId, relativePath: path, generation, recursive: false, confirmedRoot: false }
    return window.tw.vault.galleryInventory(request).then(r => { if (listingToken.current === generation) setListing(r) })
      .catch(e => { if (listingToken.current === generation) setListing(r => r ? { ...r, state: 'refused', reason: String(e) } : r) })
  }, [vaultId])
  const run = useCallback((path: string, origin: 'search' | 'measure' = 'measure') => {
    if (!vaultId) return
    cancel(scanToken); scanOrigin.current = origin
    const generation = ++sequence; scanToken.current = generation
    applyScan(running(vaultId, path, generation))
    const request = { vaultId, relativePath: path, generation, recursive: true, confirmedRoot: !path }
    // The directory listing and a scan share the one request slot in main: a scan waits for the listing in flight.
    idle.current = idle.current.catch(() => { }).then(() => scanToken.current === generation ? window.tw.vault.galleryInventory(request).then(r => { if (scanToken.current === generation) applyScan(r) }).catch(e => { if (scanToken.current === generation) applyScan({ ...running(vaultId, path, generation), state: 'refused', reason: String(e) }) }) : undefined)
  }, [vaultId, applyScan])
  useEffect(() => {
    if (!vaultId) return
    return window.tw.vault.onGalleryInventory(r => { if (r.vaultId !== vaultId) return; if (r.generation === scanToken.current) applyScan(r); else if (r.generation === listingToken.current) setListing(old => r.state === 'running' && old && old.relativePath === r.relativePath && old.state !== 'running' ? old : r) })
  }, [vaultId, applyScan])
  // New folder or vault: a fresh listing (and the folder search when a query is open). Refresh keeps the folder's search result
  // while it re-scans; the vault root re-lists only, because its scan needs the explicit confirmation again.
  const previous = useRef({ vaultId, folder })
  useEffect(() => {
    const moved = previous.current.vaultId !== vaultId || previous.current.folder !== folder
    previous.current = { vaultId, folder }
    cancel(scanToken)
    setConfirming(false)
    if (!vaultId) { cancel(listingToken); setListing(null); setScan(null); setSearch(null); return }
    if (moved) { setListing(null); setSearch(null) }
    if (!folder) setSearch(null)
    setScan(null)
    idle.current = list(folder)
    if (folder && query.trim()) run(folder, 'search')
    return () => { cancel(scanToken); cancel(listingToken) }
  }, [vaultId, folder, scope])
  useEffect(() => {
    if (!query.trim()) {
      setSearch(null)
      // Clearing the search stops the scan the search started; a Measure the person asked for keeps running.
      if (scanOrigin.current === 'search' && scanRunning.current) { cancel(scanToken); scanRunning.current = false; setScan(null) }
    } else if (vaultId && folder) run(folder, 'search')
  }, [query])
  /** Measure the folder; the vault root needs the explicit confirmation first. */
  const measure = useCallback((path: string) => { if (!path) setConfirming(true); else run(path) }, [run])
  const mine = (r: InventoryResult | null) => r?.vaultId === vaultId ? r : null
  return { listing: mine(listing), scan: mine(scan), search: mine(search), run, stop, measure, confirming, setConfirming }
}
