import { useEffect, useRef, useState } from 'react'

interface Props {
  imageId: string | null
  vaultRoot: string
  onClose: () => void
}

export default function ImageMetaPanel({ imageId, vaultRoot, onClose }: Props): React.JSX.Element | null {
  const [alt, setAlt] = useState('')
  const [caption, setCaption] = useState('')
  const [source, setSource] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [saved, setSaved] = useState(false)
  const firstFieldRef = useRef<HTMLInputElement>(null)

  // Load sidecar metadata whenever the open image changes.
  useEffect(() => {
    if (imageId === null) return
    let cancelled = false
    setSaved(false)
    setLoading(true)
    // Reset fields immediately so stale values never flash for the new image.
    setAlt('')
    setCaption('')
    setSource('')
    setTagsInput('')

    window.tw.asset
      .readSidecar(imageId)
      .then((meta) => {
        if (cancelled || meta === null) return
        setAlt(meta.alt ?? '')
        setCaption(meta.caption ?? '')
        setSource(meta.source ?? '')
        setTagsInput(Array.isArray(meta.tags) ? meta.tags.join(', ') : '')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    requestAnimationFrame(() => firstFieldRef.current?.focus())

    return () => {
      cancelled = true
    }
  }, [imageId])

  // Escape closes the panel.
  useEffect(() => {
    if (imageId === null) return
    function handleKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKey, { capture: true })
    return () => window.removeEventListener('keydown', handleKey, { capture: true })
  }, [imageId, onClose])

  if (imageId === null) return null

  function parseTags(raw: string): string[] {
    return raw
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
  }

  async function handleSave(): Promise<void> {
    if (imageId === null) return
    const ok = await window.tw.asset.writeSidecar(imageId, {
      alt,
      caption,
      source,
      tags: parseTags(tagsInput)
    })
    if (ok) {
      setSaved(true)
      // Brief saved state before the panel closes.
      window.setTimeout(() => onClose(), 350)
    }
  }

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-label="Image metadata"
      style={{
        position: 'fixed',
        right: 0,
        top: 0,
        bottom: 0,
        width: 320,
        background: 'var(--panel)',
        borderLeft: '1px solid var(--line)',
        zIndex: 1100,
        padding: 16,
        boxShadow: '-8px 0 28px #17202a1f',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        overflowY: 'auto',
        fontFamily: 'var(--font-ui)',
        boxSizing: 'border-box'
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: 15,
            fontWeight: 700,
            color: 'var(--ink)'
          }}
        >
          Image
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            border: 'none',
            background: 'transparent',
            color: 'var(--muted)',
            fontSize: 20,
            lineHeight: 1,
            cursor: 'pointer',
            padding: 4,
            borderRadius: 4
          }}
        >
          ×
        </button>
      </div>

      {/* Image preview */}
      <img
        src={'twasset://' + imageId}
        alt={alt || 'Selected image'}
        style={{
          maxWidth: '100%',
          borderRadius: 4,
          border: '1px solid var(--line)',
          display: 'block',
          flexShrink: 0
        }}
      />

      {vaultRoot && (
        <div
          style={{
            fontSize: 10,
            color: 'var(--faint)',
            fontFamily: 'var(--font-mono)',
            wordBreak: 'break-all',
            flexShrink: 0
          }}
          title={imageId}
        >
          {imageId}
        </div>
      )}

      {/* Fields */}
      <Field label="Alt text">
        <input
          ref={firstFieldRef}
          type="text"
          value={alt}
          onChange={(e) => setAlt(e.target.value)}
          disabled={loading}
          placeholder="Describe the image"
          style={inputStyle}
        />
      </Field>

      <Field label="Caption">
        <textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          disabled={loading}
          placeholder="Visible caption"
          rows={3}
          style={{ ...inputStyle, resize: 'vertical', minHeight: 56 }}
        />
      </Field>

      <Field label="Source">
        <input
          type="text"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          disabled={loading}
          placeholder="Attribution or URL"
          style={inputStyle}
        />
      </Field>

      <Field label="Tags" hint="comma-separated">
        <input
          type="text"
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
          disabled={loading}
          placeholder="diagram, hero, draft"
          style={inputStyle}
        />
      </Field>

      <div style={{ flex: 1 }} />

      {/* Save */}
      <button
        type="button"
        onClick={handleSave}
        disabled={loading}
        style={{
          flexShrink: 0,
          border: 'none',
          borderRadius: 'var(--radius)',
          background: saved ? 'var(--muted)' : 'var(--oxford)',
          color: '#fff',
          fontSize: 13,
          fontWeight: 700,
          padding: '9px 14px',
          cursor: loading ? 'default' : 'pointer',
          fontFamily: 'var(--font-ui)',
          opacity: loading ? 0.6 : 1,
          transition: 'background 0.15s'
        }}
      >
        {saved ? 'Saved ✓' : 'Save'}
      </button>
    </aside>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink)' }}>{label}</span>
        {hint && <span style={{ fontSize: 10, color: 'var(--faint)' }}>{hint}</span>}
      </span>
      {children}
    </label>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  border: '1px solid var(--line)',
  borderRadius: 4,
  background: 'var(--paper)',
  color: 'var(--ink)',
  fontSize: 13,
  padding: '7px 9px',
  outline: 'none',
  fontFamily: 'var(--font-ui)'
}
