export interface AccessTokenPayload {
  role: 'presenter'
  sessionId: string
  exp: number
}

const encoder = new TextEncoder()

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function base64UrlEncode(value: string): string {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function base64UrlDecode(value: string): string {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  return atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value))
  return base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)))
}

export async function hashSecret(secret: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(secret.trim()))))
}

export async function createSignedToken(payload: AccessTokenPayload, secret: string): Promise<string> {
  const body = base64UrlEncode(JSON.stringify(payload))
  return `${body}.${await hmac(body, secret)}`
}

export async function verifySignedToken(token: string | null, secret: string, now = Date.now()): Promise<AccessTokenPayload | null> {
  if (!token) return null
  const [body, signature, extra] = token.split('.')
  if (!body || !signature || extra || !constantTimeEqual(signature, await hmac(body, secret))) return null
  try {
    const payload = JSON.parse(base64UrlDecode(body)) as AccessTokenPayload
    if (payload.role !== 'presenter' || !payload.sessionId || !payload.exp || payload.exp <= now) return null
    return payload
  } catch {
    return null
  }
}

/**
 * Owner token for a shared talk. It carries no expiry: the share's own lifecycle (Stop sharing,
 * idle retirement) ends it, and a closed share refuses every owner route. The role field keeps
 * owner and presenter tokens from standing in for each other.
 */
export interface OwnerTokenPayload {
  role: 'owner'
  shareId: string
  iat: number
}

export async function createOwnerToken(payload: OwnerTokenPayload, secret: string): Promise<string> {
  const body = base64UrlEncode(JSON.stringify(payload))
  return `${body}.${await hmac(body, secret)}`
}

export async function verifyOwnerToken(token: string | null, secret: string, shareId: string): Promise<OwnerTokenPayload | null> {
  if (!token) return null
  const [body, signature, extra] = token.split('.')
  if (!body || !signature || extra || !constantTimeEqual(signature, await hmac(body, secret))) return null
  try {
    const payload = JSON.parse(base64UrlDecode(body)) as OwnerTokenPayload
    if (payload.role !== 'owner' || payload.shareId !== shareId || typeof payload.iat !== 'number') return null
    return payload
  } catch {
    return null
  }
}

/**
 * Owner token for a Run's read-only share link (ticket 06). A role of its own, so a shared talk's
 * owner token can never stand in for it (or the other way round), even for a share id that exists in
 * both namespaces. No expiry: the link's own lifetime and Stop sharing end it.
 */
export interface ResultsOwnerTokenPayload {
  role: 'results-owner'
  shareId: string
  iat: number
}

export async function createResultsOwnerToken(payload: ResultsOwnerTokenPayload, secret: string): Promise<string> {
  const body = base64UrlEncode(JSON.stringify(payload))
  return `${body}.${await hmac(body, secret)}`
}

export async function verifyResultsOwnerToken(token: string | null, secret: string, shareId: string): Promise<ResultsOwnerTokenPayload | null> {
  if (!token) return null
  const [body, signature, extra] = token.split('.')
  if (!body || !signature || extra || !constantTimeEqual(signature, await hmac(body, secret))) return null
  try {
    const payload = JSON.parse(base64UrlDecode(body)) as ResultsOwnerTokenPayload
    if (payload.role !== 'results-owner' || payload.shareId !== shareId || typeof payload.iat !== 'number') return null
    return payload
  } catch {
    return null
  }
}

/**
 * Owner token for a planned Run's pre-work (feedback-boards ticket 09). A role of its own, so neither a
 * shared talk's nor a results link's owner token can stand in for it, even for an id that exists in
 * several namespaces. No expiry: the object's own idle purge ends it.
 */
export interface PreworkOwnerTokenPayload {
  role: 'prework-owner'
  preworkId: string
  iat: number
}

export async function createPreworkOwnerToken(payload: PreworkOwnerTokenPayload, secret: string): Promise<string> {
  const body = base64UrlEncode(JSON.stringify(payload))
  return `${body}.${await hmac(body, secret)}`
}

export async function verifyPreworkOwnerToken(token: string | null, secret: string, preworkId: string): Promise<PreworkOwnerTokenPayload | null> {
  if (!token) return null
  const [body, signature, extra] = token.split('.')
  if (!body || !signature || extra || !constantTimeEqual(signature, await hmac(body, secret))) return null
  try {
    const payload = JSON.parse(base64UrlDecode(body)) as PreworkOwnerTokenPayload
    if (payload.role !== 'prework-owner' || payload.preworkId !== preworkId || typeof payload.iat !== 'number') return null
    return payload
  } catch {
    return null
  }
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return difference === 0
}
