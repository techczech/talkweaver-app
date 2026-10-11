// A failed publish, as a notification (spec docs/plans/cloudflare-setup-in-app, D12): the message is
// the sorted sentence; what the publishing tool printed is shown only when "Details" is pressed,
// never inline. The same pattern as the talk's Publish handout (WorkspaceLayout.handlePublishHandout).
// And a publish that went up without live features (D7): the sentence that names Settings →
// Cloudflare, with "Details" when a set-up was tried and failed, else "Open Settings".
import type { ToastAction, ToastLevel } from './notify'

export type PublishFailureToast = { message: string; level: ToastLevel; key: string; action?: ToastAction }

export function publishFailureToast(
  what: string, result: { error?: string; details?: string }, key: string,
  show: (message: string, level: ToastLevel, key: string) => void,
): PublishFailureToast {
  const details = result.details
  return {
    message: `${what}: ${result.error ?? 'unknown error'}`, level: 'error', key,
    ...(details ? { action: { label: 'Details', onAction: () => show(details, 'info', `${key}-details`) } } : {}),
  }
}

/**
 * The notice for a handout published without live features, or null when it went up with them.
 * `liveNotice` is the main process's fixed sentence; `liveDetails` (what the tool printed, cleaned)
 * is never the message.
 */
export function publishedWithoutLiveToast(
  result: { liveNotice?: string; liveDetails?: string }, key: string,
  show: (message: string, level: ToastLevel, key: string) => void, openSettings: () => void,
): PublishFailureToast | null {
  if (!result.liveNotice) return null
  const details = result.liveDetails
  return {
    message: result.liveNotice, level: 'warning', key,
    action: details
      ? { label: 'Details', onAction: () => show(details, 'info', `${key}-details`) }
      : { label: 'Open Settings', onAction: openSettings },
  }
}

/**
 * The notice that earlier handouts on the site need publishing again, or null. The sentence is the
 * main process's; the handouts' names are behind "Details".
 */
export function earlierHandoutsToast(
  result: { earlierNotice?: string; earlierDetails?: string }, key: string,
  show: (message: string, level: ToastLevel, key: string) => void,
): PublishFailureToast | null {
  if (!result.earlierNotice) return null
  const details = result.earlierDetails
  return {
    message: result.earlierNotice, level: 'warning', key,
    ...(details ? { action: { label: 'Details', onAction: () => show(details, 'info', `${key}-details`) } } : {}),
  }
}
