import { describe, expect, test } from 'bun:test'
import { readJsonBody } from './http'

function streamed(parts: string[]): Request {
  const encoder = new TextEncoder()
  let pulled = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled < parts.length) controller.enqueue(encoder.encode(parts[pulled++]))
      else controller.close()
    },
  })
  return new Request('https://worker.test/x', { method: 'POST', body, duplex: 'half' } as RequestInit)
}

describe('bounded JSON body reader', () => {
  test('reads a body under the cap', async () => {
    expect(await readJsonBody(new Request('https://worker.test/x', { method: 'POST', body: '{"a":1}' }), 64)).toEqual({ value: { a: 1 } })
  })

  test('refuses a declared Content-Length over the cap without reading it', async () => {
    const request = new Request('https://worker.test/x', { method: 'POST', body: '{}', headers: { 'content-length': '999999' } })
    expect(await readJsonBody(request, 64)).toEqual({ tooLarge: true })
  })

  test('stops a chunked body with no Content-Length as soon as it passes the cap', async () => {
    const parts = ['{"text":"', 'x'.repeat(40), 'x'.repeat(40), 'x'.repeat(40), '"}']
    const request = streamed(parts)
    expect(request.headers.get('content-length')).toBeNull()
    expect(await readJsonBody(request, 64)).toEqual({ tooLarge: true })
  })

  test('reports invalid JSON and multi-byte text split across chunks', async () => {
    expect(await readJsonBody(new Request('https://worker.test/x', { method: 'POST', body: 'nope' }), 64)).toEqual({ invalid: true })
    const bytes = new TextEncoder().encode('{"t":"😀é"}')
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 7))
        controller.enqueue(bytes.slice(7))
        controller.close()
      },
    })
    expect(await readJsonBody(new Request('https://worker.test/x', { method: 'POST', body, duplex: 'half' } as RequestInit), 64)).toEqual({ value: { t: '😀é' } })
  })
})
