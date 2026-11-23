import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { publishStageLabel, type PublishHistoryAttempt, type PublishHistoryEvent } from '../shared/publish-history.ts'

const MAX_ATTEMPTS = 50
const MAX_BYTES = 1024 * 1024
const text = (value: unknown, max = 200): value is string => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value)
const outcomes = new Set(['published', 'unchanged', 'rehearsed', 'stopped', 'unknown', 'unexpected-error'])
function validEvent(event: PublishHistoryEvent, id: string): boolean {
  return !!event && event.attemptId === id && text(event.at) && Number.isFinite(Date.parse(event.at))
    && text(event.computer, 120) && text(event.appVersion, 80) && text(event.entry)
    && Object.hasOwn(publishStageLabel, event.stage)
    && (event.site === undefined || (text(event.site) && /^cf-pages:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/u.test(event.site)))
    && (event.revision === undefined || text(event.revision))
    && [event.files, event.bytes, event.removed, event.missing, event.linksReconciled].every(value => value === undefined || (Number.isSafeInteger(value) && value >= 0))
    && (event.folders === undefined || (Array.isArray(event.folders) && event.folders.length <= 100 && event.folders.every(folder => text(folder, 255))))
    && (event.recordPresent === undefined || typeof event.recordPresent === 'boolean')
    && (event.linkStyleChanged === undefined || typeof event.linkStyleChanged === 'boolean')
    && (event.outcome === undefined || outcomes.has(event.outcome))
}
/** Damaged existing files are preserved; an optional history failure must not stop publishing. */
export function createPublishHistory(path: string) {
  function list(): PublishHistoryAttempt[] {
    if (!existsSync(path)) return []
    if (statSync(path).size > MAX_BYTES) throw new Error('Publishing history could not be read')
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed?.version !== 1 || !Array.isArray(parsed.attempts) || parsed.attempts.length > MAX_ATTEMPTS
      || parsed.attempts.some((a: PublishHistoryAttempt) => !a || !text(a.id) || !text(a.startedAt) || !Number.isFinite(Date.parse(a.startedAt))
        || !text(a.computer, 120) || !text(a.appVersion, 80) || !text(a.entry) || (a.site !== undefined && !text(a.site))
        || (a.outcome !== undefined && !outcomes.has(a.outcome)) || !Array.isArray(a.events) || a.events.length > 30 || a.events.some(event => !validEvent(event, a.id)))) throw new Error('Publishing history could not be read')
    // Reconstruct the public shape; arbitrary damaged/imported properties never reach the renderer.
    return parsed.attempts.map((a: PublishHistoryAttempt) => ({ id: a.id, startedAt: a.startedAt, computer: a.computer, appVersion: a.appVersion,
      entry: a.entry, ...(a.site ? {site:a.site} : {}), ...(a.outcome ? {outcome:a.outcome} : {}), events: a.events.map(event => ({
        attemptId:event.attemptId, at:event.at, computer:event.computer, appVersion:event.appVersion, entry:event.entry, stage:event.stage,
        ...(event.site !== undefined ? {site:event.site} : {}), ...(event.revision !== undefined ? {revision:event.revision} : {}),
        ...(event.files !== undefined ? {files:event.files} : {}), ...(event.bytes !== undefined ? {bytes:event.bytes} : {}),
        ...(event.removed !== undefined ? {removed:event.removed} : {}), ...(event.missing !== undefined ? {missing:event.missing} : {}), ...(event.folders !== undefined ? {folders:event.folders} : {}),
        ...(event.recordPresent !== undefined ? {recordPresent:event.recordPresent} : {}), ...(event.outcome !== undefined ? {outcome:event.outcome} : {}),
        ...(event.linksReconciled !== undefined ? {linksReconciled:event.linksReconciled} : {}), ...(event.linkStyleChanged !== undefined ? {linkStyleChanged:event.linkStyleChanged} : {}),
      })) }))
  }
  function record(event: PublishHistoryEvent): void {
    if (!validEvent(event, event.attemptId)) throw new Error('Publishing history event is invalid')
    const attempts = list()
    let attempt = attempts.find(row => row.id === event.attemptId)
    if (!attempt) {
      attempt = { id: event.attemptId, startedAt: event.at, computer: event.computer, appVersion: event.appVersion, entry: event.entry, events: [] }
      attempts.unshift(attempt)
    }
    attempt.events.push(event)
    attempt.events = attempt.events.slice(-30)
    if (event.site) attempt.site = event.site
    if (event.outcome) attempt.outcome = event.outcome
    attempts.splice(MAX_ATTEMPTS)
    let text = JSON.stringify({ version: 1, attempts })
    while (Buffer.byteLength(text, 'utf8') > MAX_BYTES && attempts.length > 1) { attempts.pop(); text = JSON.stringify({ version: 1, attempts }) }
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('Publishing history is too large')
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${randomUUID()}.tmp`
    try { writeFileSync(temp, text, { mode: 0o600, flag: 'wx' }); renameSync(temp, path) }
    finally { rmSync(temp, { force: true }) }
  }
  return { list, record }
}
