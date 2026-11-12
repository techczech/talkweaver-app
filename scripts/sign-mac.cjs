// Preserve electron-builder's per-file policy except the standalone Swift speech tool.
const { signAsync } = require('@electron/osx-sign')
const { join } = require('node:path')
exports.default = async function sign(options) {
  const speech = join(options.app, 'Contents', 'Helpers', 'transcription')
  const inherited = options.optionsForFile
  await signAsync({ ...options, optionsForFile: file => file === speech || file.includes('/node_modules/onnxruntime-node/')
    ? { hardenedRuntime: true, entitlements: [] }
    : inherited(file) })
}
