// Unpublished flavour for proving an in-place update on this Mac (ADR-0044; docs/RELEASING.md, "Proving an
// in-place update on this Mac"). Built from the security-test flavour: the production signing identity and
// hardened runtime, notarisation off, the inspector fuse on (so the proof can drive the real window), its own
// name, bundle identifier, user-data folder and update cache. The production gate refuses it.
require('../scripts/security-test-credentials.cjs').assertNoNotaryCredentials()
const securityTest = require('./electron-builder.security-test.cjs')
module.exports = {
  ...securityTest,
  productName: 'TalkWeaver Update Test',
  appId: `${require('../package.json').build.appId}.update-test`,
  artifactName: 'NEVER-PUBLISH-update-test-${version}-${arch}.${ext}',
  directories: { ...securityTest.directories, output: 'release-update-test' },
}
