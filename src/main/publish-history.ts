import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { publishStageLabel, type PublishHistoryAttempt, type PublishHistoryEvent } from '../shared/publish-history.ts'
import { publishStepLabels, redactPublishText, type PublishDiagnostic } from '../shared/publish-diagnostic.ts'

type Source = { path: string; key: string }
export type StoredPublishEvent = PublishHistoryEvent & { sourceOutline?: Source }
type StoredPublishAttempt = PublishHistoryAttempt & { sourceOutline?: Source }

const MAX_ATTEMPTS = 50
const MAX_BYTES = 1024 * 1024
const text = (value: unknown, max = 200): value is string => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value)
const outcomes = new Set(['published', 'unchanged', 'rehearsed', 'stopped', 'unknown', 'unexpected-error', 'failed', 'cancelled'])
const diagnosticKinds = new Set(['http', 'timeout', 'network', 'response', 'local', 'cancelled'])
const count = (value: number): boolean => Number.isSafeInteger(value) && value >= 0
const validSource = (source: Source): boolean => !!source && text(source.path, 8192) && text(source.key, 100) && /^\d+:\d+$/u.test(source.key)
function validDiagnostic(value: PublishDiagnostic): boolean {
  return !!value && Object.hasOwn(publishStepLabels, value.step) && diagnosticKinds.has(value.kind)
    && [value.attempt, value.filesAcknowledged, value.filesTotal, value.filesSent, value.bytesSent, value.elapsedMs].every(count)
    && value.filesSent <= value.filesAcknowledged && value.filesAcknowledged <= value.filesTotal
    && (value.batch === undefined && value.batches === undefined || value.step === 'upload'
      && value.batch !== undefined && value.batches !== undefined && count(value.batch) && count(value.batches) && value.batch > 0 && value.batch <= value.batches)
    && (value.status === undefined || count(value.status) && value.status >= 100 && value.status <= 599)
    && (value.timeoutMs === undefined || count(value.timeoutMs))
    && (value.retryAfterMs === undefined || count(value.retryAfterMs))
    && (value.networkCode === undefined || text(value.networkCode, 40) && /^[A-Z_]+$/u.test(value.networkCode))
    && (value.cause === undefined || text(value.cause, 480))
    && (value.signIn === undefined || value.signIn === true)
    && (value.uncertain === undefined || value.uncertain === true)
    && (value.viaIntermediary === undefined || value.viaIntermediary === true)
    && (value.untouched === undefined || value.untouched === true)
    && (value.published === undefined || value.published === true)
    && (value.cloudflareErrors === undefined || Array.isArray(value.cloudflareErrors) && value.cloudflareErrors.length <= 5
      && value.cloudflareErrors.every(error => error && (error.code === undefined || Number.isSafeInteger(error.code))
        && (error.message === undefined || text(error.message, 480))))
}

function cleanDiagnostic(value: PublishDiagnostic): PublishDiagnostic {
  const { step, attempt, batch, batches, kind, status, networkCode, timeoutMs, retryAfterMs, cloudflareErrors,
    filesAcknowledged, filesTotal, filesSent, bytesSent, elapsedMs, cause, uncertain, signIn, viaIntermediary, untouched, published } = value
  return {
    step, attempt, kind, filesAcknowledged, filesTotal, filesSent, bytesSent, elapsedMs,
    ...(batch === undefined ? {} : { batch, batches }),
    ...(status === undefined ? {} : { status }),
    ...(networkCode ? { networkCode } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(cloudflareErrors ? { cloudflareErrors: cloudflareErrors.map(({ code, message }) => ({
      ...(code === undefined ? {} : { code }), ...(message === undefined ? {} : { message: redactPublishText(message) }),
    })) } : {}),
    ...(cause === undefined ? {} : { cause: redactPublishText(cause) }),
    ...(uncertain ? { uncertain } : {}),
    ...(signIn ? { signIn } : {}),
    ...(viaIntermediary ? { viaIntermediary } : {}),
    ...(untouched ? { untouched } : {}),
    ...(published ? { published } : {}),
  }
}

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
    && (event.diagnostic === undefined || (event.stage === 'finished' && validDiagnostic(event.diagnostic)))
}
/** Damaged existing files are preserved; an optional history failure must not stop publishing. */
export function createPublishHistory(path: string) {
  function read(): StoredPublishAttempt[] {
    if (!existsSync(path)) return []
    if (statSync(path).size > MAX_BYTES) throw new Error('Publishing history could not be read')
    const content = readFileSync(path, 'utf8')
    let parsed
    try { parsed = JSON.parse(content) } catch { throw new Error('Publishing history is not valid JSON') }
    if (parsed?.version !== 1 || !Array.isArray(parsed.attempts) || parsed.attempts.length > MAX_ATTEMPTS
      || parsed.attempts.some((a: StoredPublishAttempt) => !a || !text(a.id) || !text(a.startedAt) || !Number.isFinite(Date.parse(a.startedAt))
        || !text(a.computer, 120) || !text(a.appVersion, 80) || !text(a.entry) || (a.site !== undefined && !text(a.site))
        || (a.sourceOutline !== undefined && !validSource(a.sourceOutline))
        || (a.outcome !== undefined && !outcomes.has(a.outcome)) || !Array.isArray(a.events) || a.events.length > 30 || a.events.some(event => !validEvent(event, a.id)))) throw new Error('Publishing history could not be read')
    // Reconstruct the public shape; arbitrary damaged/imported properties never reach the renderer.
    return parsed.attempts.map((a: StoredPublishAttempt) => ({ id: a.id, startedAt: a.startedAt, computer: a.computer, appVersion: a.appVersion,
      entry: a.entry, ...(a.site ? {site:a.site} : {}), ...(a.outcome ? {outcome:a.outcome} : {}),
      ...(a.sourceOutline ? { sourceOutline: { path: a.sourceOutline.path, key: a.sourceOutline.key } } : {}), events: a.events.map(event => ({
        attemptId:event.attemptId, at:event.at, computer:event.computer, appVersion:event.appVersion, entry:event.entry, stage:event.stage,
        ...(event.site !== undefined ? {site:event.site} : {}), ...(event.revision !== undefined ? {revision:event.revision} : {}),
        ...(event.files !== undefined ? {files:event.files} : {}), ...(event.bytes !== undefined ? {bytes:event.bytes} : {}),
        ...(event.removed !== undefined ? {removed:event.removed} : {}), ...(event.missing !== undefined ? {missing:event.missing} : {}), ...(event.folders !== undefined ? {folders:event.folders} : {}),
        ...(event.recordPresent !== undefined ? {recordPresent:event.recordPresent} : {}), ...(event.outcome !== undefined ? {outcome:event.outcome} : {}),
        ...(event.linksReconciled !== undefined ? {linksReconciled:event.linksReconciled} : {}), ...(event.linkStyleChanged !== undefined ? {linkStyleChanged:event.linkStyleChanged} : {}),
        ...(event.diagnostic ? { diagnostic: cleanDiagnostic(event.diagnostic) } : {}),
      })) }))
  }
  function retryable(attempt: StoredPublishAttempt): boolean {
    return attempt.entry === 'talk' && !!attempt.sourceOutline && (attempt.outcome === 'failed' || attempt.outcome === 'cancelled' || attempt.outcome === 'unknown')
  }
  function publicAttempt({ sourceOutline, ...attempt }: StoredPublishAttempt): PublishHistoryAttempt {
    return { ...attempt, ...(retryable({ ...attempt, sourceOutline }) ? { canRetry: true } : {}) }
  }
  function list(): PublishHistoryAttempt[] {
    return read().map(publicAttempt)
  }
  function forOutline(key: string): PublishHistoryAttempt[] {
    return read().filter(row => row.entry === 'talk' && row.sourceOutline?.key === key).map(publicAttempt)
  }
  function retrySource(id: string): (Source & { site?: string }) | undefined {
    const attempt = read().find(row => row.id === id && retryable(row))
    return attempt?.sourceOutline ? { ...attempt.sourceOutline, site: attempt.site } : undefined
  }
  function record({ sourceOutline, ...event }: StoredPublishEvent): void {
    if (!validEvent(event, event.attemptId)) throw new Error('Publishing history event is invalid')
    const attempts = read()
    let attempt = attempts.find(row => row.id === event.attemptId)
    if (!attempt) {
      attempt = { id: event.attemptId, startedAt: event.at, computer: event.computer, appVersion: event.appVersion, entry: event.entry, events: [],
        ...(sourceOutline && validSource(sourceOutline) ? { sourceOutline: { path: sourceOutline.path, key: sourceOutline.key } } : {}) }
      attempts.unshift(attempt)
    }
    attempt.events.push(event.diagnostic ? { ...event, diagnostic: cleanDiagnostic(event.diagnostic) } : event)
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
  return { list, forOutline, record, retrySource }
}
