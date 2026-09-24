/** Shared dispatch for the seven editor actions exposed by the bar and palette. */
export type ActionBarEditorCommands = {
  undo: () => void
  redo: () => void
  newSlide: () => void
  promoteHeading: () => void
  demoteHeading: () => void
  bulletedList: () => void
  numberedList: () => void
}
export type ActionBarEditorCommandId = 'undo' | 'redo' | 'new-slide' | 'promote-heading' | 'demote-heading' | 'bulleted-list' | 'numbered-list'

export function runActionBarEditorCommand(commands: ActionBarEditorCommands | null, id: ActionBarEditorCommandId): void {
  if (!commands) return
  const methods: Record<ActionBarEditorCommandId, keyof ActionBarEditorCommands> = {
    undo: 'undo', redo: 'redo', 'new-slide': 'newSlide',
    'promote-heading': 'promoteHeading', 'demote-heading': 'demoteHeading',
    'bulleted-list': 'bulletedList', 'numbered-list': 'numberedList'
  }
  commands[methods[id]]()
}
