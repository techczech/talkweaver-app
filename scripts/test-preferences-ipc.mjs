import assert from 'node:assert/strict'
import { registerPreferencesIpc } from '../src/main/preferences-ipc.ts'
import { readMainSource, readSource } from './lib/read-source.mjs'

const expected = new Set(
  ['index.ts', 'settings.ts'].flatMap((file) => {
    const preload = readSource(new URL(`../src/preload/${file}`, import.meta.url))
    return [...preload.matchAll(/ipcRenderer\.invoke\(\s*['"`](preferences:[^'"`]+)['"`]/g)].map((match) => match[1])
  })
)

const registered = []
const ipcMain = { handle: (channel) => registered.push(channel) }
registerPreferencesIpc({
  ipcMain,
  handleFromSettingsWindow: (channel, _refused, handler) => ipcMain.handle(channel, handler),
})

assert.ok(expected.size > 0, 'the editor and Settings preloads expose preferences channels')
assert.deepEqual(registered.sort(), [...expected].sort(), 'each exposed channel registers exactly once')
const main = readSource(new URL('../src/main/index.ts', import.meta.url))
assert.equal([...main.matchAll(/^registerPreferencesIpc\(/gm)].length, 1, 'main calls the registrar once')
const outsideModule = readMainSource((code, file) => file === 'src/main/preferences-ipc.ts' ? '' : code)
assert.doesNotMatch(outsideModule, /(?:\.handle|\bhandleFromSettingsWindow)\(\s*['"`]preferences:/)
console.log(`preferences IPC: all ${expected.size} preload channels register exactly once`)
