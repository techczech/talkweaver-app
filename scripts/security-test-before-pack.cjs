'use strict'
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
exports.default = async context => {
  require('./security-test-credentials.cjs').assertNoNotaryCredentials()
  if (!readFileSync(join(__dirname, '../out/main/security-startup.js'), 'utf8').includes('UNPUBLISHED_SECURITY_TEST_FLAVOUR')) throw new Error('Build the security test flavour with npm run build:security-test first')
  await require('./electron-builder-before-pack.cjs').default(context)
}
