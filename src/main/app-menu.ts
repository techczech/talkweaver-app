// The two menus the update notices add to the application menu (ADR-0041): the macOS TalkWeaver menu
// with Check for Updates… under About (the standard place), and the Help menu. Both are built from the
// registry's Help items (command-registry.ts: menu path `Help`), so the words and chords are the
// registry's. No Electron import: a plain list of menu items in, a plain list out.
import type { Event as ElectronEvent, MenuItemConstructorOptions, WebContents } from 'electron'

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

/** Queue commands for a newly opened editor. Slide preview frames can load in an already usable editor. */
export function sendEditorMenuCommand(
  contents: Pick<WebContents, 'isLoadingMainFrame' | 'on' | 'once' | 'removeListener' | 'send'>,
  id: string,
  channel: 'app:run-command' | 'settings-window:editor-action' = 'app:run-command'
): void {
  if (!contents.isLoadingMainFrame()) {
    contents.send(channel, id)
    return
  }

  const cleanup = (): void => {
    contents.removeListener('did-finish-load', finish)
    contents.removeListener('did-fail-load', fail)
    contents.removeListener('did-fail-provisional-load', fail)
  }
  const finish = (): void => {
    cleanup()
    contents.send(channel, id)
  }
  const fail = (_event: ElectronEvent, _code: number, _description: string, _url: string, isMainFrame: boolean): void => {
    if (isMainFrame) cleanup()
  }

  contents.once('did-finish-load', finish)
  contents.on('did-fail-load', fail)
  contents.on('did-fail-provisional-load', fail)
}
