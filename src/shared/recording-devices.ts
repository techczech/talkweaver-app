export type CaptureChoice = 'voice' | 'camera'
export interface CheckedDevices { version: 1; microphone: string; camera: string; cameraDeviceId?: string; checkedAt: string; micPermission: string; cameraPermission: string }
export function needsDeviceCheck(saved: CheckedDevices | null, choice: CaptureChoice, devices: ReadonlyArray<{ kind: string; label: string; deviceId?: string }>, permission: { microphone: string; camera: string }, microphone: string): boolean {
  if (!saved || saved.version !== 1 || saved.microphone !== microphone || saved.micPermission !== permission.microphone) return true
  if (!devices.some(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications' && d.label === saved.microphone)) return true
  const cameras = devices.filter(d => d.kind === 'videoinput' && d.label === saved.camera)
  const cameraKnown = cameras.some(d => !!saved.cameraDeviceId && d.deviceId === saved.cameraDeviceId) || cameras.length === 1
  return choice === 'camera' && (!saved.camera || saved.cameraPermission !== permission.camera || !cameraKnown)
}

/** Device setup belongs to a presenter or Settings main frame, never an editor or embed. */
export function mayCheckDevices(mainFrame: boolean, presenter: boolean, settings: boolean): boolean { return mainFrame && (presenter || settings) }
