// Presenter chrome: every control's icon, name and shortcut, in one table (ADR-0031 §6; presenter
// redesign ticket 01). Three consumers read it:
//   • scripts/build-shortcut-help.mjs writes the template's generated block from it (tooltips,
//     icons per control, the lucide bodies), so the presenter template never hard-codes a name,
//     a key or a glyph for these controls;
//   • the presenter preloads (recording cluster, edit pencil, live button) take their names, keys
//     and icons from it, because they inject their controls after the template has run;
//   • scripts/test-presenter-controls.mjs checks the table against the shortcut registry and the
//     rendered window.
// Shortcut text always comes from the registry (`shortcut` = a SHORTCUT_REGISTRY id), with no
// exception: the recording keys (⇧R, ⇧P, L, the save offer's ↵) and the editor keys (⌘E, ⌘R) are
// registered in the presenter scope (presenter redesign ticket 07).
// Icons are lucide (the editor's set), taken from the compiler's vendored lucide.json by the
// generator into presenter-icons.generated.ts; no glyph is drawn by hand.
import { PRESENTER_ICON_BODIES } from './presenter-icons.generated.ts'
import { PRESENTER_PALETTE_ICONS, presenterPaletteEntries } from './presenter-palette.ts'

export interface PresenterControl {
  /** DOM id of the button (template markup or a preload's injected markup). */
  id: string
  /** The name the tooltip and the accessible name use. */
  name: string
  /** lucide icon name, drawn before the label (after it when iconAfter). */
  icon?: string
  iconAfter?: true
  /** The control shows its icon only; its name is its accessible name. */
  iconOnly?: true
  /** SHORTCUT_REGISTRY id whose `keys` the tooltip shows. */
  shortcut?: string
  /** Placed by a preload rather than the template. */
  preload?: 'recorder' | 'edit' | 'live'
}

/** The pen's option rows: the popover above the Pen button and the strip on a zoomed image share them. */
function penOptionControls(tool: string, ink: string, width: string, undo: string, clear: string): PresenterControl[] {
  return [
    { id: `${tool}Freehand`, name: 'Freehand: draw with the mouse', icon: 'pen-line' },
    { id: `${tool}Arrow`, name: 'Arrow: press on the point, drag to the tail', icon: 'move-up-right' },
    { id: `${tool}Rectangle`, name: 'Rectangle: drag from one corner to the opposite', icon: 'square' },
    { id: `${ink}Red`, name: 'Red ink' }, { id: `${ink}Yellow`, name: 'Yellow ink' },
    { id: `${ink}Green`, name: 'Green ink' }, { id: `${ink}Blue`, name: 'Blue ink' },
    { id: `${width}Thin`, name: 'Thin line' }, { id: `${width}Thick`, name: 'Thick line' },
    { id: undo, name: 'Undo last stroke', icon: 'undo-2', shortcut: 'presenter.ink-undo' },
    { id: clear, name: 'Clear this slide', icon: 'eraser', shortcut: 'presenter.ink-clear' }
  ]
}

export const PRESENTER_CONTROLS: PresenterControl[] = [
  // Status bar: the clock is the pause/resume button (its name follows the timer state, from
  // TIMER_BUTTON_NAMES; it shows the time, not an icon). The chevron beside it opens the clock
  // popover: talk length, presets, reminders and Reset timer (presenter redesign ticket 02).
  { id: 'twClockBtn', name: 'Start timer', shortcut: 'presenter.timer' },
  { id: 'twStartTimerBtn', name: 'Start timer', icon: 'timer', shortcut: 'presenter.timer' },
  { id: 'twDurationBtn', name: 'Talk length and reset', icon: 'chevron-down', iconOnly: true, shortcut: 'presenter.duration' },
  { id: 'twResetBtn', name: 'Reset timer', icon: 'timer-reset' },
  { id: 'twDurationMinus', name: 'Talk length 5 minutes shorter', icon: 'minus', iconOnly: true },
  { id: 'twDurationPlus', name: 'Talk length 5 minutes longer', icon: 'plus', iconOnly: true },
  // Status bar: live status. The live preload shows it and wires it (src/preload/present-live-bridge.ts).
  // Before a session the status reads "Not live" and is itself the Go live button (Dominik's
  // preview.8 feedback, 28 Sep): the Live menu's Go live command, key G.
  { id: 'presenterGoLive', name: 'Go live', icon: 'radio', shortcut: 'presenter.live', preload: 'live' },
  { id: 'presenterEndLive', name: 'End live session', icon: 'radio-off', shortcut: 'presenter.live', preload: 'live' },
  // Top bar, right: the Live, Poll and View menu buttons (presenter redesign ticket 04; ADR-0031 §2).
  // The chevron after the label is drawn by the template; at collapse step c8 the label goes and
  // the tooltip names the menu.
  { id: 'presenterMenuLive', name: 'Live menu', icon: 'radio' },
  { id: 'presenterMenuPoll', name: 'Poll menu', icon: 'vote' },
  { id: 'presenterMenuView', name: 'View menu', icon: 'panels-top-left' },
  // Live menu. Session: Go live / End live session (the live preload names it by the state and
  // wires it, with Show join link and Copy venue-screen link), Open audience window. On every
  // screen: talk QR code, instant slide (composer, clipboard, back to slide). Items keep the ids of
  // the top-bar buttons they replace, so every other caller (F5 in the main process, the preload)
  // still reaches the same command.
  { id: 'liveGoButton', name: 'Go live', icon: 'radio', shortcut: 'presenter.live', preload: 'live' },
  { id: 'presenterAudienceApp', name: 'Open audience window', icon: 'monitor-up', shortcut: 'presenter.audience' },
  { id: 'liveShowJoin', name: 'Show join link and venue screen', icon: 'scan-qr-code', preload: 'live' },
  { id: 'liveCopyVenueLink', name: 'Copy venue-screen link', icon: 'link', preload: 'live' },
  // From phones · this talk (ADR-0027 amendment, 2026-09-29): two switches, on by default and kept
  // per talk. Each names what phones show while it is on; the template writes the sub-line.
  { id: 'liveAllowQuestions', name: 'Allow slide questions', icon: 'message-circle-question-mark' },
  { id: 'liveAllowReactions', name: 'Allow slide reactions', icon: 'smile-plus' },
  { id: 'liveTalkQr', name: 'Show talk QR code', icon: 'qr-code', shortcut: 'presenter.talk-qr' },
  { id: 'presenterInstantButton', name: 'Compose instant slide', icon: 'zap', shortcut: 'presenter.instant-compose' },
  { id: 'liveInstantPaste', name: 'Instant slide from clipboard', icon: 'clipboard', shortcut: 'presenter.instant-paste' },
  { id: 'liveInstantBack', name: 'Back to slide', icon: 'undo-2', shortcut: 'presenter.instant-return' },
  // Poll menu. Quick poll: compose, show on screens. Current poll: open or close, reveal, show the
  // panel. Questions: open the questions tray (key A; the item is enabled while a session is live).
  { id: 'presenterQuickPollButton', name: 'Compose Quick poll', icon: 'vote', shortcut: 'presenter.poll-compose' },
  { id: 'presenterQuickPollRestore', name: 'Show Quick poll on screens', icon: 'monitor-play' },
  { id: 'pollMenuPrimary', name: 'Open or close current poll', icon: 'lock-open', shortcut: 'presenter.poll-primary' },
  { id: 'pollMenuReveal', name: 'Reveal results', icon: 'eye', shortcut: 'presenter.poll-reveal' },
  { id: 'presenterPollPanelToggle', name: 'Show poll panel', icon: 'chart-bar' },
  // Poll menu, Board group (feedback-boards ticket 05, D19): shown while the current poll is a board.
  { id: 'pollMenuBoardClose', name: 'Close board to new cards', icon: 'lock', shortcut: 'presenter.poll-primary' },
  { id: 'pollMenuBoardFreeze', name: 'Freeze board', icon: 'snowflake' },
  { id: 'pollMenuBoardPanel', name: 'Show board panel', icon: 'layout-grid' },
  { id: 'pollMenuBoardFull', name: 'Board full screen', icon: 'maximize-2' },
  { id: 'pollMenuBoardPopout', name: 'Pop out the board', icon: 'picture-in-picture-2' },
  { id: 'pollMenuQuestions', name: 'Open questions', icon: 'message-circle-question-mark', shortcut: 'presenter.questions' },
  // View menu. Layout: previews (a Large / Medium / Small / Off row, keys [ / ]), notes placement
  // and scrolling (opens the Notes menu), outline. Slide on every screen: slide text, reveal, focus,
  // highlight, clear highlights. Then keyboard shortcuts and all commands.
  { id: 'notesPlacementBtn', name: 'Notes placement and scrolling', icon: 'notebook-text' },
  { id: 'viewOutline', name: 'Outline', icon: 'list-tree', shortcut: 'presenter.overview' },
  { id: 'viewFontDown', name: 'Slide text smaller', icon: 'a-arrow-down', shortcut: 'presenter.font-smaller' },
  { id: 'viewFontUp', name: 'Slide text larger', icon: 'a-arrow-up', shortcut: 'presenter.font-larger' },
  { id: 'viewReveal', name: 'Reveal mode', icon: 'layers', shortcut: 'presenter.reveal' },
  { id: 'viewFocus', name: 'Focus mode', icon: 'focus', shortcut: 'presenter.focus' },
  { id: 'viewHighlight', name: 'Highlight text', icon: 'highlighter', shortcut: 'presenter.highlight' },
  { id: 'viewHighlightClear', name: 'Clear highlights', icon: 'eraser' },
  { id: 'viewShortcuts', name: 'Keyboard shortcuts', icon: 'keyboard', shortcut: 'presenter.help' },
  { id: 'viewCommands', name: 'All commands', icon: 'command', shortcut: 'presenter.command-palette' },
  // The Notes menu (opened from View): speed stepper.
  { id: 'notesWpmSlower', name: 'Notes scroll slower', icon: 'minus', iconOnly: true },
  { id: 'notesWpmFaster', name: 'Notes scroll faster', icon: 'plus', iconOnly: true },
  // Over the slide: go-live panel, instant strip, composers, poll panel
  { id: 'liveGoPanelClose', name: 'Hide the join link', icon: 'x', iconOnly: true },
  { id: 'liveVenueCopy', name: 'Copy venue-screen link', icon: 'copy' },
  { id: 'presenterInstantBack', name: 'Back to slide', icon: 'undo-2', shortcut: 'presenter.instant-return' },
  { id: 'instantClose', name: 'Close instant slide', icon: 'x', iconOnly: true },
  { id: 'instantPasteClose', name: 'Cancel clipboard preview', icon: 'x', iconOnly: true },
  { id: 'quickPollClose', name: 'Close Quick poll', icon: 'x', iconOnly: true },
  { id: 'presenterPollDismiss', name: 'Hide the poll panel', icon: 'x', iconOnly: true },
  { id: 'presenterPollOpen', name: 'Open poll', icon: 'lock-open', shortcut: 'presenter.poll-primary' },
  { id: 'presenterPollClose', name: 'Stop accepting responses', icon: 'lock', shortcut: 'presenter.poll-primary' },
  { id: 'presenterPollReveal', name: 'Reveal results', icon: 'eye', shortcut: 'presenter.poll-reveal' },
  { id: 'presenterPollShowQuestion', name: 'Show the question on screens', icon: 'message-square-text' },
  { id: 'presenterPollShowResults', name: 'Show the results on screens', icon: 'chart-bar' },
  { id: 'presenterPollPreviousPage', name: 'Previous page of the poll', icon: 'chevron-left' },
  { id: 'presenterPollNextPage', name: 'Next page of the poll', icon: 'chevron-right' },
  { id: 'presenterQuickPollDismiss', name: 'Dismiss Quick poll', icon: 'x' },
  // Notes and outline
  { id: 'presenterNotesMore', name: 'Step notes forward', icon: 'chevrons-down', iconAfter: true, shortcut: 'presenter.notes-scroll' },
  { id: 'presenterOutlineExpand', name: 'Show previews in the outline', icon: 'layout-grid' },
  { id: 'presenterOutlineClose', name: 'Close outline', icon: 'x', iconOnly: true, shortcut: 'presenter.overview' },
  // Bottom bar (presenter redesign ticket 05; ADR-0031 §4): Outline left; Previous, Next and
  // Skip next (icon only) in the centre, with Return after a jump and the media and gallery
  // controls on slides that have them; Quick poll, Instant slide, Focus and Highlight (icon and
  // label; Focus and Highlight show pressed while on), "…" More, then the edit pencil (the edit
  // bridge mounts it, below). The bar collapses by n1-n3 (fitBottomBar in the template).
  { id: 'outlineBtn', name: 'Outline', icon: 'list-tree', shortcut: 'presenter.overview' },
  { id: 'presenterPrev', name: 'Previous', icon: 'arrow-left', shortcut: 'presenter.previous' },
  { id: 'presenterNext', name: 'Next', icon: 'arrow-right', iconAfter: true, shortcut: 'presenter.next' },
  { id: 'skipNextBtn', name: 'Skip next slide', icon: 'skip-forward', iconOnly: true, shortcut: 'presenter.skip' },
  { id: 'returnBtn', name: 'Return to where you jumped from', icon: 'undo-2', shortcut: 'presenter.return' },
  { id: 'presenterMediaPlay', name: 'Play media', icon: 'play', shortcut: 'presenter.media' },
  { id: 'presenterMediaPause', name: 'Pause media', icon: 'pause' },
  { id: 'presenterVideoFullscreen', name: 'Video full screen', icon: 'fullscreen', shortcut: 'presenter.video-fullscreen' },
  { id: 'presenterGalleryBtn', name: 'Image gallery', icon: 'images', shortcut: 'presenter.gallery' },
  // On the Current pane, beside a running embedded page (0.38 ticket 13); the deck places it.
  { id: 'presenterEmbedFullscreen', name: 'Embedded page: full screen', icon: 'maximize-2', iconOnly: true, shortcut: 'presenter.embed-fullscreen' },
  { id: 'navQuickPoll', name: 'Compose Quick poll', icon: 'vote', shortcut: 'presenter.poll-compose' },
  { id: 'navInstant', name: 'Compose instant slide', icon: 'zap', shortcut: 'presenter.instant-compose' },
  { id: 'presenterFocus', name: 'Focus mode', icon: 'focus', shortcut: 'presenter.focus' },
  { id: 'presenterPointer', name: 'Pointer: show your mouse on every screen', icon: 'mouse-pointer-2', shortcut: 'presenter.pointer' },
  { id: 'viewPointer', name: 'Pointer', icon: 'mouse-pointer-2', shortcut: 'presenter.pointer' },
  { id: 'morePointer', name: 'Pointer', icon: 'mouse-pointer-2', shortcut: 'presenter.pointer' },
  { id: 'presenterPointerExit', name: 'Turn off pointer', icon: 'x', iconOnly: true, shortcut: 'presenter.close' },
  // The Pen (0.38 ticket 08; ADR-0037, docs/design/2026-10-06-pointer-and-pen/): the bar button,
  // its menu items, the status chip and Clear drawing, the options popover and the zoomed-image strip.
  { id: 'presenterPen', name: 'Pen: draw on the slide on every screen', icon: 'pen-tool', shortcut: 'presenter.pen' },
  { id: 'viewPen', name: 'Pen', icon: 'pen-tool', shortcut: 'presenter.pen' },
  { id: 'morePen', name: 'Pen', icon: 'pen-tool', shortcut: 'presenter.pen' },
  { id: 'presenterPenExit', name: 'Turn off pen', icon: 'x', iconOnly: true, shortcut: 'presenter.close' },
  { id: 'presenterInkClear', name: 'Clear the drawing on this slide', icon: 'eraser', shortcut: 'presenter.ink-clear' },
  { id: 'viewInkClear', name: 'Clear drawing on this slide', icon: 'eraser', shortcut: 'presenter.ink-clear' },
  { id: 'moreInkClear', name: 'Clear drawing on this slide', icon: 'eraser', shortcut: 'presenter.ink-clear' },
  { id: 'viewInkClearAll', name: 'Clear all drawings', icon: 'eraser', shortcut: 'presenter.ink-clear-all' },
  { id: 'moreInkClearAll', name: 'Clear all drawings', icon: 'eraser', shortcut: 'presenter.ink-clear-all' },
  ...penOptionControls('penTool', 'penInk', 'penWidth', 'penUndo', 'penClear'),
  ...penOptionControls('penStrip', 'penStripInk', 'penStripWidth', 'penStripUndo', 'penStripClear'),
  { id: 'penStripOff', name: 'Pen off', icon: 'x', shortcut: 'presenter.close' },
  { id: 'presenterHighlight', name: 'Highlight text', icon: 'highlighter', shortcut: 'presenter.highlight' },
  { id: 'presenterMore', name: 'More', icon: 'ellipsis', iconOnly: true },
  // The More menu (opens upward from "…"). Go to: first and last slide, return from a jump, a card
  // on a grid slide. This slide: reveal mode, clear highlights, interact with an embedded page,
  // slide text smaller and larger. Then refresh with latest edits: hidden in the template, shown
  // and wired by the edit bridge (it asks TalkWeaver, as ⌘R does). Items keep the ids of the
  // bottom-bar buttons they replace, so their own listeners run the command.
  { id: 'presenterFirst', name: 'First slide', icon: 'chevron-first', shortcut: 'presenter.first' },
  { id: 'presenterLast', name: 'Last slide', icon: 'chevron-last', shortcut: 'presenter.last' },
  { id: 'moreReturn', name: 'Return to where you jumped from', icon: 'undo-2', shortcut: 'presenter.return' },
  { id: 'moreGridCard', name: 'Card on a grid slide', icon: 'layout-grid', shortcut: 'presenter.grid-child' },
  { id: 'presenterReveal', name: 'Reveal mode', icon: 'layers', shortcut: 'presenter.reveal' },
  { id: 'presenterHighlightClear', name: 'Clear highlights', icon: 'eraser' },
  { id: 'moreEmbed', name: 'Interact with embedded page', icon: 'mouse-pointer-click', shortcut: 'presenter.embed' },
  { id: 'fontDown', name: 'Slide text smaller', icon: 'a-arrow-down', shortcut: 'presenter.font-smaller' },
  { id: 'fontUp', name: 'Slide text larger', icon: 'a-arrow-up', shortcut: 'presenter.font-larger' },
  { id: 'moreRefresh', name: 'Refresh with latest edits', icon: 'refresh-cw', shortcut: 'presenter.refresh' },
  // The mode chip in the status bar while Reveal, Focus or Highlight is on: Clear (highlight only)
  // and the exit button (its name follows the mode, MODE_CHIP_NAMES). At collapse step c10 the
  // chip keeps its icon, colour and buttons but drops its words.
  { id: 'presenterModeExit', name: 'Turn off focus mode', icon: 'x', iconOnly: true, shortcut: 'presenter.close' },
  { id: 'presenterHighlightExit', name: 'Turn off highlighting', icon: 'x', iconOnly: true, shortcut: 'presenter.close' },
  { id: 'presenterHighlightChipClear', name: 'Clear highlights on this slide', icon: 'eraser' },
  // REC cluster in the status bar and its toasts (src/preload/present-rec-ui.ts; presenter
  // redesign ticket 03). Pause, Resume and Stop show their icon only in the cluster; the kind of
  // run is chosen at save (Change, Save as…, L), never on start (ADR-0031 §3).
  { id: 'twrec-primary', name: 'Start recording', icon: 'circle-dot', shortcut: 'presenter.record', preload: 'recorder' },
  { id: 'twrec-change-kind', name: 'Change run kind', icon: 'tags', shortcut: 'presenter.save-run-as', preload: 'recorder' },
  { id: 'twrec-pause', name: 'Pause recording', icon: 'circle-pause', shortcut: 'presenter.record-pause', preload: 'recorder' },
  { id: 'twrec-resume', name: 'Resume recording', icon: 'circle-play', shortcut: 'presenter.record-pause', preload: 'recorder' },
  { id: 'twrec-stop', name: 'Stop and save recording', icon: 'square', shortcut: 'presenter.record', preload: 'recorder' },
  { id: 'twrec-keep', name: 'Keep this recording', icon: 'check', preload: 'recorder' },
  { id: 'twrec-discard', name: 'Discard this recording', icon: 'trash-2', preload: 'recorder' },
  { id: 'twrec-toast-yes', name: 'Resume recording', icon: 'circle-play', shortcut: 'presenter.record-pause', preload: 'recorder' },
  { id: 'twrec-toast-no', name: 'Stay paused', icon: 'x', iconOnly: true, preload: 'recorder' },
  { id: 'twrec-save-delivery', name: 'Save this run as a delivery', shortcut: 'presenter.save-run', preload: 'recorder' },
  { id: 'twrec-save-as', name: 'Save run as…', icon: 'tags', shortcut: 'presenter.save-run-as', preload: 'recorder' },
  { id: 'twrec-save-dismiss', name: 'Dismiss save offer', icon: 'x', iconOnly: true, preload: 'recorder' },
  { id: 'twrec-start-record', name: 'Start recording', icon: 'circle-dot', shortcut: 'presenter.record', preload: 'recorder' },
  { id: 'twrec-start-dismiss', name: 'Dismiss recording offer', icon: 'x', iconOnly: true, preload: 'recorder' },
  { id: 'twrec-saved-change', name: 'Change run kind', icon: 'tags', shortcut: 'presenter.save-run-as', preload: 'recorder' },
  { id: 'twrec-saved-dismiss', name: 'Dismiss', icon: 'x', iconOnly: true, preload: 'recorder' },
  // The audio-lost notice (the microphone went away mid-recording) and the audio-back note.
  { id: 'twrec-lost-resume', name: 'Resume recording', icon: 'circle-dot', preload: 'recorder' },
  { id: 'twrec-lost-dismiss', name: 'Dismiss', icon: 'x', iconOnly: true, preload: 'recorder' },
  { id: 'twrec-back-dismiss', name: 'Dismiss', icon: 'x', iconOnly: true, preload: 'recorder' },
  { id: 'twrec-disk-dismiss', name: 'Dismiss', icon: 'x', iconOnly: true, preload: 'recorder' },
  // A failed save keeps the audio: Retry, or write it to a folder of the presenter's choice.
  { id: 'twrec-export', name: 'Save the recording\'s audio to another folder', icon: 'copy', preload: 'recorder' },
  // Edit pencil (src/preload/present-edit-bridge.ts)
  { id: 'twedit-btn', name: 'Edit this slide in TalkWeaver', icon: 'pencil', iconOnly: true, shortcut: 'presenter.edit', preload: 'edit' }
]

/** Icons a control switches to at runtime (Retry save, the refreshed hint, media play/pause). */
export const PRESENTER_STATE_ICONS = ['timer', 'pause', 'play', 'circle-check', 'refresh-cw'] as const
/**
 * Icons on status marks that are not controls (status bar: section chip, reactions, questions,
 * live status while reconnecting; the reminder chips' tick in the clock popover; the REC
 * cluster's saving spinner and saved check, which the saved toast repeats; the mode chip's
 * mark: layers, focus, highlighter; the venue-screen notice and the go-live panel's "venue
 * screen connected" line: monitor-x, monitor-check; the composers' titles, type tabs and own
 * buttons, which are labelled by their words in context and take no tooltip (data-icon in the
 * template): vote, zap, type, image, clock, lock-open, monitor-up, plus; the outline's heading
 * (list-tree) and its slide marks and legend: circle shown, circle-slash skipped, circle-dashed
 * not yet shown, OUTLINE_STATUS_ICONS).
 */
export const PRESENTER_STATUS_ICONS = ['layers', 'focus', 'highlighter', 'flag', 'frown', 'lightbulb', 'bookmark', 'thumbs-up', 'thumbs-down', 'x', 'message-circle-more', 'snail', 'message-circle-question-mark', 'radio', 'wifi-off', 'check', 'loader-circle', 'circle-check', 'monitor-x', 'monitor-check', 'type', 'image', 'clock', 'vote', 'zap', 'lock-open', 'monitor-up', 'plus', 'list-tree', 'circle', 'circle-slash', 'circle-dashed', 'inbox', 'user-round', 'chevron-right', 'pause'] as const
/**
 * The outline's slide marks (presenter redesign ticket 08; round-2 shot outline-open-1440x900.png):
 * the lucide icon for each status the shared overview runtime reports. The handout shows no marks.
 */
export const OUTLINE_STATUS_ICONS = { shown: 'circle', skipped: 'circle-slash', unseen: 'circle-dashed' } as const
/**
 * Icons in the top-bar menus that are not controls of their own: the menu buttons' chevron, the
 * Previews and Slide text row marks, the Notes menu's placement options, their tick, and the
 * Scroll segment (presenter redesign ticket 04). The Go live item turns to radio-off while live.
 */
/**
 * The board panel's icons (feedback-boards ticket 05; compiler/assets/runtime/board-panel.js draws
 * them through the template's twIconEl): header, big-screen strip, inbox, cards, menus, toast, pick.
 */
export const PRESENTER_BOARD_ICONS = ['layout-grid', 'lock', 'lock-open', 'snowflake', 'maximize-2', 'minimize-2', 'picture-in-picture-2', 'x', 'monitor', 'list-end', 'monitor-up', 'monitor-off', 'chevron-down', 'inbox', 'grip-vertical', 'arrow-right', 'eye-off', 'eye', 'ungroup', 'ellipsis', 'group', 'circle-alert', 'circle-check', 'undo-2', 'hand', 'presentation', 'pencil', 'check'] as const
export const PRESENTER_MENU_ICONS = ['chevron-down', 'gallery-vertical-end', 'a-arrow-up', 'eye-off', 'panel-bottom', 'panel-right', 'panel-top', 'webcam', 'check', 'hand', 'play', 'radio-off'] as const

/**
 * Names the clock button takes in each timer state (its tooltip and accessible name). The Start
 * timer button beside the clock reads "Start timer" before the talk and "Resume timer" while paused.
 */
export const TIMER_BUTTON_NAMES = { idle: 'Start timer', running: 'Pause timer', paused: 'Resume timer' } as const

/**
 * The mode chip per mode: its icon, its words, and the name of its exit button (tooltip and
 * accessible name). Reveal and Focus share one chip (they are exclusive); Highlight has its own.
 */
export const MODE_CHIP_NAMES = {
  reveal: { icon: 'layers', word: 'Reveal mode', exit: 'Turn off reveal mode' },
  focus: { icon: 'focus', word: 'Focus mode', exit: 'Turn off focus mode' },
  highlight: { icon: 'highlighter', word: 'Highlight on', exit: 'Turn off highlighting' }
} as const

interface RegistryEntry { id: string; keys: string }

/** Every lucide icon the presenter chrome uses, sorted, unique. */
export function presenterIconNames(controls: PresenterControl[] = PRESENTER_CONTROLS): string[] {
  const names = new Set<string>([...PRESENTER_STATE_ICONS, ...PRESENTER_STATUS_ICONS, ...PRESENTER_MENU_ICONS, ...PRESENTER_BOARD_ICONS, ...PRESENTER_PALETTE_ICONS])
  for (const control of controls) if (control.icon) names.add(control.icon)
  // The command palette's rows (src/shared/presenter-palette.ts).
  for (const entry of presenterPaletteEntries()) names.add(entry.icon)
  return [...names].sort()
}

/** The keys a control's tooltip shows: the registry's text, or '' when it has no key. */
export function presenterControlKeys(control: PresenterControl, registry: readonly RegistryEntry[]): string {
  if (control.shortcut) {
    const entry = registry.find((item) => item.id === control.shortcut)
    if (!entry) throw new Error(`presenter control ${control.id}: no shortcut ${control.shortcut} in the registry`)
    return entry.keys
  }
  return ''
}

/** id → [name, keys] for every control; keys are '' where no key exists. */
export function presenterControlTips(registry: readonly RegistryEntry[], controls: PresenterControl[] = PRESENTER_CONTROLS): Record<string, [string, string]> {
  return Object.fromEntries(controls.map((control) => [control.id, [control.name, presenterControlKeys(control, registry)]]))
}

/** A lucide icon as inline SVG: one stroke width (2), sized by CSS (.tw-ico, one size step). */
export function presenterIconSvg(name: string, body: string | undefined = PRESENTER_ICON_BODIES[name]): string {
  if (!body) throw new Error(`presenter icon ${name}: not generated (npm run generate:shortcut-help)`)
  return `<svg class="tw-ico tw-btn-ico lucide lucide-${name}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`
}

export function presenterControl(id: string): PresenterControl {
  const control = PRESENTER_CONTROLS.find((item) => item.id === id)
  if (!control) throw new Error(`unknown presenter control ${id}`)
  return control
}

/**
 * Dresses a button a preload owns: icon, label, accessible name, tooltip name and keys. The
 * template's delegated tooltip reads data-tip and data-key. `label` replaces the visible text
 * (icon-only controls get none); the icon stays the first (or last) child.
 */
export function dressPresenterButton(
  button: HTMLElement,
  control: PresenterControl,
  registry: readonly RegistryEntry[],
  options: { label?: string; name?: string; icon?: string } = {}
): void {
  const name = options.name ?? control.name
  const keys = presenterControlKeys(control, registry)
  const icon = options.icon ?? control.icon
  const doc = button.ownerDocument
  let iconEl = button.querySelector(':scope > svg.tw-ico')
  if (icon && (!iconEl || !iconEl.classList.contains(`lucide-${icon}`))) {
    const holder = doc.createElement('span')
    holder.innerHTML = presenterIconSvg(icon)
    const fresh = holder.firstElementChild as Element
    if (iconEl) iconEl.replaceWith(fresh)
    else if (control.iconAfter) button.append(fresh)
    else button.prepend(fresh)
    iconEl = fresh
  }
  if (options.label !== undefined || control.iconOnly) {
    let labelEl = button.querySelector<HTMLElement>(':scope > .tw-btn-label')
    if (!labelEl) {
      labelEl = doc.createElement('span')
      labelEl.className = 'tw-btn-label'
      for (const node of Array.from(button.childNodes)) if (node !== iconEl && !(node.nodeType === 1 && (node as Element).classList.contains('kbd'))) node.remove()
      if (iconEl && control.iconAfter) iconEl.before(labelEl)
      else if (iconEl) iconEl.after(labelEl)
      else button.prepend(labelEl)
    }
    labelEl.textContent = control.iconOnly ? '' : (options.label ?? '')
    labelEl.hidden = !!control.iconOnly
  }
  button.dataset.tip = name
  button.dataset.key = keys
  button.setAttribute('aria-label', name)
  button.removeAttribute('title')
}
