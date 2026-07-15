export const SHORTCUT_SCOPES = ['app', 'editor', 'browser', 'presenter', 'picker', 'pathway'] as const
export type ShortcutScope = (typeof SHORTCUT_SCOPES)[number]

export interface ShortcutEntry {
  id: string
  keys: string
  codes: string[]
  scope: ShortcutScope
  label: string
  explanation: string
  group: string
}

const entries = (scope: ShortcutScope, rows: Array<[string, string, string[], string, string, string]>): ShortcutEntry[] =>
  rows.map(([id, keys, codes, label, explanation, group]) => ({ id, keys, codes, scope, label, explanation, group }))

export const SHORTCUT_REGISTRY: ShortcutEntry[] = [
  ...entries('app', [
    ['app.sidebar-talks', '⌘⇧T', ['Mod-Shift-t'], 'Open Talks panel search', 'Opens the Talks sidebar and moves focus to its search field.', 'Sidebar'],
    ['app.sidebar-outline', '⌘⇧O', ['Mod-Shift-o'], 'Open Slide outline search', 'Opens the slide outline sidebar and moves focus to its search field.', 'Sidebar'],
    ['app.sidebar-toggle', '⌘⇧[ / ⌘\\', ['Mod-Shift-[', 'Mod-\\'], 'Collapse or expand sidebar', 'Toggles the current sidebar without changing its selected mode.', 'Sidebar'],
    ['app.settings', '⌘,', ['Mod-,'], 'Settings', 'Opens or closes the application settings panel.', 'App'],
    ['app.slide-search', '⌘S', ['Mod-s'], 'Search slides across all talks', 'Opens the cross-talk slide browser for finding and inserting slides.', 'Find & insert'],
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
    ['app.help', '⌃/', ['Ctrl-/'], 'Keyboard shortcuts', 'Opens or closes the generated keyboard shortcut sheet.', 'App'],
    ['app.view-editor', '⌘1', ['Mod-1'], 'Editor only', 'Switches the workspace to the editor-only view.', 'View'],
    ['app.view-split', '⌘2', ['Mod-2'], 'Editor and slides', 'Switches the workspace to the split editor and slide view.', 'View'],
    ['app.view-strip', '⌘3', ['Mod-3'], 'Slide strip', 'Switches the workspace to the slide strip view.', 'View'],
    ['app.view-grid', '⌘4', ['Mod-4'], 'Grid', 'Switches the workspace to the slide grid view.', 'View'],
    ['app.present', 'F5', ['F5'], 'Present from the top', 'Opens presenter view at the first slide.', 'Present'],
    ['app.present-current', '⇧F5', ['Shift-F5'], 'Present from current slide', 'Opens presenter view at the selected slide.', 'Present'],
    ['app.deck-edit', '⌘E', ['Mod-e'], 'Edit presented slide', 'Returns from a deck window to this slide in TalkWeaver.', 'Present'],
    ['app.deck-refresh', '⌘R', ['Mod-r'], 'Refresh deck', 'Refreshes a deck window with the latest edits while retaining position.', 'Present'],
    ['app.pathways', '⌘⌥P', ['Mod-Alt-p'], 'Open Pathway view', 'Opens the current Talk’s Pathway manager in its own window.', 'Present']
  ]),
  ...entries('editor', [
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
    ['editor.list-continue', '↵', ['Enter'], 'Continue list', 'Continues a list or exits it when the current item is empty.', 'Lists'],
    ['editor.list-indent', 'Tab', ['Tab'], 'Indent list item', 'Indents the current list item when the editor context permits it.', 'Lists'],
    ['editor.list-outdent', '⇧Tab', ['Shift-Tab'], 'Outdent list item', 'Outdents the current list item when the editor context permits it.', 'Lists'],
    ['editor.bold', '⌘B', ['Mod-b'], 'Bold selection', 'Wraps or unwraps the current selection in Markdown bold markers.', 'Format'],
    ['editor.rollback-trigger', 'Esc', ['Escape'], 'Cancel trigger completion', 'Restores the exact text that preceded a provisional trigger completion.', 'Editing'],
    ['editor.protect-heading-delete', '⌘⌫ / ⌫', ['Mod-Backspace', 'Backspace'], 'Protect slide identity', 'Prevents partial deletion from corrupting a slide heading and trigger identity.', 'Editing']
  ]),
  ...entries('browser', [
    ['browser.move', '↑ ↓ ← →', ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'], 'Move selection', 'Moves keyboard focus through slide cards, strip items, or talk rows.', 'Navigation'],
    ['browser.open', '↵', ['Enter'], 'Open selected item', 'Opens or edits the selected slide, talk, folder, or viewer item.', 'Navigation'],
    ['browser.close', 'Esc', ['Escape'], 'Close or go back', 'Closes the active browser surface and restores its previous focus.', 'Navigation'],
    ['browser.insert', '⌘↵', ['Mod-Enter'], 'Insert selected slides', 'Inserts the selected browser slides at the editor caret.', 'Slides'],
    ['browser.toggle-selection', 'Space / X', ['Space', 'x'], 'Toggle selection', 'Adds or removes the active slide from the insertion selection.', 'Slides'],
    ['browser.tags', 'T', ['t'], 'Tag selected slides', 'Opens the tag picker for the selected browser slides.', 'Slides'],
    ['browser.preview', 'P', ['p'], 'Toggle preview', 'Shows or hides the active slide preview.', 'Slides'],
    ['browser.rail', 'I', ['i'], 'Toggle rail', 'Collapses or expands the browser filter rail.', 'Slides'],
    ['browser.edit-source', 'E', ['e'], 'Edit source slide', 'Opens the source slide of the active browser result.', 'Slides'],
    ['browser.where-used', 'U', ['u'], 'Where used', 'Shows usage information for the active browser slide.', 'Slides'],
    ['browser.clear-scope', '⌫', ['Backspace'], 'Clear scope', 'Clears the current browser rail scope.', 'Slides'],
    ['browser.talk-view', 'V', ['v'], 'Switch talk view', 'Switches the Talks panel between Ledger and Shelf.', 'Talks panel'],
    ['browser.talk-names', 'N', ['n'], 'Titles or filenames', 'Switches the Talks panel between display titles and filenames.', 'Talks panel'],
    ['browser.filter', '/', ['/'], 'Focus filter', 'Moves focus to the Talks panel filter field.', 'Talks panel'],
    ['browser.sort', 'S', ['s'], 'Sort talks', 'Opens Talks sorting; number keys select a sort order.', 'Talks panel'],
    ['browser.rename', 'F2', ['F2'], 'Rename', 'Renames the focused talk or folder.', 'Talks panel'],
    ['browser.duplicate', '⌘D', ['Mod-d'], 'Duplicate talk', 'Duplicates the focused talk.', 'Talks panel'],
    ['browser.move-talk', 'M', ['m'], 'Move talk', 'Moves the focused talk into a folder.', 'Talks panel'],
    ['browser.delete-talk', '⌘⌫', ['Mod-Backspace'], 'Move talk to Bin', 'Moves the focused talk to the Bin after confirmation.', 'Talks panel']
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
    ['presenter.next', '→ Space ↓ PgDn', ['ArrowRight', 'Space', 'ArrowDown', 'PageDown', 'MediaTrackNext'], 'Next', 'Advances through the current mode and then to the next presentation beat.', 'Navigation'],
    ['presenter.previous', '← ↑ PgUp Backspace', ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'MediaTrackPrevious'], 'Previous', 'Retreats through the current mode and then to the previous presentation beat.', 'Navigation'],
    ['presenter.first', 'Home', ['Home'], 'First slide', 'Moves to the first slide in the deck.', 'Navigation'],
    ['presenter.last', 'End', ['End'], 'Last slide', 'Moves to the last slide in the deck.', 'Navigation'],
    ['presenter.grid-child', '1–9', ['Digit1-Digit9'], 'Jump to grid child', 'Jumps directly to a numbered card on a grid slide.', 'Navigation'],
    ['presenter.skip', 'S', ['s'], 'Skip next slide', 'Marks the next slide skipped and advances beyond it.', 'Navigation'],
    ['presenter.return', 'B', ['b'], 'Return from jump', 'Returns to the slide from which an overview jump began.', 'Navigation'],
    ['presenter.overview', 'O', ['o'], 'Outline', 'Opens the searchable presenter outline.', 'Overview & timer'],
    ['presenter.timer', 'P', ['p'], 'Start or pause timer', 'Starts, pauses, or resumes the presentation timer.', 'Overview & timer'],
    ['presenter.duration', 'T', ['t'], 'Set duration', 'Opens the talk-duration and reminder controls.', 'Overview & timer'],
    ['presenter.reveal', 'R', ['r'], 'Reveal mode', 'Toggles progressive content reveal mode.', 'Modes & display'],
    ['presenter.focus', 'F', ['f'], 'Focus mode', 'Toggles focus mode for stepping through slide elements.', 'Modes & display'],
    ['presenter.highlight', 'H', ['h'], 'Highlight', 'Arms or disarms text highlight authoring in the presenter preview.', 'Modes & display'],
    ['presenter.preview-size', '[ / ]', ['BracketLeft', 'BracketRight'], 'Resize previews', 'Cycles the size of presenter preview panes.', 'Modes & display'],
    ['presenter.notes', 'N', ['n'], 'Notes', 'Opens or closes the notes drawer where that role provides it.', 'Modes & display'],
    ['presenter.chrome', 'C', ['c'], 'Pin control bar', 'Pins or unpins the deck control bar.', 'Modes & display'],
    ['presenter.media', 'M', ['m'], 'Play audience media', 'Plays or pauses media on the audience display.', 'Modes & display'],
    ['presenter.gallery', 'Z', ['z'], 'Gallery or lightbox', 'Opens or closes the current slide image gallery.', 'Modes & display'],
    ['presenter.embed', 'E', ['e'], 'Interact with embed', 'Enters or exits interaction with the current embedded page.', 'Modes & display'],
    ['presenter.font-larger', '+', ['+'], 'Increase text size', 'Increases the shared deck font size.', 'Modes & display'],
    ['presenter.font-smaller', '−', ['-'], 'Decrease text size', 'Decreases the shared deck font size.', 'Modes & display'],
    ['presenter.audience', 'F5', ['F5'], 'Launch audience', 'Opens the chromeless audience window on another display.', 'Audience'],
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
