// A profile the test harness makes for this run (src/main/test-network-guard.ts): the app honours a
// test-only network override (TW_E2E_LIVE_SERVICE_URL, TW_E2E_CLOUDFLARE_API_BASE_URL,
// TW_E2E_RECORDING_ENDPOINT, TW_E2E_UPDATES_FEED, TW_E2E_LIVE_PAGE_ALLOW) only on a --user-data-dir inside
// the temporary folder that holds this run's marker. Without it the app refuses to start.
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// The same names as src/main/test-network-guard.ts (scripts/test-test-network-guard.mjs checks they agree).
export const TEST_PROFILE_MARKER_ENV = 'TW_E2E_PROFILE_MARKER'
export const TEST_PROFILE_MARKER_FILE = 'tw-e2e-profile-marker'

/**
 * Marks `userData` (a fresh folder inside the temporary folder; made if missing) as this run's test
 * profile. Returns the variables to add to the app's environment: the marker, and the temporary folder
 * so the app compares against the same one the harness used.
 */
export function testProfileEnv(userData) {
  mkdirSync(userData, { recursive: true })
  const marker = randomBytes(18).toString('base64url')
  writeFileSync(join(userData, TEST_PROFILE_MARKER_FILE), marker)
  const temp = tmpdir()
  return { [TEST_PROFILE_MARKER_ENV]: marker, ...(process.platform === 'win32' ? { TEMP: temp, TMP: temp } : { TMPDIR: temp }) }
}
