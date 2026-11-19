// Loaded only by the isolated shutdown test, before any action that queues helper work.
const { app, BrowserWindow } = require('electron')
const { appendFileSync } = require('node:fs')
const { join } = require('node:path')
const userData = app.getPath('userData')
if (!userData.startsWith(join(app.getAppPath(), 'artefacts/quit-helpers/runtime-'))) {
  throw Error('Refusing shutdown tracing outside the isolated test profile')
}
const file = join(userData, 'quit-lifecycle.jsonl')
const write = (type, extra = {}) => appendFileSync(file, JSON.stringify({ at: Date.now(), type, ...extra }) + '\n')
for (const type of ['before-quit', 'will-quit', 'window-all-closed']) {
  if (type === 'before-quit') app.prependListener(type, event => write(type, { prevented: !!event?.defaultPrevented }))
  else app.on(type, event => write(type, { prevented: !!event?.defaultPrevented }))
}
app.on('quit', (_event, exitCode) => write('quit', { exitCode, windows: BrowserWindow.getAllWindows().length }))
const hook = window => {
  const id = window.id
  for (const type of ['close', 'closed']) window.on(type, event => write('window:' + type, { id, prevented: !!event?.defaultPrevented }))
  for (const type of ['did-start-loading', 'did-finish-load']) window.webContents.on(type, () => write(type, { id }))
  window.webContents.on('render-process-gone', (_event, details) => write('renderer-gone', { id, reason: details.reason }))
}
BrowserWindow.getAllWindows().forEach(hook)
app.on('browser-window-created', (_event, window) => {
  write('window:created', { id: window.id, stack: new Error().stack })
  hook(window)
})
write('trace-ready')
