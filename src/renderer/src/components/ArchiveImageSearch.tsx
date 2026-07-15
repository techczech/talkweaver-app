import React, { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Palette to search the OLD-PowerPoint image archive (read-only) and import a
 * hit into the current vault's _assets (ADR-0003 reuse, ADR-0006 assets,
 * ADR-0019 desktop app). The archive lives outside the vault; the main process
 * serves thumbnails via the twarchive:// protocol and content-addresses the
 * imported file just like asset:paste-image.
 *
 * This file is the sole owner of the ArchiveImageSearch component. The
 * window.tw.archive namespace is exposed by the preload and implemented in the
 * main process; the local types below describe that contract so this component
 * compiles independently of preload typing changes.
 */

type ArchiveHit = {
  assetKey: string
  presentationId: string
  relPath: string
  sha256?: string
  ocrText: string
  thumbUrl: string // twarchive://<base64url of absolute file path>
  deckTitle?: string
}

type ImportedImage = { id: string; ext: string; path: string }

type ArchiveApi = {
  searchImages: (query: string) => Promise<ArchiveHit[] | null>
  importImage: (thumbUrlOrPath: string) => Promise<ImportedImage | null>
  available: () => Promise<boolean>
}

// Read window.tw.archive without depending on the preload's exported type, so a
// missing/lagging preload declaration never breaks this file's compilation.
function archiveApi(): ArchiveApi | null {
  const tw = (window as unknown as { tw?: { archive?: ArchiveApi } }).tw
  return tw?.archive ?? null
}

interface Props {
  isOpen: boolean
  onClose: () => void
  /** After importImage resolves, parent inserts ![](img-id) at the cursor. */
  onInsertImage: (imgId: string) => void
}

const DEBOUNCE_MS = 250
const COLUMNS = 3

export default function ArchiveImageSearch({ isOpen, onClose, onInsertImage }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ArchiveHit[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [loading, setLoading] = useState(false)
  // null = not yet probed; true/false = archive presence resolved.
  const [available, setAvailable] = useState<boolean | null>(null)
  // assetKey currently being imported (shows an "importing…" overlay on the card).
  const [importingKey, setImportingKey] = useState<string | null>(null)
  // Full-screen preview of the active hit (Space toggles it once focus has left the input).
  const [preview, setPreview] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  // Guards against out-of-order async resolutions clobbering newer results.
  const reqIdRef = useRef(0)
  // Prevents double-import (Enter + click racing).
  const importLockRef = useRef(false)

  // Reset state + probe availability + focus on open.
  useEffect(() => {
    if (!isOpen) return
    setQuery('')
    setResults([])
    setActiveIndex(0)
    setLoading(false)
    setImportingKey(null)
    setPreview(false)
    importLockRef.current = false

    const api = archiveApi()
    if (!api) {
      setAvailable(false)
      return
    }
    setAvailable(null)
    let cancelled = false
    api
      .available()
      .then((ok) => {
        if (!cancelled) setAvailable(ok)
      })
      .catch(() => {
        if (!cancelled) setAvailable(false)
      })

    // Deferred + retried focus — CodeMirror can grab focus back on the opening shortcut's keyup.
    const focus = (): void => { inputRef.current?.focus(); inputRef.current?.select?.() }
    requestAnimationFrame(focus)
    const ft = setTimeout(focus, 60)
    return () => {
      cancelled = true
      clearTimeout(ft)
    }
  }, [isOpen])

  // Debounced archive image search. Skips while archive is absent/unprobed.
  useEffect(() => {
    if (!isOpen || available !== true) return
    const api = archiveApi()
    if (!api) return

    const reqId = ++reqIdRef.current
    setLoading(true)
    const handle = setTimeout(async () => {
      const hits = await api.searchImages(query)
      // Ignore if a newer request superseded this one.
      if (reqId !== reqIdRef.current) return
      setLoading(false)
      if (hits === null) {
        setAvailable(false)
        setResults([])
        return
      }
      setResults(hits)
      setActiveIndex(0)
    }, DEBOUNCE_MS)

    return () => clearTimeout(handle)
  }, [query, isOpen, available])

  // Keep the active card in view.
  useEffect(() => {
    if (!gridRef.current) return
    const el = gridRef.current.querySelector<HTMLElement>('[data-active="true"]')
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, results])

  const importHit = useCallback(
    async (hit: ArchiveHit) => {
      if (importLockRef.current) return
      const api = archiveApi()
      if (!api) return
      importLockRef.current = true
      setImportingKey(hit.assetKey)
      try {
        const imported = await api.importImage(hit.thumbUrl)
        if (imported && imported.id) {
          onInsertImage(imported.id)
          onClose()
          return
        }
      } catch {
        // fall through to reset state below
      }
      // Import failed or returned null: release the lock and let the user retry.
      importLockRef.current = false
      setImportingKey(null)
    },
    [onInsertImage, onClose]
  )

  // Keyboard navigation (capture so we intercept before editor handlers).
  useEffect(() => {
    if (!isOpen) return

    function handleKey(e: KeyboardEvent): void {
      const inInput = document.activeElement === inputRef.current
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (preview) setPreview(false)
        else onClose()
        return
      }
      if (results.length === 0) return
      // Down/Up move by a grid row and drop focus out of the query input so the
      // single-key grid controls (←/→ and Space) become live.
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        inputRef.current?.blur()
        setActiveIndex((i) => Math.min(i + COLUMNS, results.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        inputRef.current?.blur()
        setActiveIndex((i) => Math.max(i - COLUMNS, 0))
      } else if (e.key === 'ArrowRight' && !inInput) {
        e.preventDefault()
        setActiveIndex((i) => Math.min(i + 1, results.length - 1))
      } else if (e.key === 'ArrowLeft' && !inInput) {
        e.preventDefault()
        setActiveIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === ' ' && !inInput) {
        e.preventDefault()
        setPreview((p) => !p)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const hit = results[activeIndex]
        if (hit) void importHit(hit)
      }
    }

    window.addEventListener('keydown', handleKey, { capture: true })
    return () => window.removeEventListener('keydown', handleKey, { capture: true })
  }, [isOpen, results, activeIndex, onClose, importHit, preview])

  if (!isOpen) return null

  const showSearchUi = available === true

  return (
    <>
      <div style={backdropStyle} onClick={onClose} />

      <div
        style={modalStyle}
        role="dialog"
        aria-modal="true"
        aria-label="Search old-PowerPoint image archive"
      >
        {showSearchUi && (
          <input
            ref={inputRef}
            autoFocus
            style={inputStyle}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search old-PowerPoint images…"
            aria-label="Archive image search query"
          />
        )}

        <div ref={gridRef} style={bodyStyle}>
          {available === null ? (
            <div style={messageStyle}>Checking archive…</div>
          ) : available === false ? (
            <div style={messageStyle}>Old-PowerPoint archive not found</div>
          ) : results.length === 0 ? (
            <div style={messageStyle}>
              {loading
                ? 'Searching…'
                : query.trim()
                  ? `No images match "${query}"`
                  : 'Type to search the old-PowerPoint image archive'}
            </div>
          ) : (
            <div style={gridStyle} role="listbox" aria-label="Archive image results">
              {results.map((hit, idx) => (
                <ArchiveCard
                  key={hit.assetKey || `${hit.presentationId}:${hit.relPath}:${idx}`}
                  hit={hit}
                  active={idx === activeIndex}
                  importing={importingKey === hit.assetKey}
                  onHover={() => setActiveIndex(idx)}
                  onSelect={() => void importHit(hit)}
                />
              ))}
            </div>
          )}
        </div>

        {showSearchUi && (
          <div style={footerStyle}>
            <span>
              <kbd style={kbdStyle}>←↑↓→</kbd> navigate
            </span>
            <span>
              <kbd style={kbdStyle}>space</kbd> full screen
            </span>
            <span>
              <kbd style={kbdStyle}>↵</kbd> import
            </span>
            <span>
              <kbd style={kbdStyle}>Esc</kbd> close
            </span>
          </div>
        )}
      </div>

      {preview && results[activeIndex] && (
        <div style={lightboxStyle} onClick={() => setPreview(false)} role="dialog" aria-label="Image preview">
          <img src={results[activeIndex].thumbUrl} alt="" style={lightboxImgStyle} />
          {results[activeIndex].deckTitle && (
            <div style={lightboxCapStyle}>{results[activeIndex].deckTitle}</div>
          )}
        </div>
      )}
    </>
  )
}

interface CardProps {
  hit: ArchiveHit
  active: boolean
  importing: boolean
  onHover: () => void
  onSelect: () => void
}

function ArchiveCard({ hit, active, importing, onHover, onSelect }: CardProps) {
  const [imgFailed, setImgFailed] = useState(false)
  const snippet = ocrSnippet(hit.ocrText)

  return (
    <div
      role="option"
      aria-selected={active}
      data-active={active ? 'true' : 'false'}
      onClick={onSelect}
      onMouseEnter={onHover}
      style={{
        ...cardStyle,
        borderColor: active ? 'var(--oxford)' : 'var(--line)',
        background: active ? 'var(--hover)' : 'var(--panel)',
        boxShadow: active ? '0 0 0 2px color-mix(in srgb, var(--oxford) 25%, transparent)' : 'none'
      }}
    >
      <div style={thumbWrapStyle}>
        {imgFailed ? (
          <div style={thumbFallbackStyle}>no preview</div>
        ) : (
          <img
            src={hit.thumbUrl}
            alt=""
            style={thumbImgStyle}
            onError={() => setImgFailed(true)}
          />
        )}
        {importing && <div style={importingOverlayStyle}>importing…</div>}
      </div>

      {hit.deckTitle && (
        <div style={deckTitleStyle} title={hit.deckTitle}>
          {hit.deckTitle}
        </div>
      )}

      {snippet && (
        <div style={snippetStyle} title={hit.ocrText}>
          {snippet}
        </div>
      )}
    </div>
  )
}

function ocrSnippet(text: string): string | null {
  if (!text) return null
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > 90 ? flat.slice(0, 90) + '…' : flat
}

const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  background: '#17202a30'
}

const modalStyle: React.CSSProperties = {
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  zIndex: 1001,
  width: 900,
  maxWidth: 'calc(100vw - 48px)',
  maxHeight: 'calc(100vh - 96px)',
  background: 'var(--panel)',
  border: '1px solid var(--line)',
  borderRadius: 10,
  boxShadow: '0 8px 40px #17202a18',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden'
}

const inputStyle: React.CSSProperties = {
  padding: '12px 16px',
  border: 'none',
  borderBottom: '1px solid var(--line)',
  background: 'transparent',
  fontSize: 14,
  color: 'var(--ink)',
  outline: 'none',
  width: '100%'
}

const bodyStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  minHeight: 160
}

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: `repeat(${COLUMNS}, 1fr)`,
  // Row FLOOR — a plain `auto` row collapses to min-content when many results overflow the grid
  // (the same 1px-stripe bug as the slide search); minmax keeps each card tall, grows if needed.
  gridAutoRows: 'minmax(220px, auto)',
  gap: 12,
  padding: 14
}

const cardStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  border: '1px solid var(--line)',
  borderRadius: 8,
  padding: 8,
  cursor: 'pointer',
  transition: 'border-color 0.12s, background 0.12s, box-shadow 0.12s',
  minWidth: 0
}

const thumbWrapStyle: React.CSSProperties = {
  position: 'relative',
  width: '100%',
  // Fixed height — NOT aspectRatio. An aspect-ratio box collapses to a thin stripe inside this
  // flex-column card / grid / flex-modal nesting; a fixed height can't collapse.
  height: 168,
  flex: 'none',
  borderRadius: 5,
  border: '1px solid var(--line)',
  background: 'var(--hover)',
  overflow: 'hidden'
}

const thumbImgStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'contain',
  display: 'block'
}

const thumbFallbackStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--faint)',
  fontSize: 11
}

const importingOverlayStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#17202aa0',
  color: '#fff',
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: 0.3
}

const deckTitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--muted)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis'
}

const snippetStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--faint)',
  lineHeight: 1.3,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis'
}

const messageStyle: React.CSSProperties = {
  padding: '40px 16px',
  fontSize: 13,
  color: 'var(--muted)',
  textAlign: 'center'
}

const footerStyle: React.CSSProperties = {
  display: 'flex',
  gap: 16,
  padding: '8px 16px',
  borderTop: '1px solid var(--line)',
  fontSize: 11,
  color: 'var(--faint)'
}

const kbdStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  background: 'var(--hover)',
  border: '1px solid var(--line)',
  borderRadius: 3,
  padding: '2px 5px',
  color: 'var(--ink)',
  display: 'inline-block',
  margin: '0 1px'
}

const lightboxStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1100,
  background: '#17202aee',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 14,
  padding: 24,
  cursor: 'zoom-out'
}

const lightboxImgStyle: React.CSSProperties = {
  maxWidth: '92vw',
  maxHeight: '88vh',
  objectFit: 'contain',
  borderRadius: 6,
  boxShadow: '0 12px 48px #00000060'
}

const lightboxCapStyle: React.CSSProperties = {
  color: '#fff',
  fontSize: 13,
  fontWeight: 600,
  textAlign: 'center',
  maxWidth: '80vw'
}
