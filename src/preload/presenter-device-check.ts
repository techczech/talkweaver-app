/// <reference lib="dom" />
import { audioInputs, inputForRecording, needsPermission } from '../shared/microphone-choice'
import { checkedCameraInput, needsDeviceCheck, type CaptureChoice, type CheckedDevices } from '../shared/recording-devices'

const hidesCamera = (devices: readonly MediaDeviceInfo[]): boolean => devices.some((d) => d.kind === 'videoinput' && !d.label)

/** Open the checked camera, including on a fresh page whose inventory is still hidden. */
export async function openCheckedCamera(media: MediaDevices, devices: readonly MediaDeviceInfo[], name: string, savedId?: string): Promise<MediaStream> {
  const identified = checkedCameraInput(devices, name, savedId)
  const id = identified?.deviceId || (name && hidesCamera(devices) ? savedId : undefined)
  const unavailable = 'The checked camera is missing or ambiguous; check the devices again'
  if (!id) throw Error(unavailable)
  const stream = await media.getUserMedia({ audio: false, video: { deviceId: { exact: id } } })
  if (!identified && stream.getVideoTracks()[0]?.label !== name) {
    stream.getTracks().forEach((track) => track.stop())
    throw Error(unavailable)
  }
  return stream
}

export async function checkPresenterDevices(choice: CaptureChoice, microphone: string, invoke: (channel: string, ...args: unknown[]) => Promise<any>, force = false): Promise<CheckedDevices | null> {
  await invoke('recording:device-preview', choice === 'camera', true)
  const info: { settings: CheckedDevices | null; microphone: string; camera: string } = await invoke('recording:devices')
  const media = navigator.mediaDevices
  let devices = await media.enumerateDevices()
  const saved = info.settings
  if (!force && saved) {
    if (choice === 'camera' && saved.cameraDeviceId && saved.cameraPermission === 'granted' && info.camera === 'granted'
      && !needsDeviceCheck(saved, 'voice', devices, info, microphone)
      && !checkedCameraInput(devices, saved.camera, saved.cameraDeviceId)
      && hidesCamera(devices)) {
      // On a fresh page Chromium may hide the camera inventory. Identify only the already checked camera.
      try {
        const stream = await openCheckedCamera(media, devices, saved.camera, saved.cameraDeviceId)
        try { devices = await media.enumerateDevices() } finally { stream.getTracks().forEach((track) => track.stop()) }
      } catch { /* The check sheet below can help pick a device. */ }
    }
    if (!needsDeviceCheck(saved, choice, devices, info, microphone)) {
      await invoke('recording:device-preview', choice === 'camera', false)
      if (choice === 'voice') return saved
      const camera = checkedCameraInput(devices, saved.camera, saved.cameraDeviceId)
      return { ...saved, cameraDeviceId: camera?.deviceId ?? saved.cameraDeviceId }
    }
  }
  if (!document.getElementById('twrec-device-style')) {
    const style = document.createElement('style'); style.id = 'twrec-device-style'
    style.textContent = `.twrec-device-check { box-sizing:border-box; width:520px; max-width:calc(100vw - 40px); background:var(--lt-bg,#17212b); color:var(--lt-text,#f7f3ea); border:1px solid #71849a; border-radius:12px; padding:24px; font:16px/1.5 -apple-system,BlinkMacSystemFont,sans-serif; } .twrec-device-check h2 { font:600 22px/1.3 -apple-system,BlinkMacSystemFont,sans-serif; margin:0 0 16px; letter-spacing:normal; } .twrec-device-check p,.twrec-device-check label { font:400 15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif; margin:12px 0; } .twrec-device-check button,.twrec-device-check select { font:500 14px/1.3 -apple-system,BlinkMacSystemFont,sans-serif; background:#26333f; color:#f7f3ea; border:1px solid #71849a; border-radius:6px; padding:7px 10px; cursor:pointer; } .twrec-device-check button:disabled { opacity:.5; cursor:default; } .twrec-device-check meter { width:100%; height:12px; } .twrec-device-check::backdrop { background:#0008; }`
    document.head.appendChild(style)
  }
  const dialog = document.createElement('dialog')
  dialog.className = 'twrec-device-check'
  dialog.dataset.state = 'checking'
  dialog.innerHTML = '<h2>Check camera and microphone</h2><p role="status">Checking…</p><video autoplay muted playsinline style="width:320px;max-height:180px" hidden></video><p data-mic-name></p><span data-heard></span><meter min="0" max="1" value="0" aria-label="Microphone level"></meter><p>These choices are remembered on this Mac only.</p><label>Camera <select></select></label><p><button type="button" data-retry hidden>Look again</button> <button type="button" data-settings hidden>Open System Settings</button> <button type="button" data-continue disabled>Use these devices</button> <button type="button" data-cancel>Cancel</button></p>'
  document.body.appendChild(dialog); dialog.showModal()
  const status = dialog.querySelector('p')!, preview = dialog.querySelector('video')!, select = dialog.querySelector('select')!
  const go = dialog.querySelector<HTMLButtonElement>('[data-continue]')!, settings = dialog.querySelector<HTMLButtonElement>('[data-settings]')!
  let chosenMic = microphone
  let active: MediaStream | null = null, gone = false, permissionKind = 'microphone'
  let audioContext: AudioContext | null = null, meterFrame = 0
  const retry = dialog.querySelector<HTMLButtonElement>('[data-retry]')!
  const result = new Promise<CheckedDevices | null>(resolve => {
    function close(value: CheckedDevices | null) { if (gone) return; gone = true; cancelAnimationFrame(meterFrame); void audioContext?.close(); active?.getTracks().forEach(t => t.stop()); dialog.close(); dialog.remove(); void invoke('recording:device-preview', choice === 'camera' && !!value, false); resolve(value) }
    dialog.querySelector('[data-cancel]')!.addEventListener('click', () => close(null))
    dialog.addEventListener('cancel', e => { e.preventDefault(); close(null) })
    settings.addEventListener('click', () => { void invoke('recording:device-settings', permissionKind) })
    go.addEventListener('click', async () => {
      const permissions = await invoke('recording:devices')
      const checked: CheckedDevices = { version: 1, microphone: chosenMic, camera: choice === 'camera' ? select.selectedOptions[0]?.textContent ?? '' : info.settings?.camera ?? '', cameraDeviceId: choice === 'camera' ? select.value : info.settings?.cameraDeviceId, checkedAt: new Date().toISOString(), micPermission: permissions.microphone, cameraPermission: choice === 'camera' ? permissions.camera : info.settings?.cameraPermission ?? permissions.camera }
      await invoke('recording:devices', checked); close(checked)
    })
  })
  async function lookAgain() {
  active?.getTracks().forEach(t => t.stop()); cancelAnimationFrame(meterFrame); await audioContext?.close(); audioContext = null
  select.replaceChildren(); go.disabled = true; retry.hidden = true; settings.hidden = true; status.textContent = 'Checking…'
  devices = await navigator.mediaDevices.enumerateDevices()
  try {
    let mic = audioInputs(devices).find(d => d.label === microphone) || inputForRecording(devices, microphone, null)?.input
    if (!mic && needsPermission(devices)) {
      const discovery = await navigator.mediaDevices.getUserMedia({ audio: true })
      discovery.getTracks().forEach(track => track.stop())
      devices = await navigator.mediaDevices.enumerateDevices()
      mic = audioInputs(devices).find(d => d.label === microphone) || inputForRecording(devices, microphone, null)?.input
    }
    if (!mic) throw Error('No microphone selected or connected. Choose a microphone in Settings, then look again.')
    active = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: mic.deviceId } } })
    chosenMic = active.getAudioTracks()[0]?.label || microphone
    dialog.querySelector('[data-mic-name]')!.textContent = `Microphone: ${chosenMic}`
    if (gone) { active.getTracks().forEach(t => t.stop()); return result }
    audioContext = new AudioContext()
    const analyser = audioContext.createAnalyser(); audioContext.createMediaStreamSource(active).connect(analyser)
    const samples = new Uint8Array(analyser.fftSize)
    const meter = dialog.querySelector('meter')!
    const tick = () => { analyser.getByteTimeDomainData(samples); meter.value = Math.min(1, Math.sqrt(samples.reduce((sum, x) => sum + ((x - 128) / 128) ** 2, 0) / samples.length) * 4); if (meter.value > .05) dialog.querySelector('[data-heard]')!.textContent = 'Heard you'; meterFrame = requestAnimationFrame(tick) }; tick()
    devices = await navigator.mediaDevices.enumerateDevices()
    if (!devices.some(d => d.kind === 'audioinput')) throw Error('No microphone connected. Connect a microphone and try again.')
    if (choice === 'camera') {
      permissionKind = 'camera'
      if (hidesCamera(devices)) {
        // On first setup permission exposes the device names for the picker.
        const discovery = await media.getUserMedia({ video: true, audio: false })
        try { devices = await media.enumerateDevices() } finally { discovery.getTracks().forEach((track) => track.stop()) }
        if (gone) return result
      }
      const cameras = devices.filter((d) => d.kind === 'videoinput' && d.deviceId)
      if (!cameras.length) throw Error('No camera connected. Connect a camera or choose Slides and voice.')
      for (const camera of cameras) { const option = document.createElement('option'); option.value = camera.deviceId; option.textContent = camera.label; select.appendChild(option) }
      const remembered = saved ? checkedCameraInput(cameras, saved.camera, saved.cameraDeviceId) : undefined
      if (remembered) select.value = remembered.deviceId
      async function showCamera() {
        active?.getVideoTracks().forEach(t => { active?.removeTrack(t); t.stop() })
        const video = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: select.value } }, audio: false })
        if (gone) { video.getTracks().forEach(t => t.stop()); return }
        video.getTracks().forEach(t => active?.addTrack(t)); if (select.selectedOptions[0]) select.selectedOptions[0].textContent = video.getVideoTracks()[0]?.label || select.selectedOptions[0].textContent; preview.srcObject = video; preview.hidden = false
      }
      await showCamera(); select.addEventListener('change', () => { void showCamera().catch(e => { status.textContent = String(e); go.disabled = true }) })
    } else select.parentElement!.hidden = true
    dialog.dataset.state = 'ready'
    status.textContent = 'Devices ready. Check that this is the camera and microphone you want.'; go.disabled = false
  } catch (error) {
    dialog.dataset.state = error instanceof DOMException && error.name === 'NotAllowedError' ? 'denied' : permissionKind === 'camera' ? 'nocam' : 'nomic'
    status.textContent = error instanceof DOMException && error.name === 'NotAllowedError' ? `Access denied. Allow TalkWeaver in System Settings › Privacy & Security › ${permissionKind === 'camera' ? 'Camera' : 'Microphone'}, then try again.` : error instanceof DOMException && error.name === 'NotFoundError' ? `No ${permissionKind === 'camera' ? 'camera' : 'microphone'} connected. Connect one, then choose Look again.` : String(error)
    settings.hidden = false; retry.hidden = false
  }
  }
  retry.addEventListener('click', () => { void lookAgain() })
  void lookAgain()
  return result
}
