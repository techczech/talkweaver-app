import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The actual application's NSMenu Quit item (terminate:), without focusing the app or sending
// physical keys. N-API keeps this tiny test addon independent of Electron's V8 ABI.
export function buildNativeQuitMenu(directory) {
  if (process.platform !== 'darwin') return null
  const headers = [resolve(dirname(process.execPath), '../include/node'), '/opt/homebrew/include/node', '/usr/local/include/node']
    .find(path => existsSync(join(path, 'node_api.h')))
  if (!headers) throw Error('Native Quit regression needs Node development headers (node_api.h)')
  const addon = join(directory, 'native-quit-menu.node')
  execFileSync('clang++', ['-std=c++17', '-shared', '-undefined', 'dynamic_lookup', '-fobjc-arc', '-framework', 'Cocoa',
    '-I', headers, fileURLToPath(new URL('native-quit-menu.mm', import.meta.url)), '-o', addon], { stdio: 'inherit' })
  return addon
}
