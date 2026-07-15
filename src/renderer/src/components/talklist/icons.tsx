// Lucide-derived inline icons for the Talks browser, lifted from the locked mockup
// (docs/design/2026-07-10-talks-browser/lock-candidate-ledger-shelf.html). Real icon
// geometry only — no emoji, no unicode glyph stand-ins (taste rule, ADR-0008).

function make(paths: string, strokeWidth = 2) {
  return function LucideIcon({ size = 14 }: { size?: number }): JSX.Element {
    return (
      <svg
        width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
        aria-hidden focusable="false" style={{ flexShrink: 0 }}
      >
        {paths.split('|').map((d, i) => (d.startsWith('c:')
          ? <circle key={i} cx={d.split(':')[1].split(',')[0]} cy={d.split(':')[1].split(',')[1]} r={d.split(':')[1].split(',')[2]} />
          : <path key={i} d={d} />))}
      </svg>
    )
  }
}

// Toolbar
export const IcLedger = make('M8 6h13|M8 12h13|M8 18h13|M3 6h.01|M3 12h.01|M3 18h.01')
export const IcShelf = make('M7 2h10|M5 6h14|M3 12a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z')
export const IcFilePlus = make('M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4|M14 2v4a2 2 0 0 0 2 2h4|M3 15h6|M6 12v6')
export const IcFolderPlus = make('M12 10v6|M9 13h6|M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z')
export const IcSort = make('m21 16-4 4-4-4|M17 20V4|m3 8 4-4 4 4|M7 4v16')
export const IcCollapse = make('m7 20 5-5 5 5|m7 4 5 5 5-5')
export const IcRefresh = make('M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8|M21 3v5h-5|M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16|M8 16H3v5')
export const IcSwap = make('M16 3l4 4-4 4|M20 7H8|M8 21l-4-4 4-4|M4 17h12')

// Search
export const IcSearch = make('c:11,11,8|m21 21-4.3-4.3')
export const IcClear = make('M18 6 6 18|m6 6 12 12', 2.5)

// Tree
export const IcChevronRight = make('m9 18 6-6-6-6', 2.5)
export const IcDrillIn = make('m13 17 5-5-5-5|m6 17 5-5-5-5')
export const IcFolderClosed = make('M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z')
export const IcFolderOpen = make('m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2')
export const IcFile = make('M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z|M14 2v4a2 2 0 0 0 2 2h4|M10 9H8|M16 13H8|M16 17H8')

// Badges
export const IcCheck = make('M20 6 9 17l-5-5', 3)
export const IcWarn = make('m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3|M12 9v4|M12 17h.01', 2.4)

// Context menu
export const IcOpen = make('M5 12h14|m12 5 7 7-7 7')
export const IcRename = make('M12 20h9|M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z')
export const IcDuplicate = make('M8 8h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2z|M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2')
export const IcReveal = make('M15 3h6v6|M10 14 21 3|M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6')
export const IcTrash = make('M3 6h18|M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6|M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2')
export const IcMoveFolder = make('M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z')
// Metadata panel (ADR-0036) — file-text: a document with field lines.
export const IcMeta = make('M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|M14 2v6h6|M8 13h8|M8 17h5')
