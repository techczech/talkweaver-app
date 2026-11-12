import { ipcRenderer } from 'electron'
import type { RecorderController } from './present-recorder'

/** Presenter-only DOM; never sent through audience sync or drawn onto the slides canvas. */
export function mountSelfView(controller: RecorderController, layered: boolean, previewWanted: () => boolean = () => false): () => void {
  const panel = document.createElement('section')
  panel.id = 'twrec-self-view'
  panel.style.cssText = 'max-width:240px;min-width:0;justify-self:end;align-self:start;font:12px -apple-system,BlinkMacSystemFont,sans-serif;color:#a3b3c2'
  const style = document.createElement('style')
  style.textContent = `
    #twrec-self-view[hidden] { display:none !important; }
    #twrec-self-view p { margin:4px 0; }
    #presenterRoot[data-notes-placement="bottom"] #twrec-self-view { grid-column:3; grid-row:4; }
    #presenterRoot[data-notes-placement="bottom"]:has(#twrec-self-view:not([hidden])) #presenterNotes { grid-column:1; }
  `
  document.head.appendChild(style)
  panel.innerHTML = '<button type="button" class="rec-btn" aria-expanded="true">Hide self-view</button><video autoplay muted playsinline style="width:100%;max-height:100px;object-fit:contain"></video><p>Position and size are chosen later</p>'
  ;(document.querySelector('.presenter-side') ?? document.body).appendChild(panel)
  const video = panel.querySelector('video')!
  const toggle = panel.querySelector('button')!
  toggle.addEventListener('click', () => {
    video.hidden = !video.hidden
    toggle.textContent = video.hidden ? 'Show self-view' : 'Hide self-view'
    toggle.setAttribute('aria-expanded', String(!video.hidden))
  })
  let preview: MediaStream | null = null, revision = 0
  return () => { void update() }
  async function update(): Promise<void> {
    const current = ++revision
    preview?.getTracks().forEach(t => t.stop()); preview = null
    video.srcObject = null
    panel.hidden = !layered || controller.captureChoice() !== 'camera' || (!previewWanted() && !controller.cameraStream?.())
    if (panel.hidden) { if (layered && ['idle', 'saved'].includes(controller.getState())) await ipcRenderer.invoke('recording:device-preview', false, false).catch(() => {}); return }
    const active = controller.cameraStream?.()
    if (active) { video.srcObject = active; return }
    if (!['idle', 'saved'].includes(controller.getState())) return
    try {
      const checked = await ipcRenderer.invoke('recording:devices')
      const saved = checked?.settings
      if (!saved?.camera || checked.camera !== 'granted') return
      await ipcRenderer.invoke('recording:device-preview', true, true)
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput' && d.label === saved.camera)
      const device = devices.find(d => d.deviceId === saved.cameraDeviceId) ?? (devices.length === 1 ? devices[0] : null)
      if (!device || current !== revision) return
      const stream = await navigator.mediaDevices.getUserMedia({audio:false, video:{deviceId:{exact:device.deviceId}}})
      if (current !== revision) { stream.getTracks().forEach(t => t.stop()); return }
      preview = stream; video.srcObject = stream
    } catch { /* The device check handles permission and missing-device notices. */ }
  }
}
