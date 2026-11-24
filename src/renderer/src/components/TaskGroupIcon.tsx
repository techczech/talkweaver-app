import { ListTree, Type, LayoutTemplate, Copy, PanelsTopLeft, Route, Presentation, Share2, FolderOpen, Wrench, Settings, type LucideIcon } from 'lucide-react'
import { TASK_GROUP_ICONS, type TaskGroup } from '../../../shared/task-groups'

const ICONS: Record<(typeof TASK_GROUP_ICONS)[TaskGroup], LucideIcon> = {
  ListTree, Type, LayoutTemplate, Copy, PanelsTopLeft, Route, Presentation, Share2, FolderOpen, Wrench, Settings
}

export function TaskGroupIcon({ group }: { group: TaskGroup }): JSX.Element {
  const Icon = ICONS[TASK_GROUP_ICONS[group]]
  return <Icon size={16} aria-hidden="true" data-group-icon={TASK_GROUP_ICONS[group]} />
}
