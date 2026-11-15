import production from './electron.vite.config'

// The unpublished update-test flavour (ADR-0044): the security-test flavour (inspector allowed, refused by the
// production gate) plus __TW_UPDATE_TEST__, which names the app "TalkWeaver Update Test" (its own user-data
// folder) and lets it read a stand-in update feed on this computer's loopback address (TW_UPDATE_TEST_FEED).
// Selected by scripts/build-update-test.cjs only; no environment or runtime switch enables it.
export default {
  ...production,
  main: { ...production.main, define: { ...production.main?.define, __TW_SECURITY_TEST__: 'true', __TW_UPDATE_TEST__: 'true' } },
  renderer: { ...production.renderer, define: { ...production.renderer?.define, __TW_SECURITY_TEST__: 'true' } }
}
