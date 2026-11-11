// Unpublished Playwright flavour: the production gate refuses its inspector fuse.
require('../scripts/security-test-credentials.cjs').assertNoNotaryCredentials()
const production = require('../package.json').build
module.exports = {
  ...production,
  extends: null,
  productName: 'TalkWeaver Security Test',
  // identity:null skips hardened-runtime signing in this builder; retain the local identity.
  mac: { ...production.mac, notarize: false },
  beforePack: 'scripts/security-test-before-pack.cjs',
  appId: `${production.appId}.security-test`,
  artifactName: 'NEVER-PUBLISH-security-test-${version}-${arch}.${ext}',
  directories: { ...production.directories, output: 'release-security-test' },
  publish: null,
  afterSign: null,
  electronFuses: { ...production.electronFuses, enableNodeCliInspectArguments: true },
}
