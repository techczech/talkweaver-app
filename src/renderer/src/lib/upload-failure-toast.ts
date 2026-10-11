// A recording upload that did not go through, as a notification: the same sorted sentence in Studio
// and in History (spec docs/plans/cloudflare-setup-in-app, "Upload recording"). Every one but a
// missing audio file says the recording is safe on this computer. With storage not set up it offers "Set up recording storage",
// which opens Settings. `error` is the main process's fixed word; nothing else is ever shown.
import { uploadFailureAction, uploadFailureMessage } from '../../../shared/recording-storage-status'
import { dismissToast, notify } from './notify'

const KEY = 'recording-upload'

export function showUploadFailure(error: unknown): void {
  const action = uploadFailureAction(error)
  notify(
    uploadFailureMessage(error), action ? 'warning' : 'error', KEY,
    action ? { label: action, onAction: () => { void window.tw.cloudflare.openSettings() } } : undefined,
  )
}

/** An upload went through: an earlier failure's notification no longer applies. */
export function clearUploadFailure(): void {
  dismissToast(KEY)
}
