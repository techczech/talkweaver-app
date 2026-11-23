import production, { UPDATE_SIGNER } from './electron.vite.config'

// The unpublished update-test flavour (ADR-0044): the security-test flavour (inspector allowed, refused by the
// production gate) plus __TW_UPDATE_TEST__, which names the app "TalkWeaver Update Test" (its own user-data
// folder) and lets it read a stand-in update feed on this computer's loopback address (TW_UPDATE_TEST_FEED).
// Selected by scripts/build-update-test.cjs only; no environment or runtime switch enables it. Its bundle identifier
// is `<appId>.update-test` (build/electron-builder.update-test.cjs), so that is the identity its updater requires.
export default {
  ...production,
  main: { ...production.main, define: { ...production.main?.define, __TW_SECURITY_TEST__: 'true', __TW_UPDATE_TEST__: 'true', __TW_UPDATE_SIGNER__: JSON.stringify({ ...UPDATE_SIGNER, bundleId: `${UPDATE_SIGNER.bundleId}.update-test` }) } },
  renderer: { ...production.renderer, define: { ...production.renderer?.define, __TW_SECURITY_TEST__: 'true' } }
}
