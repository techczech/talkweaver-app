// One rule for every test-only network override (the TW_E2E_* variables that point the app at a
// stand-in on this computer's loopback address instead of a real service). Pure: no Electron, so it is
// unit-tested over a table (scripts/test-test-network-guard.mjs); test-network-startup.ts applies it.
//
// An override may be honoured only when all of these hold:
//   - the app is not packaged and was started as a test harness (TW_E2E=1);
//   - it runs on a profile the harness made for this run: the user-data folder lies inside the
//     temporary folder (not the temporary folder itself) and holds TEST_PROFILE_MARKER_FILE whose
//     content equals TEST_PROFILE_MARKER_ENV. A real profile never holds that file, so an app started
//     by hand with the test variables but without the harness's --user-data-dir is refused before it
//     reads a stored token or key that a stand-in could otherwise receive.
// An unpackaged TW_E2E=1 app that is given an override on any other profile is REFUSED: it does not
// run at all (test-network-startup.ts prints the reason and exits), so a misconfigured manual run
// fails loudly instead of quietly running with real endpoints under test variables.
// Each override's own address check (loopback 127.0.0.1 with an explicit port) stays with its module.
import { isAbsolute, join, relative } from 'node:path'

export const TEST_PROFILE_MARKER_ENV = 'TW_E2E_PROFILE_MARKER'
export const TEST_PROFILE_MARKER_FILE = 'tw-e2e-profile-marker'

/** Every test-only network override, and what it points elsewhere. */
export const TEST_NETWORK_OVERRIDES = [
  'TW_E2E_LIVE_SERVICE_URL', // https://*.workers.dev requests from the main process (the live service)
  'TW_E2E_CLOUDFLARE_API_BASE_URL', // the Cloudflare API (api.cloudflare.com/client/v4)
  'TW_E2E_RECORDING_ENDPOINT', // one more accepted recording (S3) endpoint for `setup recording`
  'TW_E2E_UPDATES_FEED', // the update feed
  'TW_E2E_LIVE_PAGE_ALLOW', // loopback host:ports a live web page or an embed preview may load
] as const
export type TestNetworkOverride = typeof TEST_NETWORK_OVERRIDES[number]

export type TestNetworkPermit =
  /** Packaged, not a test harness, or no override given: every override reads as unset. */
  | { state: 'inert' }
  | { state: 'granted' }
  /** An override was given on a profile the harness did not make: the app must not start. */
  | { state: 'refused'; reason: string }

export interface TestProfileFacts {
  packaged: boolean
  env: Readonly<Record<string, string | undefined>>
  /** The user-data folder the app will use (app.getPath('userData')). */
  userData: string
  /** The temporary folder(s) a harness profile may sit in. */
  tempDirs: readonly string[]
  /** The resolved path, or null when it does not exist. */
  realpath: (path: string) => string | null
  /** The marker file's text, or null when there is none. */
  readMarker: (path: string) => string | null
}

const MARKER_SHAPE = /^[A-Za-z0-9_-]{16,128}$/

/** True when `path` lies strictly inside `folder` (both resolved). */
function strictlyInside(path: string, folder: string): boolean {
  const rel = relative(folder, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Whether the test-only network overrides may be honoured in this process. */
export function testNetworkPermit(facts: TestProfileFacts): TestNetworkPermit {
  if (facts.packaged || facts.env.TW_E2E !== '1') return { state: 'inert' }
  const asked = TEST_NETWORK_OVERRIDES.filter((name) => (facts.env[name] ?? '') !== '')
  if (asked.length === 0) return { state: 'inert' }
  const refuse = (why: string): TestNetworkPermit => ({
    state: 'refused',
    reason: `TalkWeaver (test mode) will not start with ${asked.join(', ')}: ${why}. These test-only overrides `
      + `work only on a profile the test harness made for this run: a fresh --user-data-dir inside the temporary `
      + `folder holding ${TEST_PROFILE_MARKER_FILE} that matches ${TEST_PROFILE_MARKER_ENV}.`,
  })
  const marker = facts.env[TEST_PROFILE_MARKER_ENV] ?? ''
  if (!MARKER_SHAPE.test(marker)) return refuse(`no run marker was given (${TEST_PROFILE_MARKER_ENV})`)
  const profile = facts.realpath(facts.userData)
  if (!profile) return refuse('the profile folder does not exist')
  const temps = facts.tempDirs.map((dir) => facts.realpath(dir)).filter((dir): dir is string => Boolean(dir))
  if (!temps.some((temp) => strictlyInside(profile, temp))) return refuse('the profile is not a folder inside the temporary folder')
  const onDisk = facts.readMarker(join(profile, TEST_PROFILE_MARKER_FILE))
  if (onDisk === null) return refuse('the profile carries no run marker')
  if (onDisk.trim() !== marker) return refuse("the profile's run marker is not this run's")
  return { state: 'granted' }
}

/** One override's value when the permit is granted, else undefined (as if it were not set). */
export function permittedOverride(permit: TestNetworkPermit, env: Readonly<Record<string, string | undefined>>, name: TestNetworkOverride): string | undefined {
  return permit.state === 'granted' ? env[name] : undefined
}

/** `http://127.0.0.1:<port>` exactly (an origin with an explicit port, nothing after it), or null. */
export function loopbackOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 200) return null
  try {
    const url = new URL(value)
    const ok = url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== ''
      && !url.username && !url.password && !url.search && !url.hash && (url.pathname === '/' || url.pathname === '')
    return ok ? url.origin : null
  } catch { return null }
}
