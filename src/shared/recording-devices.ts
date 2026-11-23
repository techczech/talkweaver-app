export type CaptureChoice = 'voice' | 'camera'
export interface CheckedDevices { version: 1; microphone: string; camera: string; cameraDeviceId?: string; checkedAt: string; micPermission: string; cameraPermission: string }
type ListedDevice = { kind: string; label: string; deviceId?: string }

/** Chromium IDs may differ between Settings and the presenter. A unique matching name is enough. */
export function checkedCameraInput<T extends ListedDevice>(devices: readonly T[], name: string, id?: string): T | undefined {
  if (!name) return undefined
  const cameras = devices.filter((d) => d.kind === 'videoinput' && d.label === name)
  return cameras.find((d) => !!id && d.deviceId === id) ?? (cameras.length === 1 ? cameras[0] : undefined)
}

export function needsDeviceCheck(saved: CheckedDevices | null, choice: CaptureChoice, devices: readonly ListedDevice[], permission: { microphone: string; camera: string }, microphone: string): boolean {
  if (!saved || saved.version !== 1 || saved.microphone !== microphone || saved.micPermission !== permission.microphone) return true
  if (!devices.some(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications' && d.label === saved.microphone)) return true
  return choice === 'camera' && (!saved.camera || saved.cameraPermission !== permission.camera || !checkedCameraInput(devices, saved.camera, saved.cameraDeviceId))
}

/** Device setup belongs to a presenter or Settings main frame, never an editor or embed. */
export function mayCheckDevices(mainFrame: boolean, presenter: boolean, settings: boolean): boolean { return mainFrame && (presenter || settings) }
