// Lightweight global notifications so failures are VISIBLE immediately instead of silently
// blanking (ADR-0023 "never fail silently", applied to the UI). Anything in the renderer can call
// notify(...); the <Toasts/> component (mounted once in App) renders a stack. Errors persist until
// dismissed; info/success auto-dismiss.
export type ToastLevel = 'error' | 'warning' | 'info' | 'success'

/** An optional single action on a toast (e.g. the insert-time "Merge into one" nudge). A toast
 *  carrying an action never auto-dismisses — it waits for the click or an explicit dismiss. */
export interface ToastAction {
  label: string
  onAction: () => void
}

export interface ToastDetail {
  message: string
  level: ToastLevel
  /** De-dupe key — a repeat with the same key replaces rather than stacks (e.g. "compiler-missing"). */
  key?: string
  action?: ToastAction
}

export const TOAST_EVENT = 'tw-toast'
export const TOAST_DISMISS_EVENT = 'tw-toast-dismiss'

export function notify(message: string, level: ToastLevel = 'info', key?: string, action?: ToastAction): void {
  window.dispatchEvent(new CustomEvent<ToastDetail>(TOAST_EVENT, { detail: { message, level, key, action } }))
}

/** Dismiss any toast carrying `key` — for persistent errors whose condition has since recovered
 *  (e.g. clear 'compile-fail' on the next successful compile so it doesn't keep accusing). */
export function dismissToast(key: string): void {
  window.dispatchEvent(new CustomEvent<string>(TOAST_DISMISS_EVENT, { detail: key }))
}
