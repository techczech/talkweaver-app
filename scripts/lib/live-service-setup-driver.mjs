// TESTS ONLY. Sets the live service up once, in a process of its own, so that a test can watch the
// process (scripts/test-wrangler-ambient-trace.mjs runs it under the tracing preload):
//
//   TW_TEST_LIVE_SETUP='<json>' node [--require <trace preload>] live-service-setup-driver.mjs
//     json: { distDir, expectedBuild, apiBase, token, accountId, runs? }
//
// Prints one line of JSON: each run's result without the admin secret (`ok`, `baseUrl`, `error`, `details`).
// The made-up token comes in the environment (never on the command line, where a process listing
// shows it); the app hands the real one over inside an authorisation.
import { setUpLiveService, steadyLeave } from './live-service-setup.mjs'
import { acceptingLive } from './live-worker-double.mjs'

const input = JSON.parse(process.env.TW_TEST_LIVE_SETUP ?? '{}')
// `runs`: how many times, one after the other, with one computer's keys (the first sets up, the rest update).
const keys = { stored: null }
const results = []
for (let run = 0; run < (input.runs ?? 1); run += 1) {
  const { result, saved } = await setUpLiveService({
    distDir: input.distDir,
    expectedBuild: input.expectedBuild,
    authorise: async () => ({ ok: true, authorisation: steadyLeave(input.token, input.accountId) }),
    apiBase: input.apiBase,
    keys,
    // After the first run the live service answers as an EARLIER build, so each later run is an update:
    // code is uploaded only over a build that was read and is older (decision R3).
    // Once that was read it answers as the build just uploaded, as the read-back after an upload expects (decision R10).
    ...(run > 0 ? { liveFetch: acceptingLive({ build: '1-earlier', updatedTo: input.expectedBuild, self: () => keys.stored?.computerId }) } : {}),
  })
  const { adminSecret: _kept, ...shown } = result
  results.push({ ...shown, saved })
}
process.stdout.write(`${JSON.stringify(results)}\n`)
