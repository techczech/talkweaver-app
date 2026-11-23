'use strict'
const assert = require('node:assert/strict')
const { assertWire, assertEntitlements } = require('./verify-electron-security.cjs')
const wire = { version: '1', 0: 49, 2: 48, 3: 48, 4: 48, 5: 48 }
assertWire(wire)
for (const index of [2, 3]) assert.throws(() => assertWire({ ...wire, [index]: 49 }))
assert.throws(() => assertWire({ ...wire, version: '2' }))
assert.throws(() => assertWire(wire, true))
assertEntitlements('<plist><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>')
for (const key of ['allow-dyld-environment-variables', 'disable-library-validation', 'allow-unsigned-executable-memory']) assert.throws(() => assertEntitlements(`<plist><key>com.apple.security.cs.${key}</key><true/></plist>`))
assert.throws(() => assertEntitlements(''))
console.log('PASS fuse drift, full-policy refusal, entitlement injection and missing entitlements')

const flavour = require('../build/electron-builder.security-test.cjs')
assert.equal(flavour.mac.notarize, false)
assert.equal(flavour.productName, 'TalkWeaver Security Test')
assert.equal(flavour.mac.identity, require('../package.json').build.mac.identity)
assert.equal(flavour.mac.hardenedRuntime, true)
assert.throws(() => assertEntitlements('<plist><dict><key>unexpected.entitlement</key><true/></dict></plist>'), /forbidden entitlement/)
assert.throws(() => assertEntitlements('<plist><dict><key>com.apple.security.device.audio-input</key><true/></dict></plist>'), /forbidden entitlement/)
assertEntitlements('<plist><dict><key>com.apple.security.device.audio-input</key><true/></dict></plist>', true)
console.log('PASS isolated test flavour and entitlement allowlist')

const { assertNoNotaryCredentials } = require('./security-test-credentials.cjs')
assertNoNotaryCredentials({ PATH: '/usr/bin' })
for (const name of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_API_KEY', 'ASC_KEY_ID', 'NOTARY_PROFILE', 'CSC_LINK']) assert.throws(() => assertNoNotaryCredentials({ [name]: 'fixture' }), /refuse/)
const { assertSignature, machoFiles } = require('./verify-electron-security.cjs')
assertSignature('TeamIdentifier=TESTTEAM01\nCodeDirectory flags=0x10000(runtime)\n', 'TESTTEAM01', true)
assert.throws(() => assertSignature('TeamIdentifier=OTHERTEAM1\n', 'TESTTEAM01', false), /team/)
assert.throws(() => assertSignature('TeamIdentifier=TESTTEAM01\n', 'TESTTEAM01', true), /runtime/)
assert.throws(() => assertSignature('Identifier=TeamIdentifier=TESTTEAM01\nTeamIdentifier=OTHERTEAM1\n', 'TESTTEAM01', false), /team/)
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const scratch = mkdtempSync(join(__dirname, '../.tw-security-inventory-'))
try {
  const names = ['MacOS/TalkWeaver', 'Frameworks/Helper.app/Contents/MacOS/Helper', 'Resources/ocr', 'Resources/media', 'Resources/vault-gallery', 'Resources/ffmpeg/ffmpeg', 'Resources/workerd', 'Resources/first/esbuild', 'Resources/second/esbuild', 'Frameworks/ShipIt', 'Frameworks/chrome_crashpad_handler', 'Resources/addon.node', 'Resources/lib.dylib']
  for (const name of names) { const path = join(scratch, name); mkdirSync(require('node:path').dirname(path), { recursive: true }); writeFileSync(path, Buffer.from('cffaedfe00000000', 'hex')) }
  writeFileSync(join(scratch, 'plain'), 'not binary')
  assert.deepEqual(machoFiles(scratch).sort(), names.map(name => join(scratch, name)).sort())
} finally { rmSync(scratch, { recursive: true, force: true }) }
console.log('PASS credential refusal, team/runtime policy, complete Mach-O inventory (13 paths)')
const { assertRuntimePolicy } = require('./verify-electron-security.cjs')
assertRuntimePolicy('TalkWeaver refuses debugging switches in production', 'require("./security-startup"); require("electron")')
assert.throws(() => assertRuntimePolicy('UNPUBLISHED_SECURITY_TEST_FLAVOUR'), /test flavour/)
assert.throws(() => assertRuntimePolicy(''), /guard is missing/)
assert.throws(() => assertRuntimePolicy('TalkWeaver refuses debugging switches in production', 'require("electron")'), /first main-process require/)
console.log('PASS production gate rejects compiled test exemption or missing runtime guard')

assertEntitlements('<plist><dict><key>com.apple.security.device.camera</key><true/></dict></plist>', true)
assert.throws(()=>assertEntitlements('<plist><dict><key>com.apple.security.device.camera</key><true/></dict></plist>'),/forbidden entitlement/)
assertEntitlements('<plist><dict/></plist>',false,true)
assert.throws(()=>assertEntitlements('<plist><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>',false,true),/forbidden entitlement/)
console.log('PASS camera only on main and empty ONNX runtime entitlements')
const { securityOptions } = require('./electron-builder-security-check.cjs')
const hookContext = (platform, identity) => ({ electronPlatformName: platform, packager: { platformSpecificBuildOptions: { identity } } })
assert.deepEqual(securityOptions(hookContext('darwin', null)), { allowUnsigned: true })
for (const identity of [undefined, '', 'Developer ID Application: Fixture']) assert.deepEqual(securityOptions(hookContext('darwin', identity)), { allowUnsigned: false })
assert.deepEqual(securityOptions(hookContext('win32', null)), { allowUnsigned: false })
console.log('PASS afterSign unsigned mode requires an explicit null macOS identity; signed release policy remains strict')

// Window and page hardening, read from source so a regression fails before any build.
const { readFileSync } = require('node:fs')
const mainSource = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8')
for (const window of ["join(__dirname, '../preload/index.js'),"]) {
  const blocks = mainSource.split(window).slice(1).map(rest => rest.slice(0, 200))
  assert.ok(blocks.length >= 2, 'editor and tools windows both load the main preload')
  for (const block of blocks) assert.match(block, /contextIsolation: true,\s*nodeIntegration: false,\s*sandbox: true/, 'main preload windows set sandbox: true explicitly')
}
// Deck windows: the effective preload and sandbox per present mode, from the function the window factory uses.
const { presentWindowPreferences } = require('../src/main/present-window-prefs.ts')
const preloads = '/app/out/preload'
const deckModes = {
  'plain (window)': ['window', { preload: join(preloads, 'presentEdit.js'), sandbox: true }],
  'plain (no mode)': [undefined, { preload: join(preloads, 'presentEdit.js'), sandbox: true }],
  presenter: ['presenter', { preload: join(preloads, 'presentRecorder.js'), sandbox: false }],
  audience: ['audience', { sandbox: true }]
}
for (const [name, [mode, expected]] of Object.entries(deckModes)) {
  assert.deepEqual(presentWindowPreferences(mode, preloads), expected, `${name} deck window: preload and sandbox`)
}
// The presenter is the recorder: recording is attached only there, so it is the one unsandboxed deck window.
assert.match(mainSource, /const recording = mode === 'presenter'\s*\n\s*const deckPrefs = presentWindowPreferences\(mode, join\(__dirname, '\.\.\/preload'\)\)/, 'the deck window factory takes its preload and sandbox from presentWindowPreferences')
const deckWindow = mainSource.slice(mainSource.indexOf('const deckPrefs = presentWindowPreferences'), mainSource.indexOf("registerWindowKind(win, 'deck')"))
assert.match(deckWindow, /\.\.\.deckPrefs\s*\n\s*\}/, 'deckPrefs is the last word on the deck window preferences')
assert.doesNotMatch(deckWindow, /sandbox:|preload:/, 'the deck window sets no sandbox or preload of its own')
const { readdirSync } = require('node:fs')
for (const file of readdirSync(join(__dirname, '../src/main')).filter((name) => name.endsWith('.ts'))) {
  const source = readFileSync(join(__dirname, '../src/main', file), 'utf8')
  if (file === 'present-window-prefs.ts') continue
  assert.doesNotMatch(source, /sandbox:\s*false/, `${file} turns no window's sandbox off (only present-window-prefs.ts, for the recorder)`)
}
// The plain presentation preload must load inside the sandbox: one file that requires only electron.
const viteConfig = readFileSync(join(__dirname, '../electron.vite.config.ts'), 'utf8')
assert.match(viteConfig, /selfContainedPreload\('presentEdit', resolve\(__dirname, 'src\/preload\/present-edit\.ts'\)\)/, 'presentEdit is built as one self-contained file')
for (const page of ['index.html', 'settings.html', 'capture-embed.html']) {
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(readFileSync(join(__dirname, '../src/renderer', page), 'utf8'))[1]
  assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline/, `${page} CSP stays strict on scripts`)
  assert.match(csp, /base-uri 'none'/, `${page} CSP sets base-uri`)
  assert.match(csp, /form-action 'none'/, `${page} CSP sets form-action`)
  assert.ok(/object-src 'none'/.test(csp) || /default-src 'none'/.test(csp), `${page} CSP blocks plugins`)
}
assert.match(readFileSync(join(__dirname, '../src/renderer/src/components/FixedDeckPreview.tsx'), 'utf8'), /sandbox=\{FIXED_DECK_SANDBOX\}/, 'FixedDeckPreview iframe is sandboxed')
const deckSandbox = /FIXED_DECK_SANDBOX = '([^']+)'/.exec(readFileSync(join(__dirname, '../src/renderer/src/components/fixedDeckPreviewModel.ts'), 'utf8'))[1].split(' ')
assert.ok(deckSandbox.includes('allow-scripts'), 'deck preview runs its scripts')
for (const token of ['allow-top-navigation', 'allow-top-navigation-by-user-activation', 'allow-modals', 'allow-downloads', 'allow-popups-to-escape-sandbox']) assert.ok(!deckSandbox.includes(token), `deck preview sandbox leaves out ${token}`)
console.log('PASS sandbox on main windows; deck windows per mode (plain, presenter = recorder, audience); CSP object/base/form directives; sandboxed deck preview')
