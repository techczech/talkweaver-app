'use strict'
const { join } = require('node:path')
const { verify } = require('./verify-electron-security.cjs')
// Unsigned CI explicitly disables the identity; release uploads independently require Developer ID.
const securityOptions = context => ({ allowUnsigned: context.electronPlatformName === 'darwin' && context.packager.platformSpecificBuildOptions.identity === null })
exports.securityOptions = securityOptions
exports.default = async context => {
  const platform = context.electronPlatformName
  const ext = platform === 'darwin' || platform === 'mas' ? '.app' : platform === 'win32' ? '.exe' : ''
  await verify(join(context.appOutDir, `${context.packager.appInfo.productFilename}${ext}`), securityOptions(context))
}
