// The "Check for Updates…" placement in the macOS app menu, kept free of Electron so a plain-Node
// test can run it: the caller hands the template to Menu.buildFromTemplate.
import { toAccelerator, buildMenuTemplate } from '@app-patterns/commands'
import type { MenuItemConstructorOptions } from 'electron'
import { MENUS, UPDATE_CHECK_ID, registry } from '../shared/bridle-commands.ts'

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
 * Returns null (menu left as built) off macOS or when the command is missing; never throws for that.
 */
export function updateCheckMenuTemplate(input: UpdateMenuInput): MenuItemConstructorOptions[] | null {
  if (input.platform !== 'darwin') return null
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
  const template = buildMenuTemplate({
    appName: 'TalkWeaver',
    registry: { ...registry, defs: registry.defs.map((d) => d.id === id ? { ...d, noMenu: true } : d) },
    menus: MENUS, bindings, run: input.run, ctx: undefined,
    appItems: { app: [check] }
  }) as MenuItemConstructorOptions[]
  const items = template[0]?.submenu
  if (!Array.isArray(items)) return null
  const index = items.findIndex((item) => (item as { id?: string }).id === id)
  if (index < 0) return null
  const [item] = items.splice(index, 1)
  if (item) items.splice(1, 0, item)
  return template
}
