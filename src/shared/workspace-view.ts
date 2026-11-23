// ADR-0045 §3: four ways to work on the same outline.
export const WORKSPACE_VIEWS = ['slide', 'grid', 'outline', 'markdown'] as const
export type WorkspaceView = typeof WORKSPACE_VIEWS[number]
export type SlideTabView = 'pages' | 'list'
export type SlidesPanelView = 'previews' | 'outline'
export type StartingView = Exclude<WorkspaceView, 'grid'>

export const WELCOME_COMMANDS = {
  slide: 'welcome-slide',
  outline: 'welcome-outline',
  markdown: 'welcome-markdown'
} as const

export const VIEW_COMMANDS = {
  slide: 'view-slides',
  grid: 'view-grid',
  outline: 'view-plain',
  markdown: 'view-markdown'
} as const

export const WORKSPACE_VIEW_LABELS = { slide: 'Slide', grid: 'Grid', outline: 'Outline', markdown: 'Markdown' }
