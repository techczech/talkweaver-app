// Package-only gate. Run with host Node, never with the packaged executable.
'use strict'
const { createRequire } = require('node:module')
const { spawnSync } = require('node:child_process')
const { readdirSync, existsSync, openSync, readSync, closeSync, readFileSync } = require('node:fs')
const { resolve, join } = require('node:path')
const builderRequire = createRequire(require.resolve('app-builder-lib'))
const { getCurrentFuseWire, FuseV1Options, FuseVersion } = builderRequire('@electron/fuses')

const expected = {
  // Temporary production dependencies: scratchpad-disk.ts and wrangler-launcher.ts.
  RunAsNode: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: false,
  OnlyLoadAppFromAsar: false,
}
const plist = require('plist')
function assertWire(wire, full = false) {
  if (wire.version !== FuseVersion.V1) throw new Error('unknown fuse schema')
  for (const [name, value] of Object.entries(expected)) {
    const required = full && ['RunAsNode', 'EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar'].includes(name)
      ? name !== 'RunAsNode' : value
    // FuseState values are ASCII bytes, not booleans.
    if (wire[FuseV1Options[name]] !== (required ? 49 : 48)) throw new Error(`${name}: expected ${required ? 'enabled' : 'disabled'}, got ${wire[FuseV1Options[name]]}`)
  }
}
function assertEntitlements(xml, main = false) {
  const allowed = new Set(['com.apple.security.cs.allow-jit', ...(main ? ['com.apple.security.device.audio-input'] : [])])
  if (!xml.includes('<plist')) throw new Error('codesign returned no entitlement plist')
  const values = plist.parse(xml)
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('invalid entitlement dictionary')
  for (const name of Object.keys(values)) if (!allowed.has(name)) throw new Error(`forbidden entitlement: ${name}`)
}
// Identify code by Mach-O magic, never by filename or extension. Framework aliases are
// skipped: their real files are reached under Versions and checked once.
function machoFiles(root) {
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...machoFiles(path))
    else if (entry.isFile()) {
      const fd = openSync(path, 'r'), bytes = Buffer.alloc(4)
      try { if (readSync(fd, bytes, 0, 4, 0) !== 4) continue } finally { closeSync(fd) }
      if (['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(bytes.toString('hex'))) files.push(path)
    }
  }
  return files
}
function assertSignature(info, team, executable) {
  if (!team || /^TeamIdentifier=(.*)$/m.exec(info)?.[1] !== team) throw new Error(`signature must use team ${team}`)
  // MH_EXECUTE needs hardened runtime; libraries inherit the loading process's runtime.
  if (executable && !/^CodeDirectory .*flags=.*\bruntime\b/m.test(info)) throw new Error('executable lacks hardened runtime')
}
function assertRuntimePolicy(startup, main) {
  if (startup.includes('UNPUBLISHED_SECURITY_TEST_FLAVOUR')) throw new Error('unpublished test flavour cannot pass the production gate')
  if (!startup.includes('TalkWeaver refuses debugging switches in production')) throw new Error('production startup debugging guard is missing')
  if (main.match(/\brequire\(["']([^"']+)["']\)/)?.[1] !== './security-startup') throw new Error('startup guard must be the first main-process require')
}
function isExecutable(path) {
  const result = spawnSync('/usr/bin/file', ['-b', path], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`cannot read Mach-O header: ${path}`)
  return /\bexecutable\b/.test(result.stdout)
}
async function verify(app, { full = false, allowUnsigned = false } = {}) {
  const wire = await getCurrentFuseWire(app)
  assertWire(wire, full)
  const resources = app.endsWith('.app') ? join(app, 'Contents/Resources') : join(require('node:path').dirname(app), 'resources')
  assertRuntimePolicy(readFileSync(join(resources, 'app/out/main/security-startup.js'), 'utf8'), readFileSync(join(resources, 'app/out/main/index.js'), 'utf8'))
  for (const name of Object.keys(expected)) console.log(`${name}: ${wire[FuseV1Options[name]] === 49 ? 'enabled' : 'disabled'}`)
  const adHoc = app.endsWith('.app') && /Signature=adhoc/.test(spawnSync('/usr/bin/codesign', ['-dvv', app], { encoding: 'utf8' }).stderr || '')
  if (app.endsWith('.app') && allowUnsigned && (adHoc || !existsSync(join(app, 'Contents/_CodeSignature/CodeResources')))) {
    console.log('UNVERIFIED entitlements: explicitly allowed unsigned/ad-hoc functional build')
  } else if (app.endsWith('.app')) {
    const info = plist.parse(readFileSync(join(app, 'Contents/Info.plist'), 'utf8'))
    if (Object.keys(info).some(name => name.startsWith('NSBluetooth'))) throw new Error('unused Bluetooth usage description in app plist')
    const main = join(app, 'Contents/MacOS', info.CFBundleExecutable)
    const team = /\(([A-Z0-9]{10})\)$/.exec(require('../package.json').build.mac.identity)?.[1]
    const targets = machoFiles(join(app, 'Contents'))
    if (!targets.includes(main)) throw new Error('main executable missing from Mach-O inventory')
    for (const target of [app, ...targets]) {
      const seal = spawnSync('/usr/bin/codesign', ['--verify', '--strict', target], { encoding: 'utf8' })
      if (seal.status !== 0) throw new Error(`invalid or missing signature: ${target}: ${seal.stderr}`)
      const metadata = spawnSync('/usr/bin/codesign', ['-dvv', target], { encoding: 'utf8' })
      if (metadata.status !== 0) throw new Error(`cannot describe signature: ${target}`)
      assertSignature(metadata.stderr, team, target === app || isExecutable(target))
      const signed = spawnSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', target], { encoding: 'utf8' })
      if (signed.status !== 0) throw new Error(`cannot read signed entitlements: ${target}`)
      // Native libraries may have no entitlement blob at all (an empty allowlist).
      assertEntitlements(signed.stdout.trim() || '<plist><dict/></plist>', target === app || target === main)
      console.log(`safe signed entitlements: ${target}`)
    }
    console.log(`PASS all ${targets.length} Mach-O binaries: signatures, team, runtime and entitlement allowlist`)
  }
  console.log('PASS package policy only; RunAsNode (including Node-mode inspection) and ASAR remain documented exceptions (docs/security-hardening.md)')
}
module.exports = { assertWire, assertEntitlements, assertSignature, assertRuntimePolicy, machoFiles, verify }
if (require.main === module) {
  const args = process.argv.slice(2)
  const app = args.find(arg => !arg.startsWith('--'))
  if (!app || args.some(arg => arg.startsWith('--') && !['--require-full', '--allow-unsigned'].includes(arg))) {
    console.error('Usage: node scripts/verify-electron-security.cjs [--require-full] [--allow-unsigned] <app bundle | exe>'); process.exitCode = 2
  } else verify(resolve(app), { full: args.includes('--require-full'), allowUnsigned: args.includes('--allow-unsigned') }).catch(error => { console.error(error.message); process.exitCode = 1 })
}
