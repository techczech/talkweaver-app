import { describe, expect, test } from 'bun:test'
import { createLiveWorkerCloudflareTokenResolver } from '../src/main/live-worker-cloudflare-token'

describe('live Worker Cloudflare token resolver', () => {
  test('loads the BWS access token from Keychain and selects only the named Worker secret', async () => {
    const calls: Array<{ file: string; args: string[]; env?: NodeJS.ProcessEnv }> = []
    const resolveToken = createLiveWorkerCloudflareTokenResolver({
      env: {},
      username: 'test-user',
      homeDir: '/Users/test-user',
      execFile: async (file, args, options) => {
        calls.push({ file, args, env: options.env })
        if (file === 'security') return { stdout: 'fake-bws-access-token\n', stderr: '' }
        if (file === 'bws') {
          return {
            stdout: JSON.stringify([
              { id: 'other-id', key: 'CLOUDFLARE-PAGES-TOKEN', value: 'wrong-pages-token' },
              { id: 'worker-id', key: 'CLOUDFLARE-WORKER-TALKWEAVERLIVE', value: 'right-worker-token' },
              { id: 'another-id', key: 'UNRELATED', value: 'wrong-unrelated-token' },
            ]),
            stderr: '',
          }
        }
        throw new Error(`Unexpected executable: ${file}`)
      },
    })

    expect(await resolveToken()).toBe('right-worker-token')
    expect(await resolveToken()).not.toBe('wrong-pages-token')
    expect(await resolveToken()).not.toBe('wrong-unrelated-token')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({
      file: 'security',
      args: ['find-generic-password', '-w', '-s', 'BWS_ACCESS_TOKEN', '-a', 'test-user'],
    })
    expect(calls[1]).toMatchObject({
      file: 'bws',
      args: ['secret', 'list', '--output', 'json'],
    })
    expect(calls[1].env?.BWS_ACCESS_TOKEN).toBe('fake-bws-access-token')
  })
})
