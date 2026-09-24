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
  if (!body || !signature || extra || signature !== await hmac(body, secret)) return null
  try {
    const payload = JSON.parse(base64UrlDecode(body)) as AccessTokenPayload
    if (payload.role !== 'presenter' || !payload.sessionId || !payload.exp || payload.exp <= now) return null
    return payload
  } catch {
    return null
  }
}
