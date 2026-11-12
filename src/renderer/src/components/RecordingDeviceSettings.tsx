import React, { useEffect, useState } from 'react'
import { checkPresenterDevices } from '../../../preload/presenter-device-check'
import type { CheckedDevices } from '../../../shared/recording-devices'
const api = (window as unknown as { tw: { recordingDevices: { library(reveal?: boolean): Promise<{ count: number; bytes: number }>; preview(camera: unknown, preview: unknown): Promise<unknown>; get(): Promise<{ settings: CheckedDevices | null }>; check(value: unknown): Promise<unknown>; systemSettings(kind: unknown): Promise<unknown> } } }).tw.recordingDevices
export default function RecordingDeviceSettings({ microphone, capture, setCapture }: { microphone: string; capture: string; setCapture(value: string): void }) {
  const [library, setLibrary] = useState({ count: 0, bytes: 0 })
  const [checked, setChecked] = useState<CheckedDevices | null>(null)
  useEffect(() => { void api.library().then(setLibrary); void api.get().then(value => setChecked(value.settings)) }, [])
  async function check() {
    const value = await checkPresenterDevices('camera', microphone, (channel, value, extra) => channel === 'recording:device-preview' ? api.preview(value, extra) : channel === 'recording:device-settings' ? api.systemSettings(value) : value === undefined ? api.get() : api.check(value), true)
    if (value) setChecked(value)
  }
  return <section className="recording-device-settings">
    <p>Camera: {checked?.camera || 'Not checked on this Mac yet'}</p>
    <p>{checked?.checkedAt ? `Devices last checked on ${new Date(checked.checkedAt).toLocaleDateString('en-GB')}` : 'Camera and microphone have not been checked on this Mac.'}</p>
    <button onClick={() => { void check() }}>Check camera and microphone</button>
    <label>When I press Record, capture: <select value={capture} onChange={e => setCapture(e.target.value)}><option value="voice">Slides and voice</option><option value="camera">Slides, voice and camera</option></select></label>
    <p>These are remembered for this Mac only, not shared with other Macs.</p>
    <p>Recordings on this Mac: {library.count} recordings · {(library.bytes / 1e9).toFixed(2)} GB <button onClick={() => { void api.library(true) }}>Show in Finder</button></p>
  </section>
}
