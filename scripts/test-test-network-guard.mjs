// The one rule for every test-only network override (src/main/test-network-guard.ts): an override is
// honoured only by an unpackaged TW_E2E=1 app on a profile the harness made for this run; on any other
// profile the app refuses to start. Plain Node over real folders in the temporary folder; no Electron
// (the app-level regression is e2e/diagnose-test-network-guard.mjs).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TEST_NETWORK_OVERRIDES, TEST_PROFILE_MARKER_ENV, TEST_PROFILE_MARKER_FILE, loopbackOrigin, permittedOverride, testNetworkPermit,
} from '../src/main/test-network-guard.ts'
import { liveServiceStandIn } from '../src/main/live-service-stand-in.ts'
import { loopbackApiBase } from '../src/main/cloudflare-connection.ts'
import { testLoopbackAllowance } from '../src/main/live-page-policy.ts'
import * as harness from '../e2e/lib/test-profile.mjs'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tw-network-guard-')))
// A stand-in for a profile that is not in the temporary folder: the repo's own ignored scratch.
const outside = mkdtempSync(join(repo, '.tw-network-guard-outside-'))
let cases = 0
try {
  assert.equal(harness.TEST_PROFILE_MARKER_ENV, TEST_PROFILE_MARKER_ENV, 'the harness helper and the app agree on the marker variable')
  assert.equal(harness.TEST_PROFILE_MARKER_FILE, TEST_PROFILE_MARKER_FILE, 'and on the marker file')

  const MARKER = 'run-marker-0123456789abcdef'
  const OVERRIDES = {
    TW_E2E_LIVE_SERVICE_URL: 'http://127.0.0.1:8124',
    TW_E2E_CLOUDFLARE_API_BASE_URL: 'http://127.0.0.1:8123/client/v4',
    TW_E2E_RECORDING_ENDPOINT: 'http://127.0.0.1:8125',
    TW_E2E_UPDATES_FEED: 'http://127.0.0.1:8126/feed.json',
    TW_E2E_LIVE_PAGE_ALLOW: '127.0.0.1:8127',
  }
  assert.deepEqual(Object.keys(OVERRIDES).sort(), [...TEST_NETWORK_OVERRIDES].sort(), 'the table names every override the guard covers')

  const profile = (name, { marker = null, credentials = false, root = scratch } = {}) => {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    if (marker !== null) writeFileSync(join(dir, TEST_PROFILE_MARKER_FILE), marker)
    // A credential store as the app keeps it (secrets-store.ts file names); fixture bytes only.
    if (credentials) for (const file of ['cf-pages-token.bin', 'live-worker-credentials.bin']) writeFileSync(join(dir, file), 'fixture, not a secret')
    return dir
  }
  const facts = (over) => ({
    packaged: false,
    env: { TW_E2E: '1', [TEST_PROFILE_MARKER_ENV]: MARKER, ...OVERRIDES },
    userData: profile('harness', { marker: MARKER }),
    tempDirs: [tmpdir()],
    realpath: (path) => { try { return realpathSync(path) } catch { return null } },
    readMarker: (path) => { try { return readFileSync(path, 'utf8') } catch { return null } },
    ...over,
  })
  const env = (over) => ({ TW_E2E: '1', [TEST_PROFILE_MARKER_ENV]: MARKER, ...OVERRIDES, ...over })

  const table = [
    ['packaged build: overrides ignored, app runs', facts({ packaged: true }), 'inert'],
    ['no TW_E2E: overrides ignored, app runs', facts({ env: env({ TW_E2E: undefined }) }), 'inert'],
    ['TW_E2E=0: overrides ignored', facts({ env: env({ TW_E2E: '0' }) }), 'inert'],
    ['TW_E2E without any override: nothing to guard', facts({ env: { TW_E2E: '1' }, userData: profile('plain') }), 'inert'],
    ['existing profile (not in the temporary folder) holding credentials, no marker', facts({ userData: profile('real', { credentials: true, root: outside }) }), 'refused'],
    ['existing profile holding credentials, even with a matching marker file', facts({ userData: profile('real-marked', { credentials: true, marker: MARKER, root: outside }) }), 'refused'],
    ['temporary profile holding credentials but no marker file', facts({ userData: profile('creds-no-marker', { credentials: true }) }), 'refused'],
    ['temporary profile without the marker file', facts({ userData: profile('no-marker') }), 'refused'],
    ['temporary profile, marker variable missing', facts({ env: env({ [TEST_PROFILE_MARKER_ENV]: undefined }) }), 'refused'],
    ['temporary profile, marker variable malformed', facts({ env: env({ [TEST_PROFILE_MARKER_ENV]: 'short' }) }), 'refused'],
    ["temporary profile carrying another run's marker", facts({ userData: profile('other-run', { marker: 'another-run-marker-0123456789' }) }), 'refused'],
    ['the temporary folder itself as the profile', facts({ userData: tmpdir() }), 'refused'],
    ['a profile folder that does not exist', facts({ userData: join(scratch, 'missing') }), 'refused'],
    ['each override alone on an unmarked profile is refused', null, 'each'],
    ['the harness profile: a fresh folder in the temporary folder with this run\'s marker', facts({}), 'granted'],
  ]
  for (const [name, input, expected] of table) {
    if (expected === 'each') {
      for (const override of TEST_NETWORK_OVERRIDES) {
        const permit = testNetworkPermit(facts({ env: { TW_E2E: '1', [override]: OVERRIDES[override] }, userData: profile('real', { credentials: true, root: outside }) }))
        assert.equal(permit.state, 'refused', `${name}: ${override}`)
        assert.match(permit.reason, new RegExp(override), 'the refusal names the override')
        cases += 1
      }
      continue
    }
    const permit = testNetworkPermit(input)
    assert.equal(permit.state, expected, name)
    if (expected === 'refused') {
      assert.match(permit.reason, /will not start/, `${name}: the refusal says the app will not start`)
      assert.ok(!permit.reason.includes(MARKER), `${name}: the refusal does not print the marker`)
    }
    for (const override of TEST_NETWORK_OVERRIDES) {
      const value = permittedOverride(permit, input.env, override)
      assert.equal(value, expected === 'granted' ? OVERRIDES[override] : undefined, `${name}: ${override} ${expected === 'granted' ? 'passes' : 'reads as unset'}`)
    }
    cases += 1
  }
  console.log(`PASS test network guard: ${cases} profile cases (packaged, no TW_E2E, existing and temporary profiles with and without the marker, the harness profile)`)

  // Each override's address: 127.0.0.1 with an explicit port, nothing that only looks like it.
  const lookAlikes = [
    'http://localhost:8124', 'http://127.0.0.1', 'http://127.0.0.1:80', 'https://127.0.0.1:8124', 'http://127.0.0.2:8124', 'http://[::1]:8124',
    'http://127.0.0.1.nip.io:8124', 'http://127.0.0.1.example.com:8124', 'http://evil.example@127.0.0.1:8124', 'http://127.0.0.1:8124@evil.example',
    'http://10.0.0.5:8124', 'http://192.168.1.2:8124', 'https://a.workers.dev', 'http://127.0.0.1:8124/x', 'http://127.0.0.1:8124/?x=1', 'http://127.0.0.1:8124/#x', '', undefined, null, 7,
  ]
  let addressCases = 0
  for (const value of lookAlikes) {
    assert.equal(loopbackOrigin(value), null, `recording endpoint refuses ${value}`)
    assert.equal(liveServiceStandIn({ packaged: false, e2e: true, override: value }), null, `live service refuses ${value}`)
    assert.equal(loopbackApiBase(typeof value === 'string' && value ? `${value.replace(/\/$/, '')}/client/v4` : value), null, `Cloudflare API refuses ${value}`)
    addressCases += 1
  }
  for (const entry of ['localhost:8127', '127.0.0.1', '127.0.0.2:8127', '[::1]:8127', '127.0.0.1.nip.io:8127', '10.0.0.5:8127']) {
    assert.equal(testLoopbackAllowance({ isPackaged: false, e2e: true, value: entry }).size, 0, `live page allowance refuses ${entry}`)
    addressCases += 1
  }
  assert.equal(loopbackOrigin('http://127.0.0.1:8125'), 'http://127.0.0.1:8125')
  assert.equal(liveServiceStandIn({ packaged: false, e2e: true, override: 'http://127.0.0.1:8124' }), 'http://127.0.0.1:8124')
  assert.equal(liveServiceStandIn({ packaged: false, e2e: true, override: 'http://127.0.0.1:8124/' }), 'http://127.0.0.1:8124')
  console.log(`PASS override addresses: ${addressCases} look-alike or non-loopback addresses refused (localhost, no port, other hosts, credentials in the address)`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
}
