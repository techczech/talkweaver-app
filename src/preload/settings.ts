// Preload of the shared Settings window (sandboxed; bundled with the app, it loads no package).
//
// `window.bridleSettings`: the shared Settings bridge of @app-patterns/settings-electron (every setting, the
// shortcuts, export and import, Accounts and keys).
//
// `window.tw`: only what the app's own pages in that window call (settings-main.tsx): Cloudflare and
// going live (Settings › Cloudflare, reusing CloudflareSettings.tsx), the recording storage row, the
// advanced publishing fields, the backup status and Back up now, the transcription row, and three
// actions that run in the editor window (open the Guide, show the example vault again, add a
// vault). Most are the same channel the editor window's preload uses (src/preload/index.ts), so main
// answers it as it answers that window; the recording storage changes (endpoint, bucket, keys) and the
// transcription paths are this window's only. No channel here returns a key.
import type { UpdateSnapshot } from '@app-patterns/updates'
import type { WhatsNewItem } from '@app-patterns/updates'
import { contextBridge, ipcRenderer } from 'electron'
import { exposeSettingsBridge } from '@app-patterns/settings-electron/preload'

exposeSettingsBridge()

const on = <T>(channel: string, listener: (value: T) => void): (() => void) => {
  const handler = (_event: unknown, value: T): void => listener(value)
  ipcRenderer.on(channel, handler)
  return () => { ipcRenderer.removeListener(channel, handler) }
}

const tw = {
  updates: {
    get: (): Promise<UpdateSnapshot> => ipcRenderer.invoke('updates:get'),
    /** Check for Updates…: always checks (a Store copy and a development run answer without a request). */
    check: (): Promise<UpdateSnapshot> => ipcRenderer.invoke('updates:check'),
    skip: (version: string): Promise<UpdateSnapshot> => ipcRenderer.invoke('updates:skip', version),
    stopSkipping: (): Promise<UpdateSnapshot> => ipcRenderer.invoke('updates:stop-skipping'),
    notNow: (): Promise<UpdateSnapshot> => ipcRenderer.invoke('updates:not-now'),
    /** The setting `updates.checkForNewVersions`. */
    setEnabled: (on: boolean): Promise<UpdateSnapshot> => ipcRenderer.invoke('updates:set-enabled', on),
    download: (): Promise<boolean> => ipcRenderer.invoke('updates:download'),
    openNotes: (version: string): Promise<boolean> => ipcRenderer.invoke('updates:open-notes', version),
    openStore: (): Promise<boolean> => ipcRenderer.invoke('updates:open-store'),
    /** The notes shipped for the running version, or null. */
    whatsNew: (): Promise<{ version: string; from: string | null; items: WhatsNewItem[] } | null> => ipcRenderer.invoke('updates:whats-new'),
    dismissWhatsNew: (): Promise<UpdateSnapshot> => ipcRenderer.invoke('updates:dismiss-whats-new'),
    onChange: (cb: (snapshot: UpdateSnapshot) => void): (() => void) => {
      const listener = (_e: unknown, snapshot: UpdateSnapshot): void => cb(snapshot)
      ipcRenderer.on('updates:changed', listener)
      return () => ipcRenderer.removeListener('updates:changed', listener)
    },
    /** The answer of a Check for Updates… that waited for a talk to end. */
    onAnswer: (cb: (snapshot: UpdateSnapshot) => void): (() => void) => {
      const listener = (_e: unknown, snapshot: UpdateSnapshot): void => cb(snapshot)
      ipcRenderer.on('updates:answered', listener)
      return () => ipcRenderer.removeListener('updates:answered', listener)
    }
  },
  cloudflare: {
    status: () => ipcRenderer.invoke('cloudflare:status'),
    check: (reason: 'asked' | 'opened' = 'asked') => ipcRenderer.invoke('cloudflare:check', reason),
    saveToken: (token: string) => ipcRenderer.invoke('cloudflare:save-token', token),
    chooseAccount: (accountId: string) => ipcRenderer.invoke('cloudflare:choose-account', accountId),
    createSite: () => ipcRenderer.invoke('cloudflare:create-site'),
    disconnect: () => ipcRenderer.invoke('cloudflare:disconnect'),
    useShareDomain: () => ipcRenderer.invoke('cloudflare:use-share-domain'),
    onStatus: (listener: (status: unknown) => void) => on('cloudflare:status', listener)
  },
  liveService: {
    status: () => ipcRenderer.invoke('live-service:status'),
    setUp: () => ipcRenderer.invoke('live-service:set-up'),
    onStatus: (listener: (row: unknown) => void) => on('live-service:status', listener),
    onNotice: (listener: (message: string) => void) => on('live-service:notice', listener)
  },
  recording: {
    storageStatus: () => ipcRenderer.invoke('recording:storage-status'),
    checkStorage: () => ipcRenderer.invoke('recording:check-storage'),
    // Changes only this window may make (main refuses any other sender). The keys go in and are never read back.
    setStorage: (cfg: { endpoint: string; bucket: string; discardSeconds: number }) => ipcRenderer.invoke('recording:set-storage', cfg),
    setKeys: (keys: { accessKeyId: string; secretAccessKey: string }) => ipcRenderer.invoke('recording:set-keys', keys),
    clearKeys: () => ipcRenderer.invoke('recording:clear-keys'),
    onStorageStatus: (listener: (row: unknown) => void) => on('recording:storage-status', listener)
  },
  publish: {
    getConfig: () => ipcRenderer.invoke('publish:get-config'),
    setConfig: (cfg: unknown) => ipcRenderer.invoke('publish:set-config', cfg)
  },
  backup: {
    runNow: () => ipcRenderer.invoke('backup:run-now'),
    setEnrolled: (slug: string, enrolled: boolean) => ipcRenderer.invoke('backup:set-enrolled', slug, enrolled),
    onStatus: (listener: (run: unknown) => void) => on('backup:status', listener)
  },
  settings: {
    chooseArchive: () => ipcRenderer.invoke('preferences:choose-archive'),
    clearArchive: () => ipcRenderer.invoke('preferences:clear-archive'),
    chooseBackupFolder: () => ipcRenderer.invoke('preferences:choose-backup-folder'),
    clearBackupFolder: () => ipcRenderer.invoke('preferences:clear-backup-folder'),
    getBackup: () => ipcRenderer.invoke('preferences:get-backup'),
    transcriptionStatus: () => ipcRenderer.invoke('transcription:status'),
    // A change only this window may make: the paths name programs main runs (main refuses any other sender).
    setTranscription: (cfg: { python: string; script: string; ffmpeg: string }) => ipcRenderer.invoke('preferences:set-transcription', cfg),
    transcriptionAgentPrompt: () => ipcRenderer.invoke('transcription:agent-prompt'),
    openTranscriptionSetupFolder: () => ipcRenderer.invoke('transcription:open-setup-folder'),
    /** Runs in the editor window: 'open-guide' | 'restore-example' | 'add-vault'. */
    editorAction: (action: string) => ipcRenderer.invoke('settings-window:editor-action', action),
    exampleRemoved: () => ipcRenderer.invoke('settings-window:example-removed')
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url)
  }
}

contextBridge.exposeInMainWorld('tw', tw)
