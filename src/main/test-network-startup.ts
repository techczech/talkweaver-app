// The second import of the app entry, straight after security-startup: decides once, before the
// single-instance lock and before anything reads the profile, whether the test-only network overrides
// may be honoured (test-network-guard.ts). Refused: the app says why on standard error and exits.
import { app } from 'electron'
import { readFileSync, realpathSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { permittedOverride, testNetworkPermit, type TestNetworkOverride } from './test-network-guard'

const permit = testNetworkPermit({
  packaged: app.isPackaged,
  env: process.env,
  userData: app.getPath('userData'),
  tempDirs: [tmpdir()],
  realpath: (path) => { try { return realpathSync(path) } catch { return null } },
  readMarker: (path) => { try { return readFileSync(path, 'utf8') } catch { return null } },
})
if (permit.state === 'refused') {
  try { writeSync(2, `${permit.reason}\n`) } catch { /* no reader */ }
  process.exit(1)
}

/** The one way the app reads a test-only network override: its value when permitted, else undefined. */
export function testNetworkOverride(name: TestNetworkOverride): string | undefined {
  return permittedOverride(permit, process.env, name)
}
