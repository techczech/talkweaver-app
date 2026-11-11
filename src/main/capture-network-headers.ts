/** Additional capture-only restrictions; existing CSP/framing headers are retained verbatim. */
export const CAPTURE_NETWORK_CSP = "connect-src 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'"
export function captureResponseHeaders(original: Record<string, string[]> = {}): Record<string, string[]> {
  const headers = { ...original }
  const csp = Object.keys(headers).find(key => key.toLowerCase() === 'content-security-policy') ?? 'Content-Security-Policy'
  headers[csp] = [...(headers[csp] ?? []), CAPTURE_NETWORK_CSP]
  for (const [name, value] of [['X-DNS-Prefetch-Control', 'off'], ['Alt-Svc', 'clear']]) {
    for (const key of Object.keys(headers)) if (key.toLowerCase() === name.toLowerCase()) delete headers[key]
    headers[name] = [value]
  }
  return headers
}
