export interface ToolsWindowSenderTarget {
  isDestroyed: () => boolean
  webContents: unknown
}

export function isToolsWindowSender(sender: unknown, toolsWindow: ToolsWindowSenderTarget | null): boolean {
  return Boolean(toolsWindow && !toolsWindow.isDestroyed() && sender === toolsWindow.webContents)
}
