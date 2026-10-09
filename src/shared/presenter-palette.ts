// The presenter's command palette (⌘⇧P; ADR-0031 §6, presenter redesign ticket 07; drawn in
// docs/design/2026-09-26-presenter-redesign/round-2/, shot palette-open-1440x900.png): every
// presenter command, in eight groups, each with its icon, its name and its current key.
//
// One table, three consumers:
//   • scripts/build-shortcut-help.mjs writes it into the template's generated block
//     (PRESENTER_PALETTE), with each entry's keys resolved from the shortcut registry, and marks
//     the ? sheet's rows whose keys need a preload (PRESENTER_KEY_NEEDS);
//   • the template renders and runs it (renderPresenterCommands / runPaletteEntry);
//   • scripts/test-presenter-palette.mjs checks it against the rendered window: every command
//     reachable from a presenter menu, button or key is here, and running an entry runs the same
//     command as that menu item, button or key.
//
// How an entry runs, in order:
//   • `controls`: CSS selectors of the controls that run this command (menu items, bottom-bar and
//     status-bar buttons, the More menu, the REC cluster). The palette clicks the first one that
//     applies, so it runs the very listener the control runs. A control applies when it exists, is
//     not disabled, and is not hidden other than by a closed menu or popover it lives in. (The
//     recording toasts' buttons are not listed: a toast hides by a class, and each has a cluster
//     button or a key that runs the same command.)
//   • `viaKey`: when none of its controls applies, the palette sends the entry's registry key (its
//     first code), so it runs the very handler the key runs. Used where the command has no control
//     that is always there.
//   • otherwise the template's PRESENTER_PALETTE_RUN names the function the key calls.
// Shortcut text always comes from the registry: `shortcut` names a SHORTCUT_REGISTRY id, and
// `keyPart` picks one key of an entry that lists several ("→ Space ↓ PgDn" → "→").

export interface PresenterPaletteEntry {
  /** Stable id (the template's run map and the tests use it). */
  id: string
  name: string
  /** lucide icon name. */
  icon: string
  /** SHORTCUT_REGISTRY id whose keys the row shows. */
  shortcut?: string
  /** Which of the registry entry's keys to show (split on " / ", else on spaces). */
  keyPart?: number
  /** Selectors of the controls that run this command; the first that applies is clicked. */
  controls?: string[]
  /** Run by sending the registry key (its first code). */
  viaKey?: true
  /** A selector that must match for the entry to apply (a preload's mount point). */
  needs?: string
  /** Extra search words. */
  words?: string[]
}

type Group = [string, PresenterPaletteEntry[]]

const RECORDER = '#twrec-module'
const EDIT_BRIDGE = '#twedit-btn'
/**
 * The live preload (src/preload/present-live-bridge.ts) marks the document with this attribute
 * once it has bound G and exposed the live bridge that polls go through. A presenter window opened
 * without it (a deck opened on its own) has no live session: G does nothing there, and Q, ⇧Q and a
 * Quick poll cannot reach the audience (presenter redesign ticket 08).
 */
export const LIVE_BRIDGE_ATTRIBUTE = 'data-tw-live-bridge'
const LIVE_BRIDGE = `[${LIVE_BRIDGE_ATTRIBUTE}]`

export const PRESENTER_PALETTE: Group[] = [
  ['Slides', [
    { id: 'next', name: 'Next', icon: 'arrow-right', shortcut: 'presenter.next', keyPart: 0, controls: ['#presenterNext'] },
    { id: 'previous', name: 'Previous', icon: 'arrow-left', shortcut: 'presenter.previous', keyPart: 0, controls: ['#presenterPrev'] },
    { id: 'skip', name: 'Skip next slide', icon: 'skip-forward', shortcut: 'presenter.skip', controls: ['#skipNextBtn'] },
    { id: 'return', name: 'Return to where you jumped from', icon: 'undo-2', shortcut: 'presenter.return', controls: ['#returnBtn', '#moreReturn'] },
    { id: 'first', name: 'First slide', icon: 'chevron-first', shortcut: 'presenter.first', controls: ['#presenterFirst'] },
    { id: 'last', name: 'Last slide', icon: 'chevron-last', shortcut: 'presenter.last', controls: ['#presenterLast'] },
    { id: 'outline', name: 'Outline', icon: 'list-tree', shortcut: 'presenter.overview', controls: ['#outlineBtn', '#viewOutline'] },
    { id: 'grid-card', name: 'Go to card on a grid slide', icon: 'layout-grid', shortcut: 'presenter.grid-child', controls: ['#moreGridCard'] },
    { id: 'embed', name: 'Interact with embedded page', icon: 'mouse-pointer-click', shortcut: 'presenter.embed', controls: ['#moreEmbed'] }
  ]],
  ['Timer', [
    { id: 'timer', name: 'Start, pause or resume timer', icon: 'timer', shortcut: 'presenter.timer', controls: ['#twClockBtn', '#twStartTimerBtn'] },
    { id: 'duration', name: 'Talk length and reminders…', icon: 'alarm-clock', shortcut: 'presenter.duration', controls: ['#twDurationBtn'] },
    { id: 'reset-timer', name: 'Reset timer', icon: 'timer-reset', controls: ['#twResetBtn'] }
  ]],
  ['Recording', [
    { id: 'record-start', name: 'Start recording', icon: 'circle-dot', shortcut: 'presenter.record', controls: ['#twrec-primary'] },
    { id: 'record-pause', name: 'Pause or resume recording', icon: 'circle-pause', shortcut: 'presenter.record-pause', controls: ['#twrec-pause', '#twrec-resume'] },
    { id: 'record-stop', name: 'Stop and save recording', icon: 'square', shortcut: 'presenter.record', controls: ['#twrec-stop'] },
    { id: 'save-run-as', name: 'Save run as…', icon: 'tags', shortcut: 'presenter.save-run-as', controls: ['#twrec-change-kind'], viaKey: true, needs: RECORDER, words: ['run kind', 'history', 'change'] }
  ]],
  ['Live', [
    { id: 'live', name: 'Go live or end live session', icon: 'radio', shortcut: 'presenter.live', controls: ['#liveGoButton', '#presenterEndLive', '#presenterGoLive'], needs: LIVE_BRIDGE },
    { id: 'audience', name: 'Open audience window', icon: 'monitor-up', shortcut: 'presenter.audience', controls: ['#presenterAudienceApp'] },
    { id: 'join-link', name: 'Show join link and venue screen', icon: 'scan-qr-code', controls: ['#liveShowJoin'] },
    { id: 'copy-venue-link', name: 'Copy venue-screen link', icon: 'link', controls: ['#liveCopyVenueLink'] },
    { id: 'allow-questions', name: 'Allow slide questions', icon: 'message-circle-question-mark', controls: ['#liveAllowQuestions'], needs: LIVE_BRIDGE, words: ['pause', 'phones', 'audience'] },
    { id: 'allow-reactions', name: 'Allow slide reactions', icon: 'smile-plus', controls: ['#liveAllowReactions'], needs: LIVE_BRIDGE, words: ['pause', 'phones', 'audience'] },
    { id: 'talk-qr', name: 'Show talk QR code', icon: 'qr-code', shortcut: 'presenter.talk-qr', controls: ['#liveTalkQr'] },
    { id: 'instant-compose', name: 'Compose instant slide…', icon: 'zap', shortcut: 'presenter.instant-compose', controls: ['#presenterInstantButton', '#navInstant'] },
    { id: 'instant-paste', name: 'Instant slide from clipboard', icon: 'clipboard', shortcut: 'presenter.instant-paste', controls: ['#liveInstantPaste'] },
    { id: 'instant-back', name: 'Back to slide', icon: 'undo-2', shortcut: 'presenter.instant-return', controls: ['#liveInstantBack', '#presenterInstantBack'] }
  ]],
  ['Poll and questions', [
    { id: 'quick-poll', name: 'Compose Quick poll…', icon: 'vote', shortcut: 'presenter.poll-compose', controls: ['#presenterQuickPollButton', '#navQuickPoll'], needs: LIVE_BRIDGE },
    { id: 'poll-primary', name: 'Open or close current poll', icon: 'lock-open', shortcut: 'presenter.poll-primary', controls: ['#pollMenuPrimary', '#presenterPollOpen', '#presenterPollClose'], needs: LIVE_BRIDGE },
    { id: 'poll-reveal', name: 'Reveal results', icon: 'eye', shortcut: 'presenter.poll-reveal', controls: ['#pollMenuReveal', '#presenterPollReveal'], needs: LIVE_BRIDGE },
    { id: 'poll-panel', name: 'Show poll panel', icon: 'chart-bar', controls: ['#presenterPollPanelToggle'] },
    { id: 'quick-poll-restore', name: 'Show Quick poll on screens', icon: 'monitor-play', controls: ['#presenterQuickPollRestore'] },
    { id: 'quick-poll-dismiss', name: 'Dismiss Quick poll', icon: 'x', controls: ['#presenterQuickPollDismiss'] },
    { id: 'board-close', name: 'Close board to new cards or reopen it', icon: 'lock', shortcut: 'presenter.poll-primary', controls: ['#pollMenuBoardClose'], needs: LIVE_BRIDGE, words: ['board', 'cards'] },
    { id: 'board-freeze', name: 'Freeze or unfreeze the board', icon: 'snowflake', controls: ['#pollMenuBoardFreeze'], needs: LIVE_BRIDGE, words: ['board', 'final'] },
    { id: 'board-panel', name: 'Show board panel', icon: 'layout-grid', controls: ['#pollMenuBoardPanel'], words: ['board', 'inbox'] },
    { id: 'board-full', name: 'Board full screen', icon: 'maximize-2', controls: ['#pollMenuBoardFull'], words: ['board'] },
    { id: 'board-popout', name: 'Pop out the board', icon: 'picture-in-picture-2', controls: ['#pollMenuBoardPopout'], words: ['board', 'window', 'screen'] },
    { id: 'questions', name: 'Open questions', icon: 'message-circle-question-mark', shortcut: 'presenter.questions', controls: ['#pollMenuQuestions'], needs: LIVE_BRIDGE }
  ]],
  ['View', [
    { id: 'previews-larger', name: 'Larger previews', icon: 'gallery-vertical-end', shortcut: 'presenter.preview-size', keyPart: 1 },
    { id: 'previews-smaller', name: 'Smaller previews', icon: 'gallery-vertical-end', shortcut: 'presenter.preview-size', keyPart: 0 },
    { id: 'notes-off', name: 'Notes: off', icon: 'eye-off', controls: ['[data-notes-placement-option="off"]'], words: ['placement'] },
    { id: 'notes-bottom', name: 'Notes: bottom', icon: 'panel-bottom', controls: ['[data-notes-placement-option="bottom"]'], words: ['placement'] },
    { id: 'notes-sidebar', name: 'Notes: sidebar', icon: 'panel-right', controls: ['[data-notes-placement-option="sidebar"]'], words: ['placement'] },
    { id: 'notes-top-band', name: 'Notes: top band', icon: 'panel-top', controls: ['[data-notes-placement-option="top-band"]'], words: ['placement', 'teleprompter'] },
    { id: 'notes-camera-column', name: 'Notes: camera column', icon: 'webcam', controls: ['[data-notes-placement-option="camera-column"]'], words: ['placement', 'teleprompter'] },
    { id: 'notes-scroll-hand', name: 'Notes scroll by hand', icon: 'hand', controls: ['[data-notes-scroll-option="hand"]'] },
    { id: 'notes-scroll-auto', name: 'Notes scroll automatically', icon: 'play', controls: ['[data-notes-scroll-option="auto"]'] },
    { id: 'notes-forward', name: 'Step notes forward', icon: 'chevrons-down', shortcut: 'presenter.notes-scroll', keyPart: 0 },
    { id: 'notes-back', name: 'Step notes back', icon: 'chevrons-up', shortcut: 'presenter.notes-scroll', keyPart: 1 },
    { id: 'notes-faster', name: 'Notes scroll faster', icon: 'plus', controls: ['#notesWpmFaster'], words: ['speed'] },
    { id: 'notes-slower', name: 'Notes scroll slower', icon: 'minus', controls: ['#notesWpmSlower'], words: ['speed'] }
  ]],
  ['Slide on every screen', [
    { id: 'reveal', name: 'Reveal mode', icon: 'layers', shortcut: 'presenter.reveal', controls: ['#viewReveal', '#presenterReveal'] },
    { id: 'focus', name: 'Focus mode', icon: 'focus', shortcut: 'presenter.focus', controls: ['#presenterFocus', '#viewFocus'] },
    { id: 'pointer', name: 'Pointer', icon: 'mouse-pointer-2', shortcut: 'presenter.pointer', controls: ['#presenterPointer', '#viewPointer', '#morePointer'] },
    { id: 'pen', name: 'Pen', icon: 'pen-tool', shortcut: 'presenter.pen', controls: ['#presenterPen', '#viewPen', '#morePen'] },
    { id: 'pen-freehand', name: 'Pen tool: Freehand', icon: 'pen-line', controls: ['#penToolFreehand', '#penStripFreehand'], words: ['draw'] },
    { id: 'pen-arrow', name: 'Pen tool: Arrow', icon: 'move-up-right', controls: ['#penToolArrow', '#penStripArrow'], words: ['draw'] },
    { id: 'pen-rectangle', name: 'Pen tool: Rectangle', icon: 'square', controls: ['#penToolRectangle', '#penStripRectangle'], words: ['draw', 'box'] },
    { id: 'pen-next-tool', name: 'Pen: next tool', icon: 'pen-tool', shortcut: 'presenter.pen-tool', keyPart: 0 },
    { id: 'ink-undo', name: 'Undo last stroke', icon: 'undo-2', shortcut: 'presenter.ink-undo', controls: ['#penUndo', '#penStripUndo'], words: ['pen', 'drawing'] },
    { id: 'ink-clear', name: 'Clear drawing on this slide', icon: 'eraser', shortcut: 'presenter.ink-clear', controls: ['#presenterInkClear', '#viewInkClear', '#moreInkClear'], words: ['pen'] },
    { id: 'ink-clear-all', name: 'Clear all drawings', icon: 'eraser', shortcut: 'presenter.ink-clear-all', controls: ['#viewInkClearAll', '#moreInkClearAll'], words: ['pen'] },
    { id: 'highlight', name: 'Highlight text', icon: 'highlighter', shortcut: 'presenter.highlight', controls: ['#presenterHighlight', '#viewHighlight'] },
    { id: 'highlight-clear', name: 'Clear highlights', icon: 'eraser', controls: ['#presenterHighlightClear', '#viewHighlightClear', '#presenterHighlightChipClear'] },
    { id: 'font-smaller', name: 'Slide text smaller', icon: 'a-arrow-down', shortcut: 'presenter.font-smaller', controls: ['#fontDown', '#viewFontDown'] },
    { id: 'font-larger', name: 'Slide text larger', icon: 'a-arrow-up', shortcut: 'presenter.font-larger', controls: ['#fontUp', '#viewFontUp'] },
    { id: 'media', name: 'Play or pause media', icon: 'play', shortcut: 'presenter.media', controls: ['#presenterMediaPlay', '#presenterMediaPause'] },
    { id: 'video-fullscreen', name: 'Video full screen', icon: 'fullscreen', shortcut: 'presenter.video-fullscreen', controls: ['#presenterVideoFullscreen'] },
    { id: 'embed-fullscreen', name: 'Embedded page: full screen', icon: 'maximize-2', shortcut: 'presenter.embed-fullscreen', controls: ['#presenterEmbedFullscreen'] },
    { id: 'gallery', name: 'Image gallery', icon: 'images', shortcut: 'presenter.gallery', controls: ['#presenterGalleryBtn'] }
  ]],
  ['Editor and help', [
    { id: 'edit', name: 'Edit this slide in TalkWeaver', icon: 'pencil', shortcut: 'presenter.edit', controls: ['#twedit-btn'] },
    { id: 'refresh', name: 'Refresh with latest edits', icon: 'refresh-cw', shortcut: 'presenter.refresh', controls: ['#moreRefresh'] },
    { id: 'shortcuts', name: 'Keyboard shortcuts', icon: 'keyboard', shortcut: 'presenter.help', controls: ['#viewShortcuts'] }
  ]]
]

/** Icons the palette itself draws besides its entries' (the search field's magnifier). */
export const PRESENTER_PALETTE_ICONS = ['search'] as const

/**
 * Presenter keys that only work when a preload has mounted (the presenter window TalkWeaver opens
 * has them; a deck opened on its own does not): the ? sheet shows such a row only when its
 * selector matches. The palette dims the matching entries by their own `needs`.
 * scripts/test-shortcut-registry.mjs fails a key bound only by a preload or the main process that
 * is missing here.
 */
export const PRESENTER_KEY_NEEDS: Record<string, string> = {
  'presenter.record': RECORDER,
  'presenter.record-pause': RECORDER,
  'presenter.save-run-as': RECORDER,
  'presenter.save-run': RECORDER,
  'presenter.live': LIVE_BRIDGE,
  'presenter.poll-primary': LIVE_BRIDGE,
  'presenter.poll-reveal': LIVE_BRIDGE,
  'presenter.poll-compose': LIVE_BRIDGE,
  'presenter.questions': LIVE_BRIDGE,
  'presenter.edit': EDIT_BRIDGE,
  'presenter.refresh': EDIT_BRIDGE
}

interface RegistryEntry { id: string; keys: string; codes: string[] }

/** Every palette entry, in order. */
export function presenterPaletteEntries(palette: Group[] = PRESENTER_PALETTE): PresenterPaletteEntry[] {
  return palette.flatMap(([, entries]) => entries)
}

/** The key a row shows: the registry's text, or the part `keyPart` picks; '' when it has none. */
export function presenterPaletteKeys(entry: PresenterPaletteEntry, registry: readonly RegistryEntry[]): string {
  if (!entry.shortcut) return ''
  const found = registry.find((item) => item.id === entry.shortcut)
  if (!found) throw new Error(`palette entry ${entry.id}: no shortcut ${entry.shortcut} in the registry`)
  if (entry.keyPart === undefined) return found.keys
  const parts = found.keys.includes(' / ') ? found.keys.split(' / ') : found.keys.split(/\s+/)
  const part = parts[entry.keyPart]
  if (!part) throw new Error(`palette entry ${entry.id}: ${entry.shortcut} has no key part ${entry.keyPart} in "${found.keys}"`)
  return part
}

/** The code a viaKey entry sends: its registry entry's first code. */
export function presenterPaletteKeyCode(entry: PresenterPaletteEntry, registry: readonly RegistryEntry[]): string | null {
  if (!entry.viaKey) return null
  const found = registry.find((item) => item.id === entry.shortcut)
  const code = found?.codes[0]
  if (!code) throw new Error(`palette entry ${entry.id}: viaKey needs a registry code`)
  return code
}

/** The palette as the template's generated block carries it: groups of resolved rows. */
export function presenterPaletteData(registry: readonly RegistryEntry[], palette: Group[] = PRESENTER_PALETTE) {
  return palette.map(([group, entries]) => [group, entries.map((entry) => ({
    id: entry.id,
    shortcut: entry.shortcut ?? null,
    name: entry.name,
    icon: entry.icon,
    keys: presenterPaletteKeys(entry, registry),
    controls: entry.controls ?? [],
    code: presenterPaletteKeyCode(entry, registry),
    needs: entry.needs ?? null,
    words: entry.words ?? []
  }))])
}
