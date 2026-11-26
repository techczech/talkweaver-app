export const publishStepLabels = {
  preparing: 'Prepare the handout',
  token: 'Get the Cloudflare upload token',
  live: 'Check the going-live service',
  inventory: 'Check the published site',
  building: 'Build the handout',
  'check-missing': 'Check which files Cloudflare already has',
  upload: 'Upload files',
  'upsert-hashes': 'Refresh Cloudflare’s file cache',
  deployment: 'Send the deployment',
  confirm: 'Confirm the deployment',
  finishing: 'Update this Mac’s copy',
} as const

export type PublishStep = keyof typeof publishStepLabels
export type PublishLocation = { step: PublishStep; batch?: number; batches?: number; attempt: number }
export type PublishProgress = PublishLocation & {
  filesAcknowledged: number
  filesTotal: number
  filesSent: number
  bytesSent: number
  canCancel: boolean
  retry?: { delayMs: number; nextAttempt: number; maxAttempts: number; at: number }
}
export type CliPublishUpdate = { outlinePath: string } & (
  { kind: 'progress'; progress: PublishProgress }
  | { kind: 'finished'; url?: string; diagnostic?: PublishDiagnostic }
)
export type PublishDiagnostic = PublishLocation & {
  kind: 'http' | 'timeout' | 'network' | 'response' | 'local' | 'cancelled'
  status?: number
  networkCode?: string
  timeoutMs?: number
  retryAfterMs?: number
  cloudflareErrors?: { code?: number; message?: string }[]
  filesAcknowledged: number
  filesTotal: number
  filesSent: number
  bytesSent: number
  elapsedMs: number
  cause?: string
  uncertain?: true
  signIn?: true
  viaIntermediary?: true
  untouched?: true
  published?: true
}

export function interruptedPublishDiagnostic(cause?: string): PublishDiagnostic {
  return {
    step: 'preparing', kind: 'local', attempt: 0, filesAcknowledged: 0, filesTotal: 0, filesSent: 0, bytesSent: 0, elapsedMs: 0,
    ...(cause ? { cause: redactPublishText(cause) } : { uncertain: true }),
  }
}

/** Filter text before storage, IPC, display or clipboard use. Never pass a raw request or response here. */
export function redactPublishText(value: string, known: readonly string[] = []): string {
  if (value.length > 16_384) return '[Diagnostic text exceeded the length limit]'
  let safe = value
  for (const credential of known) {
    if (credential) {
      safe = safe.replaceAll(credential, '[redacted]')
        .replaceAll(encodeURIComponent(credential), '[redacted]')
    }
  }
  return safe
    .replace(/\b(?:proxy[-_ ]?)?authorization\b["']?\s*[:=]\s*[^\r\n;,}]+/giu, '[redacted]')
    .replace(/\b(?:bearer|basic)\s+["']?[^\s,;"'<>}]+/giu, '[redacted]')
    .replace(/\b(?:x[-_ ]auth[-_ ](?:key|email)|(?:api|access|private|secret|session|upload|cloudflare)[-_ ](?:key|token|secret)|token|jwt|password|credential|secret)\b["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;,}&<]+)/giu, '[redacted]')
    .replace(/\b(?:eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*){1,4}|[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,})\b/gu, '[redacted]')
    .replace(/https?:\/\/[^\s<>"']+/giu, address => {
      try {
        const url = new URL(address)
        if (url.username || url.password || url.search || url.hash) return '[redacted URL]'
      } catch { return '[redacted URL]' }
      return address
    })
    .replace(/(?<![A-Za-z0-9])[a-f0-9]{32}(?![A-Za-z0-9])/giu, '[redacted]')
    .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40}(?![A-Za-z0-9_-])/gu, candidate =>
      /[A-Z]/u.test(candidate) && /[a-z]/u.test(candidate) && /\d/u.test(candidate) ? '[redacted]' : candidate)
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .trim().slice(0, 480)
}

export function redactPublishException(error: unknown, clean = (value: string): string => value): string {
  const reason = error instanceof Error ? `${error.name}: ${error.message}`
    : typeof error === 'string' ? `Error: ${error}` : 'Error: Unexpected publishing exception'
  return redactPublishText(clean(reason))
}

export function publishStepLabel(location: PublishLocation): string {
  if (location.step === 'upload' && location.batch && location.batches) return `Upload batch ${location.batch} of ${location.batches}`
  return publishStepLabels[location.step]
}

export function publishProgressText(progress: PublishProgress, unchangedMs: number): string {
  const bytes = progress.bytesSent < 1000 ? `${progress.bytesSent} B`
    : progress.bytesSent < 1_000_000 ? `${(progress.bytesSent / 1000).toFixed(1)} KB`
    : `${(progress.bytesSent / 1_000_000).toFixed(1)} MB`
  const files = progress.filesTotal
    ? ` · ${progress.filesAcknowledged} of ${progress.filesTotal} files ready · ${progress.filesSent} uploaded (${bytes})` : ''
  const attempt = progress.attempt ? ` · Attempt ${progress.attempt}` : ''
  const step = publishStepLabel(progress)
  if (progress.retry) {
    const { at, nextAttempt, maxAttempts } = progress.retry
    const remaining = Math.max(0, Math.ceil((at - Date.now()) / 1000))
    return `${step}${files}. Cloudflare is busy, retrying in ${remaining} s (attempt ${nextAttempt} of ${maxAttempts}).`
  }
  if (unchangedMs >= 30_000) {
    const waiting = progress.step === 'preparing' || progress.step === 'building'
      ? 'Still waiting for this Mac to finish'
      : progress.step === 'upload' ? 'Still waiting for Cloudflare to receive and acknowledge this batch'
      : 'Still waiting for Cloudflare to answer'
    return `${step}${files}${attempt}. ${waiting}.`
  }
  return `${step}${files}${attempt}…`
}

export function publishDiagnosticTitle(diagnostic: PublishDiagnostic): string {
  if (diagnostic.published) return 'Published with a warning'
  if (diagnostic.kind === 'cancelled') return 'Publish cancelled'
  if (diagnostic.uncertain) return 'Publish outcome unknown'
  return 'Publish failed'
}

function explainPublishDiagnostic(diagnostic: PublishDiagnostic): string {
  if (diagnostic.published) return 'Cloudflare confirmed the change. TalkWeaver could not finish updating this Mac’s copy.'
  const message = diagnostic.cloudflareErrors?.find(error => error.message)?.message
  const provider = message ? ` Cloudflare’s message: ${message}` : ''
  const step = publishStepLabel(diagnostic).toLowerCase()
  if (diagnostic.kind === 'cancelled') return 'You cancelled before the deployment was sent. Try again when you’re ready.'
  const intermediary = 'A network in between refused the upload (VPN, venue wi-fi or proxy).'
  if (diagnostic.uncertain) {
    const reason = diagnostic.viaIntermediary ? intermediary
      : diagnostic.cause ?? (diagnostic.status && diagnostic.status >= 400
        ? `Cloudflare returned HTTP ${diagnostic.status} during “${step}”.`
        : diagnostic.kind === 'timeout' ? `Cloudflare did not answer in time during “${step}”.`
        : diagnostic.kind === 'network' ? `The connection was interrupted during “${step}”.` : '')
    return `${reason ? reason + ' ' : ''}TalkWeaver could not confirm whether Cloudflare put this handout live. Check the site and try again later. TalkWeaver will check the earlier deployment before sending another.${provider}`
  }
  if (diagnostic.viaIntermediary) return `${intermediary} Check your connection or sign in to the network, then try again.`
  if (diagnostic.signIn) return `Cloudflare refused the publishing credentials. Check your token and its Pages permission in Settings → Cloudflare, then try again.${provider}`
  if (diagnostic.kind === 'timeout') {
    const duration = diagnostic.timeoutMs ? ` after ${Math.round(diagnostic.timeoutMs / 1000)} s` : ''
    return `Cloudflare did not answer${duration} during “${step}”. Check your internet connection and try again.`
  }
  if (diagnostic.kind === 'network') return `TalkWeaver lost its connection to Cloudflare during “${step}”. Check your internet connection and try again.`
  if (diagnostic.kind === 'http') {
    const advice = diagnostic.retryAfterMs === undefined ? 'Try again.'
      : diagnostic.retryAfterMs > 3_600_000 ? 'Cloudflare asked you to wait before trying again.'
      : `Try again after ${Math.ceil(diagnostic.retryAfterMs / 1000)} s.`
    return `Cloudflare refused or could not complete “${step}” (HTTP ${diagnostic.status}).${provider} ${advice} If it repeats, copy the details for support.`
  }
  return diagnostic.cause ?? `TalkWeaver could not complete “${step}”.${provider} Try again. If it repeats, copy the details for support.`
}

export function publishDiagnosticMessage(diagnostic: PublishDiagnostic): string {
  const message = explainPublishDiagnostic(diagnostic)
  return diagnostic.untouched ? `${message} Nothing on the live site changed.` : message
}

export function publishDiagnosticText(diagnostic: PublishDiagnostic): string {
  const lines = [
    publishDiagnosticTitle(diagnostic),
    `Step: ${publishStepLabel(diagnostic)}`,
    `Result: ${diagnostic.kind}${diagnostic.status === undefined ? '' : ` (HTTP ${diagnostic.status})`}${diagnostic.networkCode ? ` (${diagnostic.networkCode})` : ''}`,
    ...(diagnostic.timeoutMs === undefined ? [] : [`Request timeout: ${diagnostic.timeoutMs} ms`]),
    ...(diagnostic.retryAfterMs === undefined ? [] : [`Cloudflare asked to retry after: ${diagnostic.retryAfterMs} ms`]),
    `Attempts at this step: ${diagnostic.attempt}`,
    `Files acknowledged: ${diagnostic.filesAcknowledged} of ${diagnostic.filesTotal}`,
    `Assets uploaded: ${diagnostic.filesSent} files, ${diagnostic.bytesSent} bytes`,
    `Elapsed: ${diagnostic.elapsedMs} ms`,
    ...(diagnostic.cause ? [redactPublishText(diagnostic.cause)] : []),
    ...(diagnostic.cloudflareErrors ?? []).map(error => `Cloudflare${error.code === undefined ? '' : ` ${error.code}`}${error.message ? `: ${redactPublishText(error.message)}` : ''}`),
  ]
  return lines.join('\n')
}
