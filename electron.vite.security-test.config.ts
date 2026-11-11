import production from './electron.vite.config'

// Selected by the build command only; no environment or runtime switch enables this.
export default {
  ...production,
  main: { ...production.main, define: { ...production.main?.define, __TW_SECURITY_TEST__: 'true' } },
  renderer: { ...production.renderer, define: { ...production.renderer?.define, __TW_SECURITY_TEST__: 'true' } }
}
