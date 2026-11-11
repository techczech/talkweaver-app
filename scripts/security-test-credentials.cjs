'use strict'
// Check names only. Never read or print credential values.
function assertNoNotaryCredentials(env = process.env) {
  const names = Object.keys(env).filter(name => /^(?:APPLE_|ASC_|NOTARY_|NOTARIZE_|CSC_)/i.test(name))
  if (names.length) throw new Error('Security test builds refuse signing/notary credentials in the environment; use a clean build environment')
}
module.exports = { assertNoNotaryCredentials }
