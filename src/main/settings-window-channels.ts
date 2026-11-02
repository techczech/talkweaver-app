// Who may call each channel the Settings window's preload (src/preload/settings.ts) exposes as
// `window.tw` (Sol review 1, #2). The global main-frame guard (ipc-main-frame-only.ts) only says a
// call came from some window's top frame; it does not say which window. So:
//
//   - SETTINGS_WINDOW_ONLY: a change that only the Settings window's own pages make. Main registers
//     each through handleFromSettingsWindow (index.ts), which asks the settings host's
//     isSettingsWindowSender with the whole event and refuses any other sender.
//   - SHARED_CHANGES: a change an editor window makes too; each handler keeps its own rule. None
//     since Sol review 4: making the site and setting up going live became Settings-window-only.
//   - READS: a status, a check or a page that opens; nothing in the settings or the keys changes.
//
// scripts/test-shared-settings.mjs checks that every channel the preload invokes is in exactly one
// list, and that every SETTINGS_WINDOW_ONLY channel is registered through the guard.
//
// Pure; erasable TypeScript only (node tests import it as it is).

// The rule (Sol review 4): Settings configuration (keys, the account and site publishing goes to,
// endpoints, the programs main runs) is changed only from the Settings window. Credentials minted
// as a by-product of an editor action stay with the editor that asked: the owner token of a share
// (shared-talk:share, shared-talk:stop), of a Run's results link (history:results-share,
// history:results-share-stop) and of a live session (live:go). Those channels are not listed here.
export const SETTINGS_WINDOW_ONLY: readonly string[] = [
  'preferences:choose-archive',
  'preferences:clear-archive',
  'preferences:choose-backup-folder',
  'preferences:clear-backup-folder',
  'cloudflare:save-token',
  'cloudflare:choose-account',
  'cloudflare:disconnect',
  'cloudflare:use-share-domain',
  // Saves the account and site publishing goes to; an editor's publish sheet opens Settings instead.
  'cloudflare:create-site',
  // Deploys the live service and saves its address; an editor's Run answers page opens Settings instead.
  'live-service:set-up',
  'publish:set-config',
  'backup:run-now',
  'backup:set-enrolled',
  'settings-window:editor-action',
  // Recording storage: the endpoint and bucket, and the access keys (a secret). The Settings
  // window's own pages write these through the settings store and Accounts and keys; these calls
  // stay for that window only, and the editor window's preload no longer has them.
  'recording:set-storage',
  'recording:set-keys',
  'recording:clear-keys',
  // The transcription paths name the programs main runs (Python, the script, ffmpeg): the same
  // authority as a key. The Settings window's Recording rows write them through the settings store.
  'preferences:set-transcription'
]

/** Changes an editor window asks for too, with the rule each handler applies. None at present. */
export const SHARED_CHANGES: Readonly<Record<string, string>> = {
  'updates:skip': 'Only a validated version number is stored; no address is accepted.',
  'updates:stop-skipping': 'Clears the skipped version.',
  'updates:not-now': 'Snoozes the mark until the next daily check.',
  'updates:set-enabled': 'Writes the boolean checking preference through the shared settings overlay.',
  'updates:dismiss-whats-new': 'Marks the bundled notes as seen.'
}

export const READS: readonly string[] = [
  'updates:get', 'updates:check', 'updates:download', 'updates:open-notes', 'updates:open-store', 'updates:whats-new',
  'cloudflare:status',
  'cloudflare:check',
  'live-service:status',
  'recording:storage-status',
  'recording:check-storage',
  'publish:get-config',
  'preferences:get-backup',
  'transcription:status',
  'transcription:agent-prompt',
  'transcription:open-setup-folder',
  'settings-window:example-removed',
  'shell:open-external'
]

/** The reply a refused recording-storage change gets (the shape its callers read: `success`, `error`). */
export const RECORDING_SETTINGS_ONLY = { success: false, error: 'This can be changed only in the Settings window.' } as const

/**
 * The guard behind handleFromSettingsWindow (index.ts): the handler runs only when the settings
 * host says the call came from the Settings window (given the whole event); any other sender gets
 * `refused()` and the handler is never called.
 */
export function settingsWindowOnly<E, A extends unknown[], R, F>(
  fromSettingsWindow: (event: E) => boolean,
  refused: () => F,
  handler: (event: E, ...args: A) => R
): (event: E, ...args: A) => R | F {
  return (event: E, ...args: A) => (fromSettingsWindow(event) === true ? handler(event, ...args) : refused())
}

