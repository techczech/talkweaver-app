import assert from 'node:assert/strict'
import { registerTalkIpc } from '../src/main/talk-ipc.ts'
import { registerVaultIpc } from '../src/main/vault-ipc.ts'
import { readMainSource, readSource } from './lib/read-source.mjs'

const preload = readSource(new URL('../src/preload/index.ts', import.meta.url))
const main = readSource(new URL('../src/main/index.ts', import.meta.url))
const guarded = main.indexOf('applyMainFrameOnly(ipcMain)')
const ready = main.indexOf('app.whenReady().then(')
assert.ok(guarded >= 0 && ready > guarded)

function checkRegistration(namespace, registrar, register, requiredChannels = []) {
  const registrations = (source, pattern) => [...source.matchAll(pattern)]
    .filter((match) => match[2].startsWith(`${namespace}:`))
    .map((match) => `${match[1] === 'on' ? 'send' : match[1] === 'handle' ? 'invoke' : match[1]}:${match[2]}`)
  const expected = new Set(registrations(preload, /ipcRenderer\.(invoke|send)\(\s*['"`]([^'"`]+)['"`]/g))
  assert.ok(expected.size > 0, `the preload exposes ${namespace} commands`)

  const registered = []
  register({
    ipcMain: {
      handle: (channel) => registered.push(`invoke:${channel}`),
      on: (channel) => registered.push(`send:${channel}`),
    },
  })
  for (const channel of requiredChannels) {
    assert.ok(registered.includes(`invoke:${channel}`), `${channel} registers in ${namespace}-ipc.ts`)
  }
  const pattern = /\.(handle|on)\(\s*['"`]([^'"`]+)['"`]/g
  const modulePath = `src/main/${namespace}-ipc.ts`
  const module = readMainSource((code, path) => path === modulePath ? code : '')
  const outsideModule = readMainSource((code, path) => path === modulePath ? '' : code)
  assert.deepEqual(registered.sort(), registrations(module, pattern).sort(), 'all moved registrations are active')
  assert.deepEqual([...registered, ...registrations(outsideModule, pattern)].sort(), [...expected].sort(),
    'each preload command registers exactly once across main')
  assert.deepEqual(registrations(main, pattern), [], `index has no direct ${namespace} registrations`)
  const calls = [...main.matchAll(new RegExp(`^${registrar}\\(`, 'gm'))]
  assert.equal(calls.length, 1, 'main calls the registrar once')
  assert.ok(calls[0].index > guarded && calls[0].index < ready, 'registration is guarded and happens before app readiness')
  console.log(`${namespace} IPC: ${registered.length} moved, all ${expected.size} preload commands register exactly once`)
}

checkRegistration('vault', 'registerVaultIpc', registerVaultIpc)
checkRegistration('talk', 'registerTalkIpc', registerTalkIpc, [
  'talk:outline-plan-slide-merge',
  'talk:outline-apply-slide-merge',
])
