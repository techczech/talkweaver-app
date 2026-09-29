import { constantTimeEqual, hashSecret } from './auth'

export interface Env {
  LIVE_SESSIONS: DurableObjectNamespace
  SESSION_REGISTRY: DurableObjectNamespace
  SHARED_TALKS: DurableObjectNamespace
  ADMIN_SECRET: string
  SESSION_SIGNING_SECRET: string
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

export async function adminAuthorised(request: Request, env: Env): Promise<boolean> {
  const bearer = bearerToken(request)
  return Boolean(bearer) && constantTimeEqual(await hashSecret(bearer!), await hashSecret(env.ADMIN_SECRET))
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
