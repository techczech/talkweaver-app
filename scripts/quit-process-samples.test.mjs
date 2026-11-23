import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { quitProcessTree, sampleQuitProcesses } from './lib/quit-process-samples.mjs'

test('samples the launched app tree, including reparented helpers, and excludes other apps', () => {
  const profile = '/fixture/with spaces/userData'
  const before = quitProcessTree(`
    30    20 Electron Helper (Renderer)
    99     1 Unrelated App
    10     1 Electron --user-data-dir=${profile}
    20    10 Electron Helper (GPU)
    27    10 Electron Helper (Utility)
  `, 10, profile)
  const after = quitProcessTree(`
    31    20 Electron Helper (New)
    20     1 Electron Helper (GPU)
    27     1 Another process with a reused PID
    40     1 Electron Helper --user-data-dir=${profile} --type=utility
    50     1 Electron Helper --user-data-dir=${profile}-other --type=utility
    30     1 Electron Helper (Renderer)
    10     1 Electron --user-data-dir=${profile}
    99     1 Unrelated App
  `, 10, profile, before)
  assert.deepEqual(after.map(row => row.pid), [31, 20, 40, 30, 10])
})

test('requests a three-second sample of each remaining PID and reports individual errors', async () => {
  const calls = []
  const folder = join('fixture', 'evidence')
  const file = pid => join(folder, `quit-${pid}.sample.txt`)
  const results = await sampleQuitProcesses([{ pid: 10 }, { pid: 20 }], folder, 'quit', async (command, args, options) => {
    calls.push({ command, args, options })
    if (args[0] === '20') throw Object.assign(new Error('sample failed'), { stderr: 'process already exited\n' })
  })
  assert.deepEqual(calls, [10, 20].map(pid => ({
    command: '/usr/bin/sample', args: [String(pid), '3', '-mayDie', '-file', file(pid)], options: { timeout: 45000 }
  })))
  assert.deepEqual(results, [{ pid: 10, file: file(10) }, { pid: 20, error: 'sample failed\nprocess already exited' }])
})
