// The "Check for Updates…" placement in the macOS app menu, kept free of Electron so a plain-Node
// test can run it: the caller hands the template to Menu.buildFromTemplate.
import { toAccelerator } from '@app-patterns/commands'
import type { MenuItemConstructorOptions } from 'electron'
import { UPDATE_CHECK_ID, registry } from '../shared/bridle-commands.ts'
import { withProductRoleLabels } from './app-menu.ts'
import { taskMenuTemplate } from './task-menu-template.ts'

export interface UpdateMenuInput {
  platform: string
  /** The store's `keys` setting (store.view().keys). */
  keys: Parameters<typeof registry.bindingsOf>[0]
  run: (commandId: string) => void
  /** Called with a plain sentence when the item cannot be placed. */
  log: (line: string) => void
}

let warned = false

/**
 * Build the menu template from the shared registry and move the update item next to the app name.
 * Off macOS builds the same task menus, with Check for Updates in Help. Returns null only if its registry command is missing.
 */
export function updateCheckMenuTemplate(input: UpdateMenuInput): MenuItemConstructorOptions[] | null {
  if (input.platform !== 'darwin') return taskMenuTemplate({ bindings: registry.bindingsOf(input.keys), run: input.run }) as MenuItemConstructorOptions[]
  const id = UPDATE_CHECK_ID
  const def = registry.byId(id)
  if (!def) {
    if (!warned) { warned = true; input.log(`[settings] the app menu has no "${id}" command; Check for Updates stays where the menu builder put it`) }
    return null
  }
  const bindings = registry.bindingsOf(input.keys)
  const check = {
    id, label: def.label,
    accelerator: toAccelerator(bindings[id] ?? '') ?? undefined,
    registerAccelerator: false, click: () => input.run(id)
  }
  const template = taskMenuTemplate({
    bindings, run: input.run, omit: [id], appItems: { app: [check] }
  }) as MenuItemConstructorOptions[]
  const items = template[0]?.submenu
  if (!Array.isArray(items)) return null
  const index = items.findIndex((item) => (item as { id?: string }).id === id)
  if (index < 0) return null
  const [item] = items.splice(index, 1)
  if (item) items.splice(1, 0, item)
  // The App Patterns template labels about, hide and quit with app.name ("talk-weaver"); give them the product name.
  const app = template[0]
  if (app) app.submenu = withProductRoleLabels(items)
  return template
}
