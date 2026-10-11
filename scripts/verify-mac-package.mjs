// The release gate for the Mac package (ticket 08, ADR-0003 amendment of 2026-10-09; docs/RELEASING.md).
//
//   node scripts/verify-mac-package.mjs [--require-signed] <TalkWeaver.app | .dmg | .zip> [more packages]
//   node scripts/verify-mac-package.mjs --content-hash <ffmpeg binary>   (prints the pin's contentSha256)
//
// Decides from the package alone whether it ships the pinned plain-GPL ffmpeg. It does not rely on any
// of electron-builder's hooks having run, so a build made with other settings (`-c` overrides that
// switch hooks off, --prepackaged) is judged the same way. The one thing it reads from the committed
// package.json is the team in build.mac.identity, which --require-signed demands of the signature.
// A disk image is attached read-only and a zip is unpacked into a temporary folder; nothing in the
// package is changed. The package must hold exactly one app, at its top level: every folder in it is
// searched, and any other `.app` (nested anywhere, other than Electron's own helpers, by exact name,
// directly in the app's Contents/Frameworks, and holding no symbolic link) is refused, as is any symbolic link that points outside the package (the
// disk image's `Applications` link to /Applications aside). Nothing anywhere in the package may be named ffmpeg (any case) but the
// app's Contents/Resources/ffmpeg/ffmpeg and the folder holding it. For the app:
//   1. Contents/Resources/ffmpeg is a plain folder holding exactly ffmpeg, COPYING.GPLv3,
//      FFMPEG-NOTICE.md and ffmpeg.pin.json, each a plain file; ffmpeg is runnable (755);
//   2. the attestation ffmpeg.pin.json, written by afterPack once it had checked the staged binary,
//      is there and names the committed pin (version, architecture, binary SHA-256, SHA-256 of the pin
//      file), and the binary is built for that one architecture (lipo -archs). An app without one was
//      laid out some other way (e.g. electron-builder --prepackaged) and is refused;
//   3. the notice names the pinned build and the source asset (macFfmpegNoticeProblem);
//   4. signed app (it has Contents/_CodeSignature/CodeResources): `codesign --verify --deep --strict`
//      passes, so nothing in it (ffmpeg and the attestation included) changed since it was signed; and
//      the ffmpeg, with its signature removed in a temporary copy, is the pinned program
//      (contentSha256 in the pin), whoever signed it. With --require-signed (scripts/release-mac-assets.mjs
//      passes it) the app must be signed, its leaf certificate (the first Authority in codesign -dvv)
//      must be "Developer ID Application: … (<team>)" and its TeamIdentifier that team, the one named
//      in package.json build.mac.identity; ad hoc, Apple Development or another team is refused; and
//      `codesign --verify -R` must accept it against Apple's Developer ID requirement for that team
//      (anchor apple generic, the Developer ID intermediate and leaf markers, leaf subject OU = team),
//      so a private certificate that merely carries the name and team is refused;
//      unsigned app: the ffmpeg's SHA-256 is the pinned binarySha256;
//   5. ffmpeg is not a build marked --enable-nonfree.
// Exit 0 when every package passes; otherwise 1, naming the first problem of each package.
import { spawnSync } from 'node:child_process'
import { copyFileSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const {
  MAC_FFMPEG_ATTESTATION, NONFREE, macFfmpegAttestationProblem, macFfmpegNoticeProblem, macFfmpegPinProblem, machoContentSha256, sha256,
} = require('./lib/ffmpeg-ship-check.cjs')

export const PIN_FILE = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'ffmpeg-mac-pin.json')
const FFMPEG_FOLDER_FILES = ['COPYING.GPLv3', 'FFMPEG-NOTICE.md', 'ffmpeg', MAC_FFMPEG_ATTESTATION]
const lstatOrNull = (path) => { try { return lstatSync(path) } catch { return null } }
const run = (command, args) => spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
/** lipo's architecture names, as the pin names them. */
const LIPO_ARCH = { arm64: 'arm64', x86_64: 'x64' }
const PACKAGE_JSON = join(dirname(dirname(fileURLToPath(import.meta.url))), 'package.json')

/**
 * The team a release app must be signed by: the ten-character team in the committed package.json's
 * build.mac.identity ("NAME (TEAMID)"), or null when it names none.
 * @param {string} [packageJson]
 */
export function expectedTeamIdentifier(packageJson = PACKAGE_JSON) {
  const identity = JSON.parse(readFileSync(packageJson, 'utf8'))?.build?.mac?.identity
  const match = typeof identity === 'string' ? /\(([A-Z0-9]{10})\)\s*$/.exec(identity) : null
  return match ? match[1] : null
}

/**
 * Why codesign -dvv's account of a signature is not a Developer ID Application signature of the
 * expected team, or null.
 * @param {string} info codesign -dvv output (it writes to stderr)
 * @param {string | null} team
 */
export function developerIdProblem(info, team) {
  if (!team) return 'refused: package.json build.mac.identity names no team ("NAME (TEAMID)"), so a release signature cannot be checked'
  if (/^Signature=adhoc$/m.test(info)) return 'refused: a release app must be signed with a Developer ID Application certificate; this one is ad-hoc signed'
  const authority = /^Authority=(.*)$/m.exec(info)?.[1] ?? null
  const leaf = authority === null ? null : /^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/.exec(authority)
  if (!leaf) return `refused: a release app must be signed with a Developer ID Application certificate; this one is signed by ${authority === null ? 'no certificate' : `"${authority}"`}`
  const teamIdentifier = /^TeamIdentifier=(.*)$/m.exec(info)?.[1] ?? null
  if (leaf[1] !== team || teamIdentifier !== team) return `refused: a release app must be signed by team ${team} (package.json build.mac.identity); this one names team ${teamIdentifier ?? 'none'} (certificate team ${leaf[1]})`
  return null
}

/**
 * The code requirement a release app must satisfy: Apple's Developer ID designated requirement for
 * `team` (as codesign writes it for a Developer ID Application signature). "anchor apple generic" ties
 * the chain to Apple's root, field 6.2.6 marks Apple's Developer ID intermediate, field 6.1.13 marks a
 * Developer ID Application leaf, and the leaf's subject OU is the team. A certificate that only carries
 * the name, or a TeamIdentifier set by its signer, does not satisfy it.
 * @param {string} team
 */
export function developerIdRequirement(team) {
  if (!/^[A-Z0-9]{10}$/.test(team)) throw new Error(`not a team identifier: ${team}`)
  return `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${team}"`
}

/** The signature-independent hash of a Mach-O (see machoContentSha256), from a temporary unsigned copy. */
export function contentSha256Of(binary) {
  const scratch = mkdtempSync(join(tmpdir(), 'tw-verify-ffmpeg-'))
  try {
    const copy = join(scratch, 'ffmpeg')
    copyFileSync(binary, copy)
    const bytes = readFileSync(copy)
    if (bytes.readUInt32LE(0) === 0xfeedfacf && hasSignature(bytes)) {
      const removed = run('/usr/bin/codesign', ['--remove-signature', copy])
      if (removed.status !== 0) return { problem: `codesign --remove-signature failed: ${(removed.stderr || '').trim()}` }
    }
    return machoContentSha256(readFileSync(copy))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function hasSignature(bytes) {
  const ncmds = bytes.readUInt32LE(16)
  let at = 32
  for (let i = 0; i < ncmds && at + 8 <= bytes.length; i++) {
    if (bytes.readUInt32LE(at) === 0x1d) return true
    at += bytes.readUInt32LE(at + 4) || bytes.length
  }
  return false
}

/**
 * Why this app does not ship the pinned ffmpeg, or null.
 * @param {string} app path to <name>.app
 * @param {{ pinBytes?: Buffer, requireSigned?: boolean, run?: typeof run, expectedTeam?: string | null }} [options]
 *   `run`: runs codesign and lipo (tests hand in one that stands in for codesign's account of a signer);
 *   `expectedTeam`: the team --require-signed demands (default: package.json build.mac.identity).
 */
export function macAppProblem(app, options = {}) {
  const runner = options.run ?? run
  const pinBytes = options.pinBytes ?? readFileSync(PIN_FILE)
  const pin = JSON.parse(pinBytes.toString('utf8'))
  const pinProblem = macFfmpegPinProblem(pin)
  if (pinProblem) return pinProblem
  const appStat = lstatOrNull(app)
  if (!appStat || appStat.isSymbolicLink() || !appStat.isDirectory()) return `refused: ${app} is not an app folder (missing, a link or a file)`

  // 1. The folder and its files.
  let at = app
  for (const part of ['Contents', 'Resources', 'ffmpeg']) {
    at = join(at, part)
    const stat = lstatOrNull(at)
    if (!stat) return `refused: the app has no ${at}`
    if (stat.isSymbolicLink() || !stat.isDirectory()) return `refused: ${at} is not a plain folder (a link or a file)`
  }
  const folder = at
  const names = readdirSync(folder).sort()
  if (names.join('\n') !== [...FFMPEG_FOLDER_FILES].sort().join('\n')) return `refused: ${folder} holds ${names.join(', ') || 'nothing'}; it must hold exactly ${[...FFMPEG_FOLDER_FILES].sort().join(', ')}${names.includes(MAC_FFMPEG_ATTESTATION) ? '' : ` (no ${MAC_FFMPEG_ATTESTATION}: this app's ffmpeg was never checked by afterPack, e.g. an app packaged with --prepackaged)`}`
  for (const name of names) {
    const stat = lstatOrNull(join(folder, name))
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) return `refused: ${join(folder, name)} is not a plain file`
  }
  const binary = join(folder, 'ffmpeg')
  const mode = lstatSync(binary).mode
  if ((mode & 0o111) !== 0o111) return `refused: ${binary} cannot be run by everyone (mode ${(mode & 0o777).toString(8)})`

  // 2. The attestation.
  const attestationProblem = macFfmpegAttestationProblem({ text: readFileSync(join(folder, MAC_FFMPEG_ATTESTATION), 'utf8'), pin, pinBytes })
  if (attestationProblem) return attestationProblem
  const lipo = runner('/usr/bin/lipo', ['-archs', binary])
  const archs = lipo.status === 0 ? String(lipo.stdout || '').trim().split(/\s+/).filter(Boolean) : null
  if (!archs) return `refused: lipo -archs could not read ${binary}: ${String(lipo.stderr || '').trim()}`
  if (archs.length !== 1 || LIPO_ARCH[archs[0]] !== pin.arch) return `refused: ${binary} is built for ${archs.join(', ') || 'no architecture'}; the pin and the attestation are for ${pin.arch} only`

  // 3. The notice.
  const noticeProblem = macFfmpegNoticeProblem({ licence: readFileSync(join(folder, 'COPYING.GPLv3'), 'utf8'), notice: readFileSync(join(folder, 'FFMPEG-NOTICE.md'), 'utf8'), pin })
  if (noticeProblem) return `refused: the shipped notice: ${noticeProblem}`

  // 5 (before 4: no reason to run codesign on a nonfree build).
  const bytes = readFileSync(binary)
  if (bytes.includes(NONFREE)) return `refused: ${binary} was built with --enable-nonfree`

  // 4. The signature, or the bytes.
  const signed = Boolean(lstatOrNull(join(app, 'Contents', '_CodeSignature', 'CodeResources'))?.isFile())
  if (signed) {
    const verify = runner('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
    if (verify.status !== 0) return `refused: the app's signature does not verify (codesign --verify --deep --strict), so its contents changed after signing:\n${(verify.stderr || '').trim()}`
    if (options.requireSigned) {
      const shown = runner('/usr/bin/codesign', ['-dvv', app])
      if (shown.status !== 0) return `refused: codesign -dvv could not describe the app's signature: ${String(shown.stderr || '').trim()}`
      const team = options.expectedTeam !== undefined ? options.expectedTeam : expectedTeamIdentifier()
      const problem = developerIdProblem(String(shown.stderr || ''), team)
      if (problem) return problem
      const anchored = runner('/usr/bin/codesign', ['--verify', '--deep', '--strict', `-R=${developerIdRequirement(team)}`, app])
      if (anchored.status !== 0) return `refused: the app's signature does not satisfy Apple's Developer ID requirement for team ${team} (codesign --verify -R, anchored to Apple's root), whatever its certificate is named:\n${String(anchored.stderr || '').trim()}`
    }
    const content = contentSha256Of(binary)
    if ('problem' in content) return `refused: ${binary}: ${content.problem}`
    if (content.sha256 !== pin.contentSha256) return `refused: ${binary} is not the pinned program (its content SHA-256, signature removed, is ${content.sha256}; pinned ${pin.contentSha256})`
    return null
  }
  if (options.requireSigned) return 'refused: a release app must be signed; this one has no sealed signature (Contents/_CodeSignature/CodeResources)'
  const actual = sha256(bytes)
  if (actual !== pin.binarySha256) return `refused: ${binary} in this unsigned app is not the pinned build (SHA-256 ${actual}, pinned ${pin.binarySha256})`
  return null
}

const isAppName = (name) => /\.app$/i.test(name)
/**
 * The helper apps Electron 42's Mac build puts in Contents/Frameworks, as "<app name> <suffix>.app"
 * (listed from release/mac-arm64/TalkWeaver.app). No other nested app is allowed.
 */
export const ELECTRON_HELPERS = ['Helper', 'Helper (GPU)', 'Helper (Plugin)', 'Helper (Renderer)']
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) }

/**
 * The one app in a package, or why the package's layout is refused. `root` is a mounted disk image or
 * an unpacked zip (`volume` tells which), or, for an app folder handed in directly, the app itself.
 * Every folder is searched without following links: there must be exactly one `.app` at the top level
 * and no other `.app` anywhere, except Electron's helpers (exactly the ELECTRON_HELPERS, "<name> Helper.app"
 * etc.) directly in the app's Contents/Frameworks, none of which may hold a symbolic link (the real Electron 42
 * build has none in them); nothing anywhere (file, folder or link, any case) may be named ffmpeg except the app's
 * Contents/Resources/ffmpeg/ffmpeg and its folder Contents/Resources/ffmpeg; and every link must point inside
 * `root` (on a disk image, the top-level `Applications` link to /Applications aside).
 * @param {string} root
 * @param {{ volume?: boolean, app?: string }} options `app`: root is this app folder itself
 * @returns {{ app: string } | { problem: string }}
 */
export function packageLayoutProblem(root, options = {}) {
  let realRoot
  try { realRoot = realpathSync(root) } catch { return { problem: `refused: ${root} cannot be read` } }
  let app = options.app ?? null
  if (!app) {
    const top = readdirSync(root).filter(isAppName)
    if (top.length !== 1) return { problem: `refused: the package holds ${top.length} apps at its top level; expected exactly one` }
    app = join(root, top[0])
    const stat = lstatOrNull(app)
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return { problem: `refused: ${top[0]} at the top of the package is not an app folder (a link or a file)` }
  }
  const frameworks = join(app, 'Contents', 'Frameworks')
  const appName = basename(app).replace(/\.app$/i, '')
  const helpers = new Set(ELECTRON_HELPERS.map((suffix) => join(frameworks, `${appName} ${suffix}.app`)))
  const ffmpegFolder = join(app, 'Contents', 'Resources', 'ffmpeg')
  const ffmpegBinary = join(ffmpegFolder, 'ffmpeg')
  const show = (path) => relative(root, path) || basename(path)
  const folders = [root]
  while (folders.length) {
    const folder = folders.pop()
    let names
    try { names = readdirSync(folder) } catch (error) { return { problem: `refused: ${show(folder)} in the package cannot be read (${error.code ?? error.message})` } }
    for (const name of names) {
      const path = join(folder, name)
      const stat = lstatOrNull(path)
      if (!stat) return { problem: `refused: ${show(path)} in the package cannot be read` }
      if (/^ffmpeg$/i.test(name) && path !== ffmpegFolder && path !== ffmpegBinary) {
        return { problem: `refused: ${show(path)} is named ffmpeg; the one ffmpeg allowed in the package is ${show(ffmpegBinary)}` }
      }
      if (stat.isSymbolicLink()) {
        if ([...helpers].some((helper) => inside(helper, path))) return { problem: `refused: Electron's helper holds a symbolic link, ${show(path)} (${readlinkSync(path)}); no link is allowed inside a helper` }
        const target = readlinkSync(path)
        if (options.volume && folder === root && name === 'Applications' && target === '/Applications') continue
        if (isAbsolute(target) || !inside(root, resolve(folder, target))) return { problem: `refused: the link ${show(path)} points outside the package (${target})` }
        let real
        try { real = realpathSync(path) } catch { return { problem: `refused: the link ${show(path)} points at nothing inside the package (${target})` } }
        if (!inside(realRoot, real)) return { problem: `refused: the link ${show(path)} leads outside the package (${target})` }
        continue
      }
      if (!stat.isDirectory()) continue
      if (isAppName(name) && path !== app && !helpers.has(path)) {
        return { problem: inside(app, path) ? `refused: the package holds a second app inside the app, ${show(path)}; only Electron's helpers in Contents/Frameworks are allowed` : `refused: the package holds a second app, ${show(path)}; it must hold exactly one, at its top level` }
      }
      folders.push(path)
    }
  }
  return { app }
}

/**
 * Verify one package: an app folder, a disk image or a zip. Returns the problems found (empty: passed)
 * and what was checked.
 * @param {string} target
 * @param {{ pinBytes?: Buffer, requireSigned?: boolean }} [options]
 * @returns {{ problems: string[], checked: string[] }}
 */
export function verifyMacPackage(target, options = {}) {
  const path = resolve(target)
  const stat = lstatOrNull(path)
  if (!stat) return { problems: [`refused: ${path} does not exist`], checked: [] }
  const one = (app, label) => {
    const problem = macAppProblem(app, options)
    return { problems: problem ? [`${label}: ${problem}`] : [], checked: [label] }
  }
  if (path.endsWith('.app')) {
    const layout = packageLayoutProblem(path, { app: path })
    if ('problem' in layout) return { problems: [`${path}: ${layout.problem}`], checked: [] }
    return one(path, path)
  }
  const scratch = mkdtempSync(join(tmpdir(), 'tw-verify-package-'))
  try {
    let root
    let detach = null
    const volume = path.endsWith('.dmg')
    if (path.endsWith('.dmg') && stat.isFile()) {
      root = join(scratch, 'mount')
      const attach = run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', root, path])
      if (attach.status !== 0) return { problems: [`refused: ${path} could not be attached read-only: ${(attach.stderr || '').trim()}`], checked: [] }
      detach = () => run('/usr/bin/hdiutil', ['detach', root, '-force'])
    } else if (path.endsWith('.zip') && stat.isFile()) {
      root = join(scratch, 'unzipped')
      const unzip = run('/usr/bin/ditto', ['-x', '-k', path, root])
      if (unzip.status !== 0) return { problems: [`refused: ${path} could not be unpacked: ${(unzip.stderr || '').trim()}`], checked: [] }
    } else {
      return { problems: [`refused: ${path} is not a .app folder, a .dmg or a .zip`], checked: [] }
    }
    try {
      const layout = packageLayoutProblem(root, { volume })
      if ('problem' in layout) return { problems: [`${path}: ${layout.problem}`], checked: [] }
      return one(layout.app, `${path} → ${layout.app.slice(root.length + 1)}`)
    } finally {
      if (detach) detach()
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

async function main(argv) {
  if (process.platform !== 'darwin') {
    console.error('verify-mac-package: needs macOS (codesign, hdiutil, ditto)')
    return 1
  }
  if (argv[0] === '--content-hash' && argv[1]) {
    const content = contentSha256Of(resolve(argv[1]))
    if ('problem' in content) { console.error(`verify-mac-package: ${content.problem}`); return 1 }
    console.log(content.sha256)
    return 0
  }
  const requireSigned = argv.includes('--require-signed')
  const targets = argv.filter((arg) => arg !== '--require-signed')
  if (!targets.length || targets.some((arg) => arg.startsWith('--'))) {
    console.error('Usage: node scripts/verify-mac-package.mjs [--require-signed] <TalkWeaver.app | .dmg | .zip> [more]')
    return 2
  }
  let failed = 0
  for (const target of targets) {
    const { problems, checked } = verifyMacPackage(target, { requireSigned })
    if (problems.length) {
      failed++
      for (const problem of problems) console.error(`verify-mac-package: FAIL ${problem}`)
    } else {
      for (const label of checked) console.log(`verify-mac-package: ok ${label}: ffmpeg is the pinned build, attested by afterPack${requireSigned ? ', in a Developer ID signed app whose seal verifies' : ''}`)
    }
  }
  return failed ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
