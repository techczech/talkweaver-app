// Accounts and keys in the shared Settings window, over the app's own key holders: the Cloudflare
// token through the Cloudflare connection (its save and disconnect, so the check and the account
// follow as from Settings › Cloudflare), the recording storage keys through recording storage's
// saveKeys / clearKeys, typed in the window as `id:secret`.
//
// What holds:
//   - The window sees connected or missing only: no last four characters, no detail line, no
//     problem text from the holders (the host also puts every outcome in its own fixed words).
//   - A value goes one way, into the holder; nothing here returns, logs or keeps it.
//   - The changelog gets connected / missing through the host's recordSecret, never a value; export,
//     the CLI and the logs never see a key (the schema's `secret` rows have no stored value).
//
// No Electron import: scripts/test-shared-settings.mjs drives it with fake holders.
import { SLOT_MESSAGES, type SecretSlots, type SlotInfo, type SlotResult } from '@app-patterns/settings-electron'
import { SECRET_KEYS, schema } from '../shared/settings-schema.ts'

type Reply = { ok: boolean } | { success: boolean }

export interface SecretHolders {
  cloudflare: {
    has(): boolean
    save(token: string): Promise<Reply> | Reply
    disconnect(): Promise<Reply> | Reply
  }
  recording: {
    has(): boolean
    save(keys: { accessKeyId: string; secretAccessKey: string }): Promise<Reply> | Reply
    clear(): Promise<Reply> | Reply
  }
  /** Told after a key was saved or removed here, so the app's own rows (Settings › Cloudflare, recording storage) redraw. */
  changed?(id: string): void
}

const succeeded = (r: Reply | undefined | null): boolean =>
  !!r && typeof r === 'object' && (('ok' in r && r.ok === true) || ('success' in r && r.success === true))

const labelOf = (key: string): string => schema.def(key)?.label ?? key

/** `id:secret` → the two parts, or null when either is missing. Split at the first colon (an id has none). */
export function splitRecordingKeys(value: string): { accessKeyId: string; secretAccessKey: string } | null {
  const at = value.indexOf(':')
  if (at <= 0 || at === value.length - 1) return null
  const accessKeyId = value.slice(0, at).trim()
  const secretAccessKey = value.slice(at + 1).trim()
  return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : null
}

export function createSecretSlots(holders: SecretHolders): SecretSlots {
  const statusOf = (has: () => boolean): SlotInfo['status'] => {
    try { return has() ? 'connected' : 'missing' } catch { return 'problem' }
  }
  const done = (id: string, ok: boolean, failure: string): SlotResult => {
    if (ok) holders.changed?.(id)
    return ok ? { ok: true } : { ok: false, error: failure }
  }
  return {
    list: () => [
      { id: SECRET_KEYS.cloudflare, label: labelOf(SECRET_KEYS.cloudflare), status: statusOf(() => holders.cloudflare.has()) },
      { id: SECRET_KEYS.recording, label: labelOf(SECRET_KEYS.recording), status: statusOf(() => holders.recording.has()) }
    ],
    async set(id, value) {
      if (id === SECRET_KEYS.cloudflare) {
        let r: Reply | undefined
        try { r = await holders.cloudflare.save(value) } catch { return { ok: false, error: SLOT_MESSAGES.write } }
        return done(id, succeeded(r), SLOT_MESSAGES.shape)
      }
      if (id === SECRET_KEYS.recording) {
        const keys = splitRecordingKeys(value)
        if (!keys) return { ok: false, error: SLOT_MESSAGES.shape }
        let r: Reply | undefined
        try { r = await holders.recording.save(keys) } catch { return { ok: false, error: SLOT_MESSAGES.write } }
        return done(id, succeeded(r), SLOT_MESSAGES.shape)
      }
      return { ok: false, error: SLOT_MESSAGES.unknown }
    },
    async remove(id) {
      let r: Reply | undefined
      try {
        if (id === SECRET_KEYS.cloudflare) r = await holders.cloudflare.disconnect()
        else if (id === SECRET_KEYS.recording) r = await holders.recording.clear()
        else return { ok: false, error: SLOT_MESSAGES.unknown }
      } catch { return { ok: false, error: SLOT_MESSAGES.remove } }
      return done(id, succeeded(r), SLOT_MESSAGES.remove)
    }
  }
}

/**
 * A key saved or removed by one of the app's own pages (Settings › Cloudflare's Save and Disconnect),
 * logged as the Accounts and keys page logs it (Sol review 1, #4): `record` is the store's
 * recordSecret, given connected / missing before and after, never the value; `changed` tells the
 * window's key list to read the slots again. The holder's reply is returned as it is; a change that
 * could not be logged is reported through `log` only (the key itself was saved or removed).
 */
export async function recordedKeyChange<R extends Reply>(opts: {
  has(): boolean
  run(): Promise<R> | R
  record(from: 'connected' | 'missing', to: 'connected' | 'missing'): Promise<{ ok: boolean }>
  changed?(): void
  log?(line: string): void
}): Promise<R> {
  const status = (): 'connected' | 'missing' => { try { return opts.has() ? 'connected' : 'missing' } catch { return 'missing' } }
  const from = status()
  const reply = await opts.run()
  if (!succeeded(reply)) return reply
  const to = status()
  try {
    const r = await opts.record(from, to)
    if (!r.ok) opts.log?.('[settings] a key was changed, but the change could not be added to the list of changes')
  } catch {
    opts.log?.('[settings] a key was changed, but the change could not be added to the list of changes')
  }
  try { opts.changed?.() } catch { /* the window reads the slots again when it is next focused */ }
  return reply
}
