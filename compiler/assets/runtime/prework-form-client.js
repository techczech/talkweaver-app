// The pre-work form's line to the Worker (feedback-boards ticket 10): the two public routes a participant
// uses, `POST /prework/<id>/mine` ("coming back later") and `POST /prework/<id>/submit`. Self-contained
// like every runtime function the page embeds by `.toString()` (see prework-form.js).
import { normalisePreworkEntries } from './prework-form-model.js'

/**
 * The Worker's public routes for one pre-work. Options: fetch, workerBaseUrl, preworkId.
 * `load(participantId)` → { ok, entries }; `submit(key, body)` → { ok, status, code?, retryAfterMs?, data? }.
 * Submissions with the same key run one at a time in order and only the newest waiting one is kept, so a
 * quick change of answer never lands before the one it replaces.
 * @param {any} options
 */
export function createPreworkClient(options) {
  const base = String(options.workerBaseUrl || '').replace(/\/+$/, '') + '/prework/' + encodeURIComponent(String(options.preworkId || ''))
  const fetchImpl = options.fetch
  const slots = new Map()
  async function post(path, body) {
    try {
      const response = await fetchImpl(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store', credentials: 'omit' })
      let data = null
      try { data = await response.json() } catch (_) { data = null }
      if (response.ok) return { ok: true, status: response.status, data }
      const error = data && typeof data === 'object' && data.error ? data.error : {}
      const wait = data && typeof data === 'object' ? Number(data.retryAfterMs) : NaN
      return { ok: false, status: response.status, code: typeof error.code === 'string' ? error.code : undefined, retryAfterMs: Number.isFinite(wait) ? wait : undefined }
    } catch (_) {
      return { ok: false, status: 0, code: 'network' }
    }
  }
  async function run(slot, body, resolve) {
    slot.busy = true
    const result = await post('/submit', body)
    slot.busy = false
    resolve(result)
    if (slot.next) {
      const next = slot.next
      slot.next = null
      run(slot, next.body, next.resolve)
    }
  }
  return {
    async load(participantId) {
      const result = await post('/mine', { participantId })
      return result.ok ? { ok: true, entries: normalisePreworkEntries(result.data) } : { ok: false, entries: [] }
    },
    submit(key, body) {
      return new Promise((resolve) => {
        let slot = slots.get(key)
        if (!slot) { slot = { busy: false, next: null }; slots.set(key, slot) }
        if (slot.busy) {
          if (slot.next) slot.next.resolve({ ok: true, status: 200, superseded: true })
          slot.next = { body, resolve }
          return
        }
        run(slot, body, resolve)
      })
    },
  }
}

export function preworkFormClientSource() {
  return createPreworkClient.toString()
}
