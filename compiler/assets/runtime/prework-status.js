// Pre-work on the published handout (ADR-0032 amendment point 2; feedback-boards ticket 09): the page
// asks the live Worker whether its Run's pre-work is open — the way it asks whether a talk is live —
// and says so on the page, so the form (ticket 10) can take the place of the slide list while it is.
// Each function is embedded in the page by `.toString()` (see preworkStatusRuntimeSource), so every
// function here is self-contained: no module-level constants, no imports.
//
//  - preworkStatusUrl(config)          the public status route for the handout's pre-work
//  - normalisePreworkStatus(value)     the Worker's answer, or null when it is not one
//  - createPreworkStatus(options)      asks once on load, then marks the page:
//                                      body[data-prework] = not_yet | open | closed | none, and a
//                                      `tw:prework-status` event on document carrying the status and
//                                      the handout's form and step slides
//
// The status carries no form and no answers; the form is the one the handout was built with.

/** @param {{ workerBaseUrl: string, preworkId: string }} config */
export function preworkStatusUrl(config) {
  return String(config.workerBaseUrl || '').replace(/\/+$/, '') + '/prework/' + encodeURIComponent(String(config.preworkId || ''))
}

/**
 * @param {unknown} value
 * @returns {{ state: 'not_yet' | 'open' | 'closed', opensAt: number, closesAt: number, people?: number } | null}
 */
export function normalisePreworkStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const state = value.state
  if (state !== 'not_yet' && state !== 'open' && state !== 'closed') return null
  if (!Number.isSafeInteger(value.opensAt) || !Number.isSafeInteger(value.closesAt)) return null
  const status = { state, opensAt: value.opensAt, closesAt: value.closesAt }
  if (Number.isSafeInteger(value.people) && value.people >= 0) status.people = value.people
  return status
}

/**
 * @param {{ document: Document, config: { workerBaseUrl: string, preworkId: string, form: unknown } | null,
 *   fetch?: typeof fetch, onStatus?: (status: object | null) => void }} options
 */
export function createPreworkStatus(options) {
  const doc = options.document
  const config = options.config
  if (!config || !config.workerBaseUrl || !config.preworkId) return null
  const fetchImpl = options.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null)
  let current = null
  function steps() {
    const template = doc.getElementById('preworkSteps')
    return template && template.content ? Array.from(template.content.querySelectorAll('.slide')) : []
  }
  function mark(status) {
    current = status
    if (doc.body) doc.body.dataset.prework = status ? status.state : 'none'
    const detail = { status, form: config.form, steps: steps() }
    if (typeof options.onStatus === 'function') options.onStatus(status)
    try { doc.dispatchEvent(new CustomEvent('tw:prework-status', { detail })) } catch (_) { /* an old engine without CustomEvent */ }
  }
  async function check() {
    if (!fetchImpl) { mark(null); return null }
    try {
      const response = await fetchImpl(preworkStatusUrl(config), { cache: 'no-store', credentials: 'omit' })
      mark(response.ok ? normalisePreworkStatus(await response.json()) : null)
    } catch (_) {
      mark(null)
    }
    return current
  }
  return { check, status: () => current, steps }
}

export function preworkStatusRuntimeSource() {
  return [preworkStatusUrl, normalisePreworkStatus, createPreworkStatus].map((fn) => fn.toString()).join('\n')
}
