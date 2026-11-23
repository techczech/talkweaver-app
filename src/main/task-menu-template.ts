// Task/subgroup structure around the shared menu frame. Commands, exclusions, chords and runners
// still come from the existing registries; no Electron runtime is needed to test this projection.
import { buildMenuTemplate, FRAME_COMMAND_IDS, toAccelerator, type Bindings, type MenuItem } from '@app-patterns/commands'
import { MENUS, appCommandIdOf, registry } from '../shared/bridle-commands.ts'
import { COMMAND_REGISTRY } from '../shared/command-registry.ts'

export function taskMenuTemplate(input: {
  bindings: Bindings
  run: (id: string) => void
  appItems?: { app?: MenuItem[]; help?: MenuItem[] }
  omit?: readonly string[]
}): MenuItem[] {
  const frame = new Set<string>(FRAME_COMMAND_IDS)
  // Let App Patterns own native roles and standard commands; add only the app's task menus below.
  const template = buildMenuTemplate({
    appName: 'TalkWeaver', registry: { ...registry, defs: registry.defs.map(d => ({ ...d, noMenu: true as const })) },
    menus: [], bindings: input.bindings, run: input.run, ctx: undefined, appItems: input.appItems
  })
  const sources = new Map(COMMAND_REGISTRY.map(command => [command.id, command]))
  for (const placement of MENUS) {
    const groups: MenuItem[] = []
    for (const group of placement.groups) {
      const subgroups = new Map<string, MenuItem[]>()
      for (const def of registry.defs) {
        if (def.group !== group || def.noMenu || frame.has(def.id) || input.omit?.includes(def.id)) continue
        const source = sources.get(appCommandIdOf(def.id))
        if (!source?.subgroup) continue // coverage test names any command with missing metadata
        const accelerator = toAccelerator(input.bindings[def.id] ?? '') ?? undefined
        const rows = subgroups.get(source.subgroup) ?? []
        rows.push({
          // Electron accepts id, but App Patterns' structural menu type omits it.
          ...{ id: def.id }, label: def.label, accelerator, registerAccelerator: false,
          click: () => input.run(def.id)
        })
        subgroups.set(source.subgroup, rows)
      }
      if (subgroups.size) {
        const sections = [...subgroups].map(([label, submenu]) => ({ label, submenu }))
        // Present already names the task at menu-bar level; avoid a Present > Present detour.
        if (placement.label === group) groups.push(...sections)
        else groups.push({ label: group, submenu: sections })
      }
    }
    if (!groups.length) continue
    const menu = template.find(item => item.label === placement.label)
    if (menu) {
      const lead = menu.submenu ?? []
      // Keep the system full-screen item after the app's View tasks.
      menu.submenu = placement.label === 'View' ? [...groups, ...(lead.length ? [{ type: 'separator' as const }, ...lead] : [])] : [...lead, ...(lead.length ? [{ type: 'separator' as const }] : []), ...groups]
    } else {
      const viewIndex = template.findIndex(item => item.label === 'View')
      template.splice(viewIndex < 0 ? template.length : viewIndex, 0, { label: placement.label, submenu: groups })
    }
  }
  return template
}
