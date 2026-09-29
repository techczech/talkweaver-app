// 'slide-picker' is the ⌘S slide picker (SlideBrowser + its Find a talk box): its own surface with its own
// keys, so its S (select section) and the Talks panel's S (sort, 'browser' scope) are two surfaces'
// keys, never one keystroke claimed twice (talk search 08).
export const SHORTCUT_SCOPES = ['app', 'editor', 'browser', 'slide-picker', 'presenter', 'picker', 'pathway', 'studio', 'talktext', 'importer'] as const
export type ShortcutScope = (typeof SHORTCUT_SCOPES)[number]

export interface ShortcutEntry {
  id: string
  keys: string
  codes: string[]
  unbound?: true
  scope: ShortcutScope
  label: string
  explanation: string
  group: string
}

type ShortcutRow = [string, string, string[], string, string, string, true?]

const entries = (scope: ShortcutScope, rows: ShortcutRow[]): ShortcutEntry[] =>
  rows.map(([id, keys, codes, label, explanation, group, unbound]) => ({
    id,
    keys,
    codes,
    scope,
    label,
    explanation,
    group,
    ...(unbound ? { unbound: true as const } : {})
  }))

export const SHORTCUT_REGISTRY: ShortcutEntry[] = [
  ...entries('app', [
    ['app.sidebar-talks', '⌘⇧T', ['Mod-Shift-t'], 'Open Talks panel search', 'Opens the Talks sidebar and moves focus to its search field.', 'Sidebar'],
    ['app.sidebar-outline', '⌘⇧O', ['Mod-Shift-o'], 'Open Slide outline search', 'Opens the slide outline sidebar and moves focus to its search field.', 'Sidebar'],
    ['app.sidebar-toggle', '⌘⇧[ / ⌘\\', ['Mod-Shift-[', 'Mod-\\'], 'Collapse or expand sidebar', 'Toggles the current sidebar without changing its selected mode.', 'Sidebar'],
    ['app.settings', '⌘,', ['Mod-,'], 'Settings', 'Opens or closes the application settings panel.', 'App'],
    ['app.slide-search', '⌘S', ['Mod-s'], 'Search slides across all talks', 'Opens the cross-talk slide browser for finding and inserting slides.', 'Find & insert'],
    ['app.find-talk', '⇧⌘S', ['Mod-Shift-s'], 'Find a talk', 'Opens the slide picker with the cursor in Find a talk, or moves it there when the picker is already open.', 'Find & insert'],
    ['app.context-menu', '⌘K', ['Mod-k'], 'Context menu', 'Opens the context menu for the focused talk, slide, or editor slide.', 'App'],
    ['app.layout-picker', '⌘L', ['Mod-l'], 'Layout picker', 'Opens the layout picker for the current slide.', 'Find & insert'],
    ['app.icon-picker', '⌘I', ['Mod-i'], 'Icon picker', 'Opens the icon picker for the current bullet.', 'Find & insert'],
    ['app.image-search', '⌘⇧I', ['Mod-Shift-i'], 'Insert an archived image', 'Searches images recovered from earlier PowerPoint files.', 'Find & insert'],
    ['app.find', '⌘F', ['Mod-f'], 'Find in outline', 'Opens text search in the current outline editor.', 'Find & insert'],
    ['app.where-used', '⌘⇧U', ['Mod-Shift-u'], 'Where used and versions', 'Shows where the current slide is reused and its available versions.', 'Slides'],
    ['app.slide-focus', '⌘⇧F', ['Mod-Shift-f'], 'Focus current slide', 'Scopes editing and live preview to the current slide.', 'Slides'],
    ['app.command-palette', '⌘⇧P', ['Mod-Shift-p'], 'Command palette', 'Opens the searchable list of application commands.', 'App'],
    ['app.toggle-inspector', '⌘P', ['Mod-p'], 'Inspector mode (replaces the slide strip)', 'Toggles the Inspector in every pane where the slide strip would appear.', 'View'],
    ['app.inspector-slides', '⌥↑ / ⌥↓', ['Alt-ArrowUp', 'Alt-ArrowDown'], 'Inspector previous or next slide', 'Moves the Inspector and editor cursor to the adjacent slide while focus is in the Inspector.', 'View'],
    ['app.inspector-steps', '⌥← / ⌥→', ['Alt-ArrowLeft', 'Alt-ArrowRight'], 'Inspector previous or next step', 'Steps reveal, focus, or carousel behaviour in the Inspector preview.', 'View'],
    ['app.new-window', '⌘N', ['Mod-n'], 'New window', 'Opens another TalkWeaver window.', 'App'],
    ['app.help', '⌘/ / ⌃/', ['Mod-/', 'Ctrl-/'], 'Keyboard shortcuts', 'Opens or closes the generated keyboard shortcut sheet.', 'App'],
    ['app.view-editor', '⌘1', ['Mod-1'], 'Editor only', 'Switches the workspace to the editor-only view.', 'View'],
    ['app.view-split', '⌘2', ['Mod-2'], 'Editor and slides', 'Switches the workspace to the split editor and slide view.', 'View'],
    ['app.view-strip', '⌘3', ['Mod-3'], 'Slide strip', 'Switches the workspace to the slide strip view.', 'View'],
    ['app.view-grid', '⌘4', ['Mod-4'], 'Grid', 'Switches the workspace to the slide grid view.', 'View'],
    ['app.present', 'F5', ['F5'], 'Present from the top', 'Opens presenter view at the first slide.', 'Present'],
    ['app.present-current', '⇧F5', ['Shift-F5'], 'Present from current slide', 'Opens presenter view at the selected slide.', 'Present'],
    ['app.pathways', '⌘⌥P', ['Mod-Alt-p'], 'Open Pathway view', 'Opens the current Talk’s Pathway manager in its own window.', 'Present']
  ]),
  ...entries('editor', [
    ['editor.undo', '⌘Z', ['Mod-z'], 'Undo', 'Reverses the last outline editor change.', 'Editing'],
    ['editor.redo', '⇧⌘Z', ['Mod-Shift-z'], 'Redo', 'Reapplies the last outline editor change.', 'Editing'],
    ['editor.new-slide', '— · ⌘K', [], 'New slide', 'Inserts an empty slide after the current slide.', 'Headings', true],
    ['editor.bulleted-list', '— · ⌘K', [], 'Bulleted list', 'Toggles bullets on the selected lines.', 'Lists', true],
    ['editor.numbered-list', '— · ⌘K', [], 'Numbered list', 'Toggles numbered items on the selected lines.', 'Lists', true],
    ['editor.move-up', '⌘⇧↑', ['Mod-Shift-ArrowUp'], 'Move slide or item up', 'Moves the current outline node before its previous sibling.', 'Reorder'],
    ['editor.move-down', '⌘⇧↓', ['Mod-Shift-ArrowDown'], 'Move slide or item down', 'Moves the current outline node after its next sibling.', 'Reorder'],
    ['editor.promote', '⌘⇧←', ['Mod-Shift-ArrowLeft'], 'Promote heading or outdent', 'Moves the current line one outline level towards the root.', 'Change level'],
    ['editor.demote', '⌘⇧→', ['Mod-Shift-ArrowRight'], 'Demote heading or indent', 'Moves the current line one outline level deeper.', 'Change level'],
    ['editor.promote-subtree', '⌘⌥⇧←', ['Mod-Alt-Shift-ArrowLeft'], 'Promote line and subtree', 'Promotes the current line together with every descendant.', 'Change level'],
    ['editor.demote-subtree', '⌘⌥⇧→', ['Mod-Alt-Shift-ArrowRight'], 'Demote line and subtree', 'Demotes the current line together with every descendant.', 'Change level'],
    ['editor.heading-same', '⌘⌥↑', ['Mod-Alt-ArrowUp'], 'Make heading at same level', 'Turns the line into a heading matching the preceding heading level.', 'Headings'],
    ['editor.heading-sub', '⌘⌥↓', ['Mod-Alt-ArrowDown'], 'Make subheading', 'Turns the line into a heading one level below the preceding heading.', 'Headings'],
    ['editor.jump-prev', '⌘⌥←', ['Mod-Alt-ArrowLeft'], 'Previous heading', 'Moves the caret to the preceding slide heading.', 'Navigate'],
    ['editor.jump-next', '⌘⌥→', ['Mod-Alt-ArrowRight'], 'Next heading', 'Moves the caret to the following slide heading.', 'Navigate'],
    ['editor.delete-slide', '⌘⇧⌫', ['Mod-Shift-Backspace'], 'Delete current slide', 'Deletes the current heading, its body, and its protected trigger line.', 'Reorder'],
    ['editor.title-continue', '↵', ['Enter'], 'Enter from a title', 'From anywhere in a slide title, moves the caret past the protected Trigger line onto the first body line.', 'Lists'],
    ['editor.protected-line-continue', '↵', ['Enter'], 'Enter from a protected line', 'Moves from a canonical Trigger line to its body, or from a block object token to its first list item, without splitting the structural line.', 'Objects'],
    ['editor.list-continue', '↵', ['Enter'], 'Continue list', 'Continues a list or exits it when the current item is empty.', 'Lists'],
    ['editor.list-indent', 'Tab', ['Tab'], 'Indent list item', 'Indents the current list item when the editor context permits it.', 'Lists'],
    ['editor.list-outdent', '⇧Tab', ['Shift-Tab'], 'Outdent list item', 'Outdents the current list item when the editor context permits it.', 'Lists'],
    ['editor.bold', '⌘B', ['Mod-b'], 'Bold selection', 'Wraps or unwraps the current selection in Markdown bold markers.', 'Format'],
    ['editor.italic', '— · ⌘K', [], 'Italic selection', 'Wraps or unwraps the selection in Markdown italic markers. Exceptional use — no default key; rebindable.', 'Format', true],
    ['editor.inline-code', '— · ⌘K', [], 'Inline code', 'Wraps or unwraps the selection in backticks.', 'Format', true],
    ['editor.highlight', '— · ⌘K', [], 'Highlight selection', 'Sweeps the warm yellow marker (==mark==) over the selection.', 'Format', true],
    ['editor.link', '⌘⇧L', ['Mod-Shift-l'], 'Insert link (clipboard-aware)', 'Wraps the selection as a Markdown link; a URL in the clipboard becomes the target. WriteFlex’s ⌘⇧K is not carried — the universal keymap reserves it.', 'Format'],
    ['editor.rollback-trigger', 'Esc', ['Escape'], 'Cancel trigger completion', 'Restores the exact text that preceded a provisional trigger completion.', 'Editing'],
    ['editor.protect-heading-delete', '⌘⌫ / ⌫', ['Mod-Backspace', 'Backspace'], 'Protect slide identity', 'Prevents partial deletion from corrupting a slide heading and trigger identity.', 'Editing'],
    ['editor.object-edit', '↵', ['Enter'], 'Edit object at caret', 'Opens the selected object block for in-place editing; inside an open object, Enter is a plain newline.', 'Objects'],
    ['editor.object-raw', '⇧⌘M', ['Shift-Mod-m'], 'Show markup on widget', 'Toggles the raw markup view on the object block at the caret.', 'Objects'],
    ['editor.object-finish', '⌘↵', ['Mod-Enter'], 'Finish object editing', 'Closes the open object source and returns to its rendered widget.', 'Objects'],
    ['editor.object-leave', 'Esc', ['Escape'], 'Commit and leave object editing', 'Commits the open object source and returns to its rendered widget.', 'Objects']
  ]),
  ...entries('browser', [
    ['browser.move', '↑ ↓ ← →', ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'], 'Move selection', 'Moves keyboard focus through slide cards, strip items, or talk rows.', 'Navigation'],
    ['browser.open', '↵', ['Enter'], 'Open selected item', 'Opens or edits the selected slide, talk, folder, or viewer item.', 'Navigation'],
    ['browser.close', 'Esc', ['Escape'], 'Close or go back', 'Closes the active browser surface and restores its previous focus.', 'Navigation'],
    ['browser.insert', '⌘↵', ['Mod-Enter'], 'Insert selected slides', 'Inserts the selected browser slides at the editor caret.', 'Slides'],
    ['browser.toggle-selection', 'Space / X', ['Space', 'x'], 'Toggle selection', 'Adds or removes the active slide from the insertion selection.', 'Slides'],
    ['browser.preview', 'P', ['p'], 'Toggle preview', 'Shows or hides the active slide preview.', 'Slides'],
    ['browser.talk-view', 'V', ['v'], 'Switch talk view', 'Switches the Talks panel between Ledger and Shelf.', 'Talks panel'],
    ['browser.talk-names', 'N', ['n'], 'Titles or filenames', 'Switches the Talks panel between display titles and filenames.', 'Talks panel'],
    ['browser.filter', '/', ['/'], 'Focus filter', 'Moves focus to the Talks panel search box — from the list, or from anywhere outside the talk editor and text fields while the list is open.', 'Talks panel'],
    ['browser.sort', 'S', ['s'], 'Sort talks', 'Opens Talks sorting; number keys select a sort order.', 'Talks panel'],
    ['browser.open-talk', '⌘O', ['Mod-o'], 'Open talk or folder', 'Opens the focused talk, or goes into the focused folder, as ↵ does.', 'Talks panel'],
    ['browser.up-level', '⌘↑', ['Mod-ArrowUp'], 'Up one folder level', 'Goes back up one folder and focuses the folder just left.', 'Talks panel'],
    ['browser.fold-all', '⌘← / ⌘→', ['Mod-ArrowLeft', 'Mod-ArrowRight'], 'Collapse or expand all subfolders', 'Collapses or expands every subfolder of the folder being viewed.', 'Talks panel'],
    ['browser.rename', 'F2', ['F2'], 'Rename', 'Renames the focused talk or folder.', 'Talks panel'],
    ['browser.duplicate', '⌘D', ['Mod-d'], 'Duplicate talk', 'Duplicates the focused talk.', 'Talks panel'],
    ['browser.move-talk', 'M', ['m'], 'Move talk', 'Moves the focused talk into a folder.', 'Talks panel'],
    ['browser.delete-talk', '⌘⌫', ['Mod-Backspace'], 'Move talk to Bin', 'Moves the focused talk to the Bin after confirmation.', 'Talks panel']
  ]),
  // The ⌘S slide picker (SlideBrowser.tsx, browser-rail/FindTalk.tsx). The key-truth check in
  // scripts/test-shortcut-registry.mjs holds this list to exactly the keys those handlers bind.
  ...entries('slide-picker', [
    ['slide-picker.move', '↑ ↓ ← →', ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'], 'Move through slides', 'Moves the focused card; with a talk beside the results, ← and → cross between the two sides.', 'Navigate'],
    ['slide-picker.extend', '⇧↑ ⇧↓ ⇧← ⇧→', ['Shift-ArrowUp', 'Shift-ArrowDown', 'Shift-ArrowLeft', 'Shift-ArrowRight'], 'Extend the selection', 'Moves the focused card and selects every card from the anchor to it.', 'Navigate'],
    ['slide-picker.view', '↵', ['Enter'], 'View and insert', 'Opens the focused slide in the insert viewer.', 'Navigate'],
    ['slide-picker.tab', 'Tab / ⇧Tab', ['Tab', 'Shift-Tab'], 'Move between controls', 'Moves focus through the picker’s controls; focus stays inside the picker.', 'Navigate'],
    ['slide-picker.close', 'Esc', ['Escape'], 'Close or go back', 'Closes the nearest thing first — a popover, the preview, versions, locations, the talk beside, the search words, the selection — and then the picker.', 'Navigate'],
    ['slide-picker.clear-scope', '⌫', ['Backspace'], 'Clear scope', 'Clears the rail’s scope, so the picker shows every talk again.', 'Navigate'],
    ['slide-picker.toggle-selection', 'X', ['x'], 'Select or deselect slide', 'Adds the focused slide to the selection, or takes it out.', 'Select & insert'],
    ['slide-picker.select-section', 'S', ['s'], 'Select section', 'Selects every slide in the focused slide’s section.', 'Select & insert'],
    ['slide-picker.insert', '⌘↵', ['Mod-Enter'], 'Insert selected slides', 'Inserts the selected slides at the editor caret.', 'Select & insert'],
    ['slide-picker.select-whole-section', '⇧⌘↵', ['Mod-Shift-Enter'], 'Select whole section', 'Selects the focused slide’s whole section — its heading slide and every slide under it, showing or not — as its heading’s Select section button does. Take single slides out with X or a click, then insert the selection with ⌘↵.', 'Select & insert'],
    ['slide-picker.tags', 'T', ['t'], 'Tag selected slides', 'Opens the tag picker for the selected slides.', 'Select & insert'],
    ['slide-picker.preview', 'Space / P', ['Space', 'p'], 'Preview', 'Shows or hides a large preview of the focused slide.', 'View'],
    ['slide-picker.versions', 'E', ['e'], 'Versions or locations', 'Opens the focused slide’s versions; on a stack of identical copies, where the copies live.', 'View'],
    ['slide-picker.near', 'U', ['u'], 'Uncollapse near-identical slides', 'Opens a stack of near-identical slides into its variants, or closes it again.', 'View'],
    ['slide-picker.density', '2–6', ['Digit2-Digit6'], 'Cards across', 'Sets how many cards the grid shows across.', 'View'],
    ['slide-picker.rail', 'I', ['i'], 'Show or hide the rail', 'Collapses or expands the rail with the talk and slide searches.', 'View'],
    ['slide-picker.talk-beside', 'O', ['o'], 'Show the result’s talk beside', 'Opens the focused result’s whole talk beside the results, scrolled to its section with the slide highlighted.', 'Talks'],
    ['slide-picker.close-beside', 'Esc', ['Escape'], 'Close the talk beside', 'Closes the talk beside the results; the results, their scroll position and the selection are unchanged.', 'Talks'],
    ['slide-picker.add-beside', '⌘↵', ['Mod-Enter'], 'Add the talk beside', 'In Find a talk, adds the highlighted talk as a further column (up to three) instead of replacing the scope.', 'Talks'],
    ['slide-picker.remove-chip', '⌫', ['Backspace'], 'Remove the last talk chip', 'In an empty Find a talk box, takes the last talk picked from it out of the scope.', 'Talks']
  ]),
  ...entries('picker', [
    ['picker.navigate', '↑ ↓ ← →', ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'], 'Move through choices', 'Moves the active choice in command, icon, layout, tag, and search pickers.', 'Pickers'],
    ['picker.choose', '↵', ['Enter'], 'Choose', 'Confirms the active picker item or dialog action.', 'Pickers'],
    ['picker.close', 'Esc', ['Escape'], 'Close or go back', 'Returns to the preceding picker step, or closes the active picker or modal without applying a new choice.', 'Pickers'],
    ['picker.back', '⌫', ['Backspace'], 'Previous picker step', 'Returns from an empty chained options step to its entry list.', 'Pickers'],
    ['picker.digit', '1–9', ['Digit1-Digit9'], 'Choose numbered option', 'Immediately chooses the numbered value in a chained options step.', 'Pickers'],
    ['picker.toggle', 'Space', ['Space'], 'Toggle choice', 'Toggles selection of the active item in a multi-select picker.', 'Pickers']
  ]),
  ...entries('presenter', [
    ['presenter.next', '→ Space ↓ PgDn ↵', ['ArrowRight', 'Space', 'ArrowDown', 'PageDown', 'Enter', 'MediaTrackNext'], 'Next', 'Advances through the current mode and then to the next presentation beat.', 'Navigation'],
    ['presenter.previous', '← ↑ PgUp Backspace', ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'MediaTrackPrevious'], 'Previous', 'Retreats through the current mode and then to the previous presentation beat.', 'Navigation'],
    ['presenter.first', 'Home', ['Home'], 'First slide', 'Moves to the first slide in the deck.', 'Navigation'],
    ['presenter.last', 'End', ['End'], 'Last slide', 'Moves to the last slide in the deck.', 'Navigation'],
    ['presenter.grid-child', '1–9', ['Digit1-Digit9'], 'Jump to grid child', 'Jumps directly to a numbered card on a grid slide.', 'Navigation'],
    ['presenter.skip', 'S', ['s'], 'Skip next slide', 'Marks the next slide skipped and advances beyond it.', 'Navigation'],
    ['presenter.return', 'B', ['b'], 'Return from jump', 'Returns to the slide from which an overview jump began.', 'Navigation'],
    ['presenter.overview', 'O', ['o'], 'Outline', 'Opens the searchable presenter outline.', 'Overview & timer'],
    ['presenter.timer', 'P', ['p'], 'Start or pause timer', 'Starts, pauses, or resumes the presentation timer.', 'Overview & timer'],
    ['presenter.duration', 'T', ['t'], 'Set duration', 'Opens the talk-duration and reminder controls.', 'Overview & timer'],
    // Recording (src/preload/present-rec-ui.ts; present in the presenter window TalkWeaver opens).
    ['presenter.record', '⇧R', ['Shift-r'], 'Start, or stop and save, recording', 'Starts recording the talk; while recording or paused, stops and saves it.', 'Recording'],
    ['presenter.record-pause', '⇧P', ['Shift-p'], 'Pause or resume recording', 'Pauses the recording, or resumes a paused one.', 'Recording'],
    ['presenter.save-run-as', 'L', ['l'], 'Save run as…', 'Opens the run-kind picker (Delivery, Rehearsal, Recording) to save or relabel this run in History.', 'Recording'],
    ['presenter.save-run', '↵', ['Enter'], 'Save this run as a delivery', 'While the save offer shows at the last slide, saves the run to History as a delivery.', 'Recording'],
    ['presenter.reveal', 'R', ['r'], 'Reveal mode', 'Toggles progressive content reveal mode.', 'Modes & display'],
    ['presenter.focus', 'F', ['f'], 'Focus mode', 'Toggles focus mode for stepping through slide elements.', 'Modes & display'],
    ['presenter.highlight', 'H', ['h'], 'Highlight', 'Arms or disarms text highlight authoring in the presenter preview.', 'Modes & display'],
    ['presenter.preview-size', '[ / ]', ['BracketLeft', 'BracketRight'], 'Resize previews', 'Cycles the size of presenter preview panes.', 'Modes & display'],
    ['presenter.notes-scroll', 'J / ⇧J', ['j', 'Shift-j'], 'Scroll notes forward or back', 'Steps the speaker notes: a paragraph in the camera column, the visible lines less one elsewhere. Also works while automatic scroll runs.', 'Modes & display'],
    ['presenter.media', 'M', ['m'], 'Play audience media', 'Plays or pauses media on the audience display.', 'Modes & display'],
    ['presenter.gallery', 'Z', ['z'], 'Gallery or lightbox', 'Opens or closes the current slide image and video gallery.', 'Modes & display'],
    ['presenter.video-fullscreen', 'V', ['v'], 'Video: Fullscreen', 'Enlarges the current slide video to the stage and asks for full screen (on the audience display when presenting).', 'Modes & display'],
    ['presenter.embed', 'E', ['e'], 'Interact with embed', 'Enters or exits interaction with the current embedded page.', 'Modes & display'],
    ['presenter.font-larger', '+', ['+'], 'Increase text size', 'Increases the shared deck font size.', 'Modes & display'],
    ['presenter.font-smaller', '−', ['-'], 'Decrease text size', 'Decreases the shared deck font size.', 'Modes & display'],
    ['presenter.audience', 'F5', ['F5'], 'Launch audience', 'Opens the chromeless audience window on another display.', 'Audience'],
    ['presenter.live', 'G', ['g'], 'Go or end live', 'Starts or ends the live audience-follow session.', 'Audience'],
    ['presenter.poll-primary', 'Q', ['q'], 'Open or close current poll', 'Opens an armed poll or closes the poll currently collecting responses.', 'Audience'],
    ['presenter.poll-reveal', '⇧ Q', ['Shift-q'], 'Reveal held poll results', 'Reveals a held poll’s current results to the audience.', 'Audience'],
    ['presenter.poll-compose', 'K', ['k'], 'Compose a Quick poll', 'Opens the live Quick-poll composer.', 'Audience'],
    ['presenter.instant-compose', '⌥⌘I', ['Mod-Alt-i'], 'Compose an instant slide', 'Opens the instant-slide composer.', 'Audience'],
    ['presenter.instant-paste', '⌘V', ['Mod-v'], 'Preview clipboard as an instant slide', 'Shows a preview of the clipboard content.', 'Audience'],
    ['presenter.instant-return', '→', ['ArrowRight'], 'Back to slide while instant slide is shown', 'Clears the instant slide and returns to the slide left.', 'Audience'],
    ['presenter.talk-qr', 'U', ['u'], "Show the talk's QR code", 'Shows the live audience link, or the published handout link, as a full-screen QR code from any slide; U or Esc returns to the slide.', 'Audience'],
    // Editor (src/preload/present-edit-bridge.ts for ⌘E; src/main/deck-window-keys.ts for ⌘R and ⇧F5).
    ['presenter.edit', '⌘E', ['Mod-e'], 'Edit this slide in TalkWeaver', 'Returns from a deck window to this slide in the TalkWeaver editor.', 'Editor'],
    ['presenter.refresh', '⌘R / ⇧F5', ['Mod-r', 'Shift-F5'], 'Refresh with latest edits', 'Refreshes a deck window with the latest edits while retaining position.', 'Editor'],
    ['presenter.command-palette', '⌘⇧P', ['Mod-Shift-p'], 'Command palette', 'Opens the list of every presenter command, with its key.', 'Help'],
    ['presenter.help', '?', ['?'], 'Show shortcuts', 'Shows or hides this generated shortcut sheet.', 'Help'],
    ['presenter.close', 'Esc', ['Escape'], 'Close overlay or mode', 'Closes the most local overlay, interaction, or active presentation mode.', 'Help']
  ]),
  ...entries('pathway', [
    ['pathway.move', '↑ ↓ ← →', ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'], 'Move focus', 'Moves focus through pathway rows, slide cards, or Matrix cells.', 'Navigation'],
    ['pathway.toggle', 'Space', ['Space'], 'Toggle slide membership', 'Ticks or unticks the focused slide in the selected pathway.', 'Slides'],
    ['pathway.grid', 'G', ['g'], 'Grid view', 'Shows all outline slides as rendered thumbnail cards.', 'View'],
    ['pathway.list', 'L', ['l'], 'List view', 'Shows the pathway as a numbered running order with slide previews', 'View'],
    ['pathway.matrix', 'M', ['m'], 'Matrix view', 'Shows outline rows against every pathway column.', 'View'],
    ['pathway.previews', 'P', ['p'], 'Toggle previews', 'Show or hide slide previews in List and Matrix.', 'View'],
    ['pathway.reorder', '⌥R', ['Alt-r'], 'Reorder mode', 'Shows pathway order badges and enables pathway-only reordering.', 'Reorder'],
    ['pathway.move-item', '⌘↑ / ⌘↓', ['Mod-ArrowUp', 'Mod-ArrowDown'], 'Move pathway slide', 'Moves the focused ticked slide within pathway order without changing the outline.', 'Reorder'],
    ['pathway.present', '↵', ['Enter'], 'Present this pathway', 'Presents only present slide ids, in pathway order, skipping missing ids.', 'Present'],
    ['pathway.new', '⌘N', ['Mod-n'], 'New pathway', 'Creates and selects a new empty pathway.', 'Manage'],
    ['pathway.rename', '⌘R', ['Mod-r'], 'Rename pathway', 'Renames the selected pathway without changing its slides.', 'Manage'],
    ['pathway.delete', '⌘⌫', ['Mod-Backspace'], 'Delete pathway', 'Deletes the selected pathway after confirmation.', 'Manage'],
    ['pathway.drop-missing', '⌘⇧⌫', ['Mod-Shift-Backspace'], 'Drop missing slides', 'Removes every missing slide id from the selected pathway.', 'Manage'],
    ['pathway.help', '?', ['?'], 'Keyboard cheat-sheet', 'Opens the Pathway window’s keyboard shortcut sheet.', 'Help']
  ]),
  ...entries('studio', [
    ['studio.sidebar-toggle', '⌘\\', ['Mod-\\'], 'Collapse or expand recordings', 'Toggles the recordings sidebar so the player can use the full width.', 'View']
  ]),
  ...entries('talktext', [
    ['talktext.notes', 'N', ['n'], 'Notes mode', 'Shows the agent-written Notes document and its part review controls.', 'View'],
    ['talktext.script', 'S', ['s'], 'Script mode', 'Shows the slide-aligned transcript.', 'View'],
    ['talktext.rewrite', 'R', ['r'], 'Open rewrite', 'Opens the agent rewrite handoff for the current recording.', 'Notes'],
    ['talktext.show-slide', '1–9', ['Digit1-Digit9'], 'Show slide', 'Shows a numbered slide in the Notes preview.', 'Slides'],
    ['talktext.previous-slide', '[', ['BracketLeft'], 'Previous slide', 'Shows the previous slide in the Notes preview.', 'Slides'],
    ['talktext.next-slide', ']', ['BracketRight'], 'Next slide', 'Shows the next slide in the Notes preview.', 'Slides'],
    ['talktext.copy', 'C', ['c'], 'Copy', 'Copies the current Notes or Script export using the selected options.', 'Export'],
    ['talktext.help', '?', ['?'], 'Keyboard cheat-sheet', 'Opens the Manage notes keyboard shortcut sheet.', 'Help'],
    ['talktext.close', 'Esc', ['Escape'], 'Close overlay or screen', 'Closes the most local overlay, then Manage notes.', 'Help']
  ]),
  ...entries('importer', [
    ['importer.move', 'J / K', ['j', 'k'], 'Previous or next slide', 'Moves through the visible slide queue in the Inspection Bench.', 'Navigation'],
    ['importer.flagged', 'F', ['f'], 'Toggle flagged slides', 'Switches between all slides and slides needing review.', 'Navigation'],
    ['importer.search', '⌘F', ['Mod-f'], 'Search imported slides', 'Moves focus to the imported-slide search field.', 'Navigation'],
    ['importer.apply', '⌘↵', ['Mod-Enter'], 'Apply slide changes', 'Writes the current inspected slide override and regenerates the Outline.', 'Editing'],
    ['importer.reset', '⌥R', ['Alt-r'], 'Reset slide', 'Removes manual overrides from the current slide and restores the deterministic decision.', 'Editing'],
    ['importer.views', '⌘1 / ⌘2 / ⌘3', ['Mod-1', 'Mod-2', 'Mod-3'], 'Switch Tools view', 'Moves between Studio, History and Importer without opening another window.', 'View'],
    ['importer.help', '?', ['?'], 'Keyboard cheat-sheet', 'Opens the Importer lifecycle and shortcut sheet.', 'Help'],
    ['importer.close', 'Esc', ['Escape'], 'Close overlay or Importer', 'Closes the help sheet first, then the Importer window.', 'Help']
  ])
]

export function shortcutsForScope(scope: ShortcutScope): ShortcutEntry[] {
  return SHORTCUT_REGISTRY.filter((entry) => entry.scope === scope)
}

export function shortcutById(id: string): ShortcutEntry {
  const entry = SHORTCUT_REGISTRY.find((candidate) => candidate.id === id)
  if (!entry) throw new Error(`Unknown shortcut registry id: ${id}`)
  return entry
}

function normalisedEventKey(event: KeyboardEvent): string {
  const key = event.key
  if (key === ' ') return 'Space'
  return key.length === 1 ? key.toLowerCase() : key
}

function eventMatchesCode(event: KeyboardEvent, code: string): boolean {
  const parts = code.split('-')
  const base = parts.at(-1) ?? ''
  const modifiers = new Set(parts.slice(0, -1))
  const mod = modifiers.has('Mod')
  const ctrl = modifiers.has('Ctrl')
  const shift = modifiers.has('Shift')
  const alt = modifiers.has('Alt')
  if (mod ? !(event.metaKey || event.ctrlKey) : event.metaKey) return false
  if (!mod && event.ctrlKey !== ctrl) return false
  if (mod && ctrl && !event.ctrlKey) return false
  if (event.shiftKey !== shift || event.altKey !== alt) return false
  return normalisedEventKey(event) === (base.length === 1 ? base.toLowerCase() : base)
}

/**
 * Match a DOM-owned control against the registry's CodeMirror-style binding. An explicit override
 * replaces the defaults, which lets widgets honour the same live keymap as the editor.
 */
export function shortcutEventMatches(
  event: KeyboardEvent,
  shortcutId: string,
  override?: string
): boolean {
  const codes = override ? [override] : shortcutById(shortcutId).codes
  return codes.some((code) => eventMatchesCode(event, code))
}
