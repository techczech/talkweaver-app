// What each `setup` command does (setup-cli.ts parses and prints; ticket 07, spec D14). One
// implementation, two callers: every operation here is a call on the same service the window's own
// IPC handler calls (the Cloudflare connection, the live service, recording storage, transcription
// set-up), and settings are written through the same two functions the window's Save uses
// (`publishSettings.apply`, `recordingSettings.apply` in the main process). Nothing here talks to
// Cloudflare, the secrets store or config.json by itself.
//
//   command                  the window's equivalent
//   -----------------------  -----------------------------------------------------------------
//   connect (token)          Paste a token: saveToken, and the check that follows; the live row looked up
//   account <id>             the account picker (after a check lists the accounts in this process)
//   create-site [name]       the site name in Settings (Save), then "Create <site>"
//   live                     "Set up going live" / Try again
//   share-domain <host>      the share-link address in Settings (Save); attached by the live service's
//                            update, run here at once when a live service is set up
//   disconnect               Disconnect
//   recording                Recording storage: endpoint and bucket (Save), keys, Check
//   transcription            Settings → Transcription: Save
//   status                   Check again on each row
//
// No Electron import and erasable TypeScript only: scripts/test-setup-cli.mjs drives it with stand-ins.
import { TOKEN_SHAPE_ERROR, type CloudflareConnectionService } from './cloudflare-connection.ts'
import type { LiveService } from './live-service.ts'
import { KEYS_SHAPE_ERROR, recordingKeysAcceptable, type RecordingStorage } from './recording-storage.ts'
import type { TranscriptionSetup } from './transcription-setup.ts'
import type { ImporterRow, OpResult, SetupOperations, SetupSnapshot } from './setup-cli.ts'
import type { GoingLiveRow } from '../shared/live-service-status.ts'
import { goingLiveRowDetail } from '../shared/live-service-status.ts'

/** What Settings → Cloudflare's fields hold (`publish:get-config` / `publish:set-config`). */
export type PublishSettings = { accountId: string; project: string; baseUrl: string; workerBaseUrl: string; useShortIds: boolean; shareDomain: string }
export type RecordingSettings = { endpoint: string; bucket: string; discardSeconds: number }

export interface SetupOperationPorts {
  connection: CloudflareConnectionService
  liveService: LiveService
  recording: RecordingStorage
  transcription: TranscriptionSetup
  importer: () => Promise<ImporterRow>
  /** The window's Settings → Cloudflare fields: read, and Save (which tells the connection itself). */
  publishSettings: { read(): PublishSettings; apply(next: PublishSettings): { success: true; checked?: Promise<unknown> } | { success: false; error: string } }
  /** The window's Recording storage fields: read, and Save (which tells recording storage itself). */
  recordingSettings: { read(): RecordingSettings; apply(next: RecordingSettings): void }
  /** Every new Going live row while a set-up runs. Answers a function that stops listening. */
  watchLiveRow(listener: (row: GoingLiveRow) => void): () => void
}

const failed = (error: string, usage = false): OpResult => ({ ok: false, error, ...(usage ? { usage: true } : {}) })

export function createSetupOperations(ports: SetupOperationPorts): SetupOperations {
  const { connection, liveService, recording, transcription } = ports

  /** Check the connection and look the live service up, as opening Settings → Cloudflare does. */
  async function checkCloudflare(): Promise<string | null> {
    const reply = await connection.check('asked')
    await connection.idle()
    try { await liveService.look('asked') } catch { /* the row says what is known */ }
    return reply.ok ? null : reply.error
  }

  function progressOfLive(progress: (line: string) => void): () => void {
    let last = ''
    return ports.watchLiveRow((row) => {
      if (row.state !== 'setting-up' && row.state !== 'updating') return
      const line = `${row.state === 'updating' ? 'Updating…' : 'Setting up…'} ${goingLiveRowDetail(row)}`
      if (line !== last) { last = line; progress(line) }
    })
  }

  async function setUpLive(progress: (line: string) => void): Promise<OpResult> {
    const stop = progressOfLive(progress)
    try {
      const reply = await liveService.setUp()
      return reply.ok ? { ok: true } : failed(reply.error)
    } finally {
      stop()
    }
  }

  return {
    async checkAll() {
      await checkCloudflare()
      if (recording.status().state !== 'not-set-up') await recording.check()
    },

    async snapshot(): Promise<SetupSnapshot> {
      // A command that did not touch Cloudflare still prints the connection as it is, not "Checking…".
      const now = connection.status()
      if (now.connection.state === 'checking' && !now.busy) await checkCloudflare()
      const [transcriptionRow, importer] = await Promise.all([
        transcription.status().catch(() => null),
        ports.importer().catch(() => null),
      ])
      return { cloudflare: connection.status(), goingLive: liveService.row(), recording: recording.status(), transcription: transcriptionRow, importer }
    },

    async connect(token) {
      const saved = await connection.saveToken(token)
      // A token of the wrong shape is an input error; a store that refuses is a state (printed).
      if (!saved.ok) return failed(saved.error, saved.error === TOKEN_SHAPE_ERROR)
      const failure = await checkCloudflare()
      return failure ? failed(failure) : { ok: true }
    },

    async chooseAccount(id) {
      // A fresh process knows no list yet: the check lists the accounts the token sees.
      await checkCloudflare()
      const reply = await connection.chooseAccount(id)
      await connection.idle()
      try { await liveService.look('asked') } catch { /* the row says what is known */ }
      return reply.ok ? { ok: true } : failed(reply.error)
    },

    async createSite(name, progress) {
      if (name !== null) {
        const current = ports.publishSettings.read()
        if (current.project !== name) {
          const saved = ports.publishSettings.apply({ ...current, project: name })
          if (!saved.success) return failed(saved.error, true)
          if (saved.checked) await saved.checked
        }
      }
      await checkCloudflare()
      const before = connection.status()
      if (before.connection.state === 'connected' && before.publishing.state === 'ready') return { ok: true }
      if (before.publishing.state !== 'no-site') return failed('There is no site to create just now: see the Publishing handouts row.')
      progress(`Creating the site ${before.publishing.project}…`)
      const reply = await connection.createSite()
      await connection.idle()
      return reply.ok ? { ok: true } : failed(reply.error)
    },

    async setUpLive(progress) {
      const failure = await checkCloudflare()
      if (failure) return failed(failure)
      return setUpLive(progress)
    },

    async setShareDomain(host, progress) {
      const current = ports.publishSettings.read()
      if (current.shareDomain !== (host ?? '')) {
        const saved = ports.publishSettings.apply({ ...current, shareDomain: host ?? '' })
        if (!saved.success) return failed(saved.error, true)
        if (saved.checked) await saved.checked
      }
      await checkCloudflare()
      // The address is attached to (or removed from) the live service by its set-up. With a live
      // service set up, that update runs now; without one, it runs when going live is set up.
      const row = liveService.row()
      const deployed = row.address !== null && (row.state === 'ready' || row.state === 'failed' || row.state === 'no-permission')
      if (!deployed) {
        return host === null || connection.status().shareLink.state === 'attached'
          ? { ok: true }
          : failed('The address is attached when going live is set up: run "setup cloudflare live".')
      }
      const live = await setUpLive(progress)
      await checkCloudflare()
      return live
    },

    async disconnect() {
      const reply = await connection.disconnect()
      await connection.idle()
      liveService.refresh()
      return reply.ok ? { ok: true } : failed(reply.error)
    },

    async setRecording(settings, keys) {
      // Every part is checked before anything is written: a usage error changes nothing. The endpoint
      // and bucket were checked by the parser; the keys here, by the very test saveKeys applies. Then the keys (which can fail on the secrets store, a state), then
      // the endpoint and bucket.
      if (!settings.endpoint || !settings.bucket) return failed('Give both: setup recording --endpoint <url> --bucket <name>.', true)
      if (keys && !recordingKeysAcceptable(keys)) return failed(KEYS_SHAPE_ERROR, true)
      if (keys) {
        const saved = recording.saveKeys(keys)
        if (!saved.success) return failed(saved.error, saved.error === KEYS_SHAPE_ERROR)
      }
      const current = ports.recordingSettings.read()
      if (current.endpoint !== settings.endpoint || current.bucket !== settings.bucket) {
        ports.recordingSettings.apply({ ...current, endpoint: settings.endpoint, bucket: settings.bucket })
      }
      if (recording.status().state === 'not-set-up') return { ok: true }
      await recording.check()
      return { ok: true }
    },

    async setTranscription(paths) {
      await transcription.setPaths({ python: paths.python, script: paths.script, ...(paths.ffmpeg === undefined ? {} : { ffmpeg: paths.ffmpeg }) })
      return { ok: true }
    },
  }
}
