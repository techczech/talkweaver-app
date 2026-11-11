// The two menus the update notices add to the application menu (ADR-0041): the macOS TalkWeaver menu
// with Check for Updates… under About (the standard place), and the Help menu. Both are built from the
// registry's Help items (command-registry.ts: menu path `Help`), so the words and chords are the
// registry's. No Electron import: a plain list of menu items in, a plain list out.
import type { MenuItemConstructorOptions } from 'electron'

export const CHECK_FOR_UPDATES_LABEL = 'Check for Updates…'
const isCheck = (item: MenuItemConstructorOptions): boolean => item.label === CHECK_FOR_UPDATES_LABEL

/** The name the app menu shows. Not app.name: that is the package name ("talk-weaver") and moves userData and the Keychain entry. */
export const PRODUCT_NAME = 'TalkWeaver'
const PRODUCT_ROLE_LABELS: Record<string, string> = {
  about: `About ${PRODUCT_NAME}`,
  hide: `Hide ${PRODUCT_NAME}`,
  quit: `Quit ${PRODUCT_NAME}`,
}

/**
 * Electron's about, hide and quit role items take their labels from app.name. Give them the product name instead.
 * Items without one of those roles are returned unchanged.
 */
export function withProductRoleLabels(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.map((item) => {
    const label = item.role ? PRODUCT_ROLE_LABELS[item.role as string] : undefined
    return label ? { ...item, label } : item
  })
}

/** macOS: the standard TalkWeaver menu, with Check for Updates… directly under About. */
export function macAppMenu(name: string, helpItems: MenuItemConstructorOptions[]): MenuItemConstructorOptions {
  const check = helpItems.filter(isCheck)
  return {
    label: name,
    submenu: withProductRoleLabels([
      { role: 'about' },
      ...check,
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ]),
  }
}

/** Help: What's new, the cheat sheet, and (not on macOS, where it is in the TalkWeaver menu) Check for Updates…. */
export function helpMenu(helpItems: MenuItemConstructorOptions[], platform: string): MenuItemConstructorOptions {
  return { role: 'help', submenu: platform === 'darwin' ? helpItems.filter((item) => !isCheck(item)) : helpItems }
}
