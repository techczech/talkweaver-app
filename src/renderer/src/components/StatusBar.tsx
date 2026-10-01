import { useState, useEffect, type ReactNode } from 'react'
import { APP_VERSION, BUILD_SHA, BUILD_TIME } from '../buildInfo'
import { formatTalkDates, type TalkDates } from '../lib/talkFacts'

interface Props {
  slideCount?: number | null
  wordCount?: number
  lastSaved?: Date | null
  /** Unsaved edits pending (autosave debounce) or a save was refused/failed. */
  dirty?: boolean
  compiling?: boolean
  buildStatus?: 'idle' | 'building' | 'done' | 'error'
  buildPath?: string | null
  /** Created/edited/delivered for the active talk (T29) — nothing renders until loaded. */
  dates?: TalkDates | null
  /** Version-only bar for the no-talk-open empty state. */
  minimal?: boolean
  /** The talk's next planned Run and pre-work chips (round-3 P3, P5). */
  runChips?: ReactNode
  /** Share for comments: "Shared for comments · <link>" while the talk is shared; click reopens the sheet. */
  shared?: { label: string; title?: string; error?: boolean; paused?: boolean; ended?: boolean; onClick?: () => void } | null
}

function formatAge(d: Date): string {
  const secs = Math.round((Date.now() - d.getTime()) / 1000)
  if (secs < 5) return 'Saved just now'
  if (secs < 60) return `Saved ${secs}s ago`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `Saved ${mins}m ago`
  return `Saved ${Math.round(mins / 60)}h ago`
}

function basename(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() ?? p
}

export default function StatusBar({
  slideCount = null,
  wordCount = 0,
  lastSaved = null,
  dirty = false,
  compiling = false,
  buildStatus = 'idle',
  buildPath = null,
  dates = null,
  minimal = false,
  shared = null,
  runChips = null,
}: Props) {
  const [, tick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  // Keep showing the last known count while a recompile is in flight — `compiling` flips true on
  // every keystroke (the compile itself is debounced), so blanking here made the count read "—"
  // almost permanently while typing. A trailing ellipsis marks the in-flight state instead.
  const slideLabel =
    slideCount === null ? '—' : `${slideCount} slides${compiling ? '…' : ''}`
  const wordLabel = `${wordCount} words`
  const savedLabel = dirty ? '● Unsaved' : lastSaved ? formatAge(lastSaved) : '—'

  // Talk dates (T29): `Created … · Edited … · Delivered never|<date>` right after the slide
  // count. Each date carries the full date+time as its title; nothing renders until the
  // talk's metadata has loaded (no placeholder dashes).
  const dateParts = minimal || !dates ? [] : formatTalkDates(dates)

  // buildPath is a filesystem path for local builds and an https URL after a publish — the chip
  // must say which it is, and clicking a URL must open the browser (shell.openPath is a no-op on
  // URLs, which made the one persistent record of a publish a dead control).
  const buildIsUrl = Boolean(buildPath && /^https?:\/\//.test(buildPath))
  const showBuild = buildStatus !== 'idle'
  const buildLabel =
    buildStatus === 'building'
      ? 'Building…'
      : buildStatus === 'done'
        ? buildPath
          ? buildIsUrl
            ? `Published ✓ ${buildPath.replace(/^https?:\/\//, '')}`
            : `Built ✓ ${basename(buildPath)}`
          : 'Built'
        : buildStatus === 'error'
          ? 'Build failed'
          : ''

  const buildIsClickable = buildStatus === 'done' && buildPath !== null

  function handleBuildClick() {
    if (!buildIsClickable || !buildPath) return
    if (buildIsUrl) window.tw?.shell?.openExternal?.(buildPath)
    else window.tw?.shell?.openPath?.(buildPath)
  }

  return (
    <div style={styles.bar}>
      <div style={styles.left}>
        <span
          style={styles.build}
          title={`TalkWeaver ${APP_VERSION} · build ${BUILD_SHA}${BUILD_TIME ? ` · built ${new Date(BUILD_TIME).toLocaleString('en-GB')}` : ''}`}
        >
          v{APP_VERSION} · {BUILD_SHA}
        </span>
        {!minimal && (
          <>
            <span style={styles.sep}>|</span>
            <span style={styles.item}>{slideLabel}</span>
            {dateParts.length > 0 && (
              <>
                <span style={styles.sep}>|</span>
                <span style={styles.item}>
                  {dateParts.map((part, index) => (
                    <span key={part.text}>
                      {index > 0 && ' · '}
                      <span title={part.title}>{part.text}</span>
                    </span>
                  ))}
                </span>
              </>
            )}
            {runChips}
            <span style={styles.sep}>|</span>
            <span style={styles.item}>{wordLabel}</span>
            <span style={styles.sep}>|</span>
            <span style={styles.item}>{savedLabel}</span>
          </>
        )}
      </div>

      {(showBuild || (shared && !minimal)) && (
        <div style={styles.right}>
          {shared && !minimal && (
            <button
              type="button"
              onClick={shared.onClick}
              style={{ ...styles.chip, ...styles.chipBtn, ...(shared.ended ? styles.chipEnded : shared.paused ? styles.chipPaused : shared.error ? styles.chipError : styles.chipShared), marginRight: showBuild ? '6px' : 0 }}
              title={shared.title}
              data-testid="status-shared"
              data-paused={shared.paused ? 'true' : undefined}
              data-ended={shared.ended ? 'true' : undefined}
            >
              {shared.label}
            </button>
          )}
          {!showBuild ? null : buildIsClickable ? (
            <button
              onClick={handleBuildClick}
              style={{ ...styles.chip, ...styles.chipDone, ...styles.chipBtn }}
              title={buildPath ?? undefined}
            >
              {buildLabel}
            </button>
          ) : (
            <span
              style={{
                ...styles.chip,
                ...(buildStatus === 'building' ? styles.chipBuilding : {}),
                ...(buildStatus === 'error' ? styles.chipError : {}),
              }}
            >
              {buildLabel}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    height: '24px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 12px',
    fontSize: '11px',
    color: 'var(--faint)',
    background: 'var(--panel)',
    borderTop: '1px solid var(--line)',
    flexShrink: 0,
    userSelect: 'none',
  },
  left: {
    display: 'flex',
    alignItems: 'center',
    gap: '0',
    overflow: 'hidden',
  },
  right: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    marginLeft: '8px',
  },
  item: {
    color: 'var(--muted)',
    whiteSpace: 'nowrap',
  },
  build: {
    color: 'var(--faint)',
    whiteSpace: 'nowrap',
    fontFamily: 'var(--font-mono)',
    fontSize: '10.5px',
    cursor: 'default',
  },
  sep: {
    margin: '0 8px',
    color: 'var(--line)',
  },
  chip: {
    fontSize: '11px',
    padding: '1px 6px',
    borderRadius: '4px',
    whiteSpace: 'nowrap',
    lineHeight: '1.5',
  },
  chipEnded: {
    color: 'var(--muted)',
    background: 'color-mix(in srgb, var(--muted) 14%, transparent)',
  },
  chipPaused: {
    color: 'var(--amber)',
    background: 'var(--amber-bg)',
  },
  chipShared: {
    color: 'var(--oxford)',
    background: 'color-mix(in srgb, var(--oxford) 8%, transparent)',
  },
  chipBuilding: {
    color: 'var(--muted)',
    background: 'color-mix(in srgb, var(--muted) 12%, transparent)',
  },
  chipDone: {
    color: 'var(--green)',
    background: 'color-mix(in srgb, var(--green) 10%, transparent)',
  },
  chipError: {
    color: 'var(--crimson)',
    background: 'color-mix(in srgb, var(--crimson) 10%, transparent)',
  },
  chipBtn: {
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
}
