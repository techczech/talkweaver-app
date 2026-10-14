import { adminBearer, matchAdminKey } from './admin-keys'

export interface Env {
  LIVE_SESSIONS: DurableObjectNamespace
  SESSION_REGISTRY: DurableObjectNamespace
  SHARED_TALKS: DurableObjectNamespace
  RUN_SHARES: DurableObjectNamespace
  RUN_PREWORK: DurableObjectNamespace
  /**
   * The first computer's admin key (0.38.2 and earlier). Every other computer has its own, a secret
   * named `ADMIN_SECRET_<computer id>`; `admin-keys.ts` says which names count. Absent once that
   * computer's access has been removed.
   */
  ADMIN_SECRET?: string
  /**
   * The signing key of a live service set up by 0.38.2 or earlier. Absent on one set up since: the
   * registry object keeps the key then. Never read directly: `signingKey(env)` (`signing-key.ts`).
   */
  SESSION_SIGNING_SECRET?: string
  /** Local test Workers only: a shorter idle purge for pre-work (ms). Unset in every deployment. */
  PREWORK_IDLE_PURGE_MS?: string
  /**
   * Local Workers only (`wrangler dev`, set by the app's local Worker and the test harness): requests
   * without `cf-connecting-ip` share one pre-work source. Unset in every deployment, where such a
   * submission is refused (503) rather than put in one shared bucket.
   */
  PREWORK_LOCAL_SOURCE?: string
}

export const REGISTRY_NAME = 'talkweaver-session-registry'

/** What every hibernating socket carries, for LiveSession and SharedTalk alike. */
export interface SocketAttachment<Role extends string> {
  role: Role
  connectionId: string
}

/** The registry's internal route for a talk slug's shared talk. */
export function registryShareUrl(talkSlug: string, shareId?: string): string {
  const query = shareId === undefined ? '' : `?shareId=${encodeURIComponent(shareId)}`
  return `https://internal/internal/share/${encodeURIComponent(talkSlug)}${query}`
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

export function errorResponse(code: string, message: string, status: number, details: Record<string, unknown> = {}): Response {
  return jsonResponse({ error: { code, message }, ...details }, status)
}

export function cors(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('access-control-allow-origin', '*')
  headers.set('access-control-allow-headers', 'authorization, content-type')
  headers.set('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export function registryStub(env: Env): DurableObjectStub {
  return env.SESSION_REGISTRY.get(env.SESSION_REGISTRY.idFromName(REGISTRY_NAME))
}

export function bearerToken(request: Request): string | null {
  return request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null
}

/**
 * The computer whose admin key the request carries (`legacy` for `ADMIN_SECRET`), or null when it
 * carries none that this live service accepts. Truthy exactly when the request is an admin's.
 * The id is for recording who did something; it never goes in a refusal.
 */
export async function adminAuthorised(request: Request, env: Env): Promise<string | null> {
  return matchAdminKey(adminBearer(request), env)
}

export function validTalkSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(value)
}

export type JsonBody = { value: unknown } | { tooLarge: true } | { invalid: true }

/**
 * Read a body without ever holding more than `maxBytes` of it: a declared Content-Length over the
 * cap is refused unread, and a chunked body is cancelled as soon as it passes the cap. Returns
 * null when the body is too large.
 */
export async function readBoundedBytes(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const declared = request.headers.get('content-length')
  if (declared !== null && Number(declared) > maxBytes) return null
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export async function readJsonBody(request: Request, maxBytes: number): Promise<JsonBody> {
  const bytes = await readBoundedBytes(request, maxBytes)
  if (!bytes) return { tooLarge: true }
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) }
  } catch {
    return { invalid: true }
  }
}
