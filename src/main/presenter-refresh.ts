import { ipcMain, type WebContents } from 'electron'

// Window identity is the capability. No renderer can nominate a Run or another window.
const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()
const snapshots = new Map<number, unknown>()
const watched = new WeakSet<WebContents>()
export function registerPresenterRefresh(): void {
  ipcMain.handle('recording:refresh-ready', (event, snapshot: unknown, error?: string) => {
    if (event.senderFrame !== event.sender.mainFrame) throw Error('Presenter main frame required')
    const request = pending.get(event.sender.id)
    if (!request) throw Error('No Refresh requested')
    pending.delete(event.sender.id)
    if (error) { request.reject(Error(error)); return }
    if (snapshot != null) snapshots.set(event.sender.id, snapshot)
    request.resolve()
  })
  ipcMain.handle('recording:refresh-restore', event => {
    if (event.senderFrame !== event.sender.mainFrame) throw Error('Presenter main frame required')
    const snapshot = snapshots.get(event.sender.id)
    snapshots.delete(event.sender.id)
    return snapshot ?? null
  })
}

export async function prepareRecordingRefresh(contents: WebContents): Promise<void> {
  if (pending.has(contents.id) || snapshots.has(contents.id)) throw Error('Refresh already in progress')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(contents.id); reject(Error('Recording did not finish its Refresh handover; keep the presenter open.')) }, 30000)
    pending.set(contents.id, {
      resolve: () => { clearTimeout(timer); resolve() },
      reject: error => { clearTimeout(timer); reject(error) }
    })
    if (!watched.has(contents)) {
      watched.add(contents)
      contents.once('destroyed', () => { snapshots.delete(contents.id); pending.delete(contents.id) })
    }
    contents.send('recording:prepare-refresh')
  })
}

export function cancelRecordingRefresh(contents: WebContents): void {
  snapshots.delete(contents.id)
  pending.get(contents.id)?.reject(Error('Refresh navigation failed'))
  pending.delete(contents.id)
}
