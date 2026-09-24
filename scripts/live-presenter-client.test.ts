import { describe, expect, test } from 'bun:test'
import { createLivePresenterClient, presenterSocketUrl } from '../src/main/live-presenter-client'

describe('live presenter boundaries', () => {
  test('builds an authenticated recovery socket URL', () => {
    expect(presenterSocketUrl('https://live.example.test/', 'session 1', 'a+b')).toBe(
      'wss://live.example.test/sessions/session%201/presenter?token=a%2Bb&protocol=2')
  })
  test('transport opening alone cannot announce live or send queued poll controls', () => {
    const sent: string[] = []
    const socket = { readyState: 0, onopen: null as any, onclose: null as any, onerror: null as any,
      onmessage: null as any, send: (v: string) => sent.push(v), close() {} }
    const client = createLivePresenterClient({ baseUrl: 'https://live.example.test', sessionId: 'session-test',
      presenterToken: 'token', createSocket: () => socket, schedule: () => 1 as any, cancelSchedule() {} })
    client.sendPoll({ type: 'poll.close', pollId: 'poll-test' })
    socket.readyState = 1; socket.onopen()
    expect(client.status()).toBe('connecting')
    expect(sent).toEqual([])
    client.disconnect()
  })
})
