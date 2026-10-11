// The REAL publishing sequence (src/main/handout-publishing.ts) over ports that always give leave:
// for tests of what the publish handlers build, which lift those handlers out of the main process
// and need a `handoutPublishing()` to call. Nothing is sent anywhere; `onUpload` sees each upload's
// arguments. The sequence itself, and every way leave is refused or lost, is tested in
// scripts/test-handout-publishing.mjs.
import { createHandoutPublishing } from '../../src/main/handout-publishing.ts'

/** A live address somebody else could open (never one on this computer: that is never published). */
export const FAKE_LIVE_ADDRESS = 'https://live.example.test'

/**
 * `supersede`: when the connection changes under the publish. `during-upload`: while the upload runs
 * (its result is then not handed back). `after-upload`: the moment the upload has completed.
 */
export function grantedPublishing({ siteDir, project = 'talks', live = async () => ({ baseUrl: FAKE_LIVE_ADDRESS }), onUpload = () => {}, supersede = 'never' }) {
  let current = true
  return createHandoutPublishing({
    siteDir: () => siteDir,
    authorise: async () => ({
      ok: true,
      authorisation: {
        accountId: 'acct', project, productionBranch: 'main', current: () => current,
        run: async (launch) => {
          const result = await launch({ CLOUDFLARE_API_TOKEN: 'made-up-token-for-tests', CLOUDFLARE_ACCOUNT_ID: 'acct' })
          if (supersede !== 'never') current = false
          return supersede === 'during-upload' ? { superseded: true } : { superseded: false, result }
        },
        clean: (text) => String(text), refusedForPermission() {}, published() {},
      },
    }),
    live,
    toolMissing: () => null,
    bundlingHazard: () => null,
    upload: async (args) => { onUpload(args); return { ok: true, stdout: '', stderr: '' } },
  })
}
