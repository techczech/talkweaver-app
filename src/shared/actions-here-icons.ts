// The lucide icon each Actions here row carries (onboarding 0.38.1, owner check 10 Oct: "no icons").
// Names are lucide-react export names; ActionsHerePanel.tsx holds the one record that turns a name
// into a component (typed by ActionIconName, so a name added here without a component fails the
// typecheck). A row with no entry takes its task group's icon. scripts/test-actions-here.mjs checks
// that every row at every place resolves to a name lucide-react exports.
import type { TaskGroup } from './task-groups.ts'

export const ROW_ICONS = {
  'promote-heading': 'IndentDecrease', 'demote-heading': 'IndentIncrease',
  'editor.promote-subtree': 'ChevronsLeft', 'editor.demote-subtree': 'ChevronsRight',
  'editor.move-up': 'ArrowUp', 'editor.move-down': 'ArrowDown',
  'delete-slide': 'Trash2', 'move-slide-to': 'ArrowUpDown', 'move-section-to': 'ArrowUpDown',
  'slide-cut': 'Scissors', 'slide-copy': 'Copy', 'slide-paste-after': 'ClipboardPaste',
  'outline-collapse-all': 'ChevronsDownUp', 'outline-expand-all': 'ChevronsUpDown',
  'editor.heading-same': 'Heading', 'editor.heading-sub': 'Heading2',
  'format-bold': 'Bold', 'format-italic': 'Italic', 'format-inline-code': 'Code', 'format-highlight': 'Highlighter',
  'format-strikethrough': 'Strikethrough', 'format-underline': 'Underline', 'format-link': 'Link',
  'new-slide': 'FilePlus', 'bulleted-list': 'List', 'numbered-list': 'ListOrdered',
  layout: 'LayoutTemplate', image: 'Image', 'icon-picker': 'Sparkles', 'toggle-inspector': 'PanelRight',
  'insert-object-table': 'Table', 'insert-object-mindmap': 'Network', 'insert-object-chart': 'ChartColumn',
  'insert-object-mermaid': 'Workflow', 'insert-object-diagram': 'Shapes', 'insert-object-svg': 'PenTool',
  'insert-board-slide': 'LayoutDashboard', 'insert-component-code': 'CodeXml', 'insert-component-qr': 'QrCode',
  'insert-component-action': 'MousePointerClick', 'insert-component-embed': 'AppWindow',
  'insert-component-auto-embed': 'Globe', 'insert-component-countdown': 'Timer',
  'where-used': 'Layers', 'tag-slide': 'Tag', search: 'Search',
  'focus-slide': 'Focus', 'explain-rendering': 'CircleHelp', 'present-from-here': 'Presentation',
  metadata: 'FileText', 'talk.metadata': 'FileText', abstract: 'AlignLeft', 'deck-design': 'Palette',
  'layout-doctor': 'Stethoscope', 'normalize-triggers': 'Wrench',
  'browser.open-talk': 'FolderOpen', 'open-in-new-window': 'SquareArrowOutUpRight', 'browser.rename': 'Pencil',
  'browser.move-talk': 'FolderInput', 'browser.duplicate': 'Copy', 'browser.delete-talk': 'Trash2',
  'talk.reveal': 'FolderSearch', 'talk.open-file': 'FileText', 'talk.copy-path': 'ClipboardCopy',
  'new-talk': 'FilePlus2', 'new-folder': 'FolderPlus', 'refresh-talks': 'RefreshCw', 'change-vault': 'HardDrive',
  'browser.fold-all': 'ChevronsUpDown', 'browser.sort': 'ArrowUpDown', 'browser.filter': 'ListFilter',
  'browser.talk-view': 'LayoutList', 'browser.talk-names': 'Type',
  'folder.rename': 'Pencil', 'folder.delete': 'FolderMinus',
  'vault.edit': 'Settings2', 'vault.only': 'Eye', 'vault.reveal': 'FolderSearch', 'vault.close': 'CircleX', 'vault.open': 'FolderOpen'
} as const satisfies Record<string, string>

/** A row with no entry above takes its task group's icon. */
export const GROUP_ICONS = {
  'Write the outline': 'AlignLeft', 'Build a slide': 'LayoutTemplate', 'Reuse slides': 'Layers', 'See the talk': 'Focus',
  'Shape the talk': 'FileText', Present: 'Presentation', Share: 'Share2', 'Manage talks': 'FolderOpen',
  'Check and repair': 'Wrench', 'Set up TalkWeaver': 'Settings2'
} as const satisfies Record<TaskGroup, string>

export type ActionIconName = (typeof ROW_ICONS)[keyof typeof ROW_ICONS] | (typeof GROUP_ICONS)[TaskGroup]

export function actionIconName(rowKey: string, taskGroup: TaskGroup): ActionIconName {
  return (ROW_ICONS as Record<string, ActionIconName>)[rowKey] ?? GROUP_ICONS[taskGroup]
}
