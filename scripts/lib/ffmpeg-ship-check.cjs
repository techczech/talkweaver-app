// Whether the ffmpeg that ships with TalkWeaver (spec docs/plans/cloudflare-setup-in-app, D16) can go
// into this package. Called from scripts/electron-builder-before-pack.cjs and, for the pin, from
// scripts/lib/ffmpeg-mac-fetch.mjs; pure apart from the file reads it is handed, so
// scripts/test-transcription-setup.mjs drives it with fixture files.
//
// Windows: the binary comes from node_modules/ffmpeg-static (gyan.dev essentials, GPL v3), which
//   `npm install` downloads. It must be there; an installer may not carry a build marked
//   --enable-nonfree; an unpacked build (`--dir`) may.
// The staged check (macOS): after electron-builder has copied extraResources into the app and before
//   it signs, the binary inside the app (Contents/Resources/ffmpeg/ffmpeg) must be the pinned bytes, a
//   plain file reached through no link, and runnable by everyone. Checking ffmpeg-mac/ before packing
//   is not enough on its own: the file can change between that check and the copy.
// macOS: the binary is the one plain-GPL build pinned in scripts/lib/ffmpeg-mac-pin.json (ADR-0003,
//   amendment of 2026-10-09), fetched into ffmpeg-mac/ by scripts/fetch-ffmpeg-mac.mjs. Only a file
//   whose SHA-256 is the pinned one is accepted, in every target, unpacked builds included; a build
//   marked --enable-nonfree is refused even if someone pins it. ffmpeg-static's macOS binary is such
//   a build ("nonfree and unredistributable"), which is why macOS does not use it.
'use strict'
const { createHash } = require('node:crypto')
const { join } = require('node:path')

const NONFREE = Buffer.from('--enable-nonfree')
const HEX64 = /^[0-9a-f]{64}$/
/** Where each pinned architecture's builds are, and the only host a pin may name. */
const PIN_HOST = 'ffmpeg.martin-riedl.de'
const PIN_ARCH_FOLDER = { arm64: 'arm64', x64: 'amd64' }
/** electron-builder's Arch enum (builder-util): the number beforePack is handed. */
const BUILDER_ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Where the before-pack hook reads the binary for this platform from. */
function shippedFfmpegPath(repo, platform) {
  if (platform === 'darwin') return join(repo, 'ffmpeg-mac', 'ffmpeg')
  return join(repo, 'node_modules', 'ffmpeg-static', platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
}

/**
 * Why this pin cannot be used, or null. A pin names one release build by its immutable address
 * (`/download/macos/<arch>/<build id>_<version>/ffmpeg.zip`) on the one host, with both hashes;
 * a "latest" or redirect address, a snapshot build, another host or a missing hash is refused.
 * @param {any} pin
 * @returns {string | null}
 */
function macFfmpegPinProblem(pin) {
  if (!pin || typeof pin !== 'object') return 'the macOS ffmpeg pin is missing'
  if (pin.platform !== 'darwin') return `the macOS ffmpeg pin is for "${pin.platform}", not darwin`
  const folder = PIN_ARCH_FOLDER[pin.arch]
  if (!folder) return `the macOS ffmpeg pin names an architecture with no pinned builds: "${pin.arch}"`
  if (typeof pin.version !== 'string' || !/^\d+(\.\d+){1,2}$/.test(pin.version)) return `the macOS ffmpeg pin must name a release version (e.g. 9.0.2), not "${pin.version}"`
  for (const key of ['archiveSha256', 'binarySha256', 'contentSha256']) {
    if (typeof pin[key] !== 'string' || !HEX64.test(pin[key])) return `the macOS ffmpeg pin has no valid ${key} (64 lower-case hex digits)`
  }
  let url
  try { url = new URL(String(pin.url)) } catch { return `the macOS ffmpeg pin's address is not a URL: ${pin.url}` }
  const escaped = pin.version.replace(/\./g, '\\.')
  const path = new RegExp(`^/download/macos/${folder}/\\d+_${escaped}/ffmpeg\\.zip$`)
  if (url.protocol !== 'https:' || url.host !== PIN_HOST || url.search || url.hash || url.username || url.password || !path.test(url.pathname)) {
    return `the macOS ffmpeg pin's address is not a pinned build: ${pin.url} (expected https://${PIN_HOST}/download/macos/${folder}/<build id>_${pin.version}/ffmpeg.zip; never a "latest" or redirect address)`
  }
  return null
}

/** The architecture electron-builder is packing, as a name; null when it was not said. */
function builderArchName(arch) {
  if (arch === undefined || arch === null) return null
  return typeof arch === 'number' ? (BUILDER_ARCH[arch] ?? String(arch)) : String(arch)
}

/**
 * @param {{ binary: string, targets: string[], read: (path: string) => Buffer | null,
 *           pin?: { binarySha256: string, version?: string, arch?: string } | null, arch?: string | number | null }} input
 *   `pin`: the macOS pin; when given, only a binary with its SHA-256 is accepted, in every target.
 * @returns {string | null} why this package cannot be made, or null
 */
function ffmpegShipProblem(input) {
  const pin = input.pin || null
  const bytes = input.read(input.binary)
  if (!bytes || bytes.length < 1024 * 1024) {
    return pin
      ? `the ffmpeg that ships with TalkWeaver on macOS is missing (${input.binary}); run npm run fetch:ffmpeg-mac`
      : `the ffmpeg that ships with TalkWeaver is missing (${input.binary}); run npm install (ffmpeg-static downloads it)`
  }
  if (pin) {
    const arch = builderArchName(input.arch)
    if (arch && pin.arch && arch !== pin.arch) {
      return `the pinned macOS ffmpeg is for ${pin.arch}; this package is for ${arch}. Pin a build for ${arch} in scripts/lib/ffmpeg-mac-pin.json first.`
    }
    if (bytes.includes(NONFREE)) {
      return `the ffmpeg in ${input.binary} was built with --enable-nonfree, which FFmpeg marks unredistributable; macOS ships only a plain-GPL build. See _ADR/0003, amendment of 2026-10-09.`
    }
    const actual = sha256(bytes)
    if (actual !== pin.binarySha256) {
      return `the ffmpeg in ${input.binary} is not the pinned build (SHA-256 ${actual}, pinned ${pin.binarySha256}); run npm run fetch:ffmpeg-mac`
    }
    return null
  }
  const distributed = input.targets.filter((name) => name !== 'dir')
  if (distributed.length && bytes.includes(NONFREE)) {
    return `the ffmpeg in ${input.binary} was built with --enable-nonfree, which FFmpeg marks unredistributable, so it cannot go into a ${distributed.join(', ')} package. Unpacked builds (--dir) are allowed. See _ADR/0003, amendment of 2026-10-09.`
  }
  return null
}

/**
 * The GPL text and the notice that ship beside the macOS binary: both there, and the notice names
 * the pinned version, address and hash, so it cannot drift from what is shipped.
 * @param {{ licence: string | null, notice: string | null, pin: { version: string, url: string, binarySha256: string } }} input
 * @returns {string | null}
 */
function macFfmpegNoticeProblem(input) {
  if (!input.licence || !/GNU GENERAL PUBLIC LICENSE\s+Version 3/.test(input.licence)) return 'resources/ffmpeg-mac/COPYING.GPLv3 (the GPL v3 text that ships beside ffmpeg) is missing'
  if (!input.notice) return 'resources/ffmpeg-mac/FFMPEG-NOTICE.md (the notice that ships beside ffmpeg) is missing'
  const missing = ['version', 'url', 'binarySha256'].filter((key) => !input.notice.includes(input.pin[key]))
  if (missing.length) return `resources/ffmpeg-mac/FFMPEG-NOTICE.md does not name the pinned ${missing.join(', ')}; update it with scripts/lib/ffmpeg-mac-pin.json`
  // The corresponding source is attached to every release that ships this binary (owner's decision,
  // 2026-10-09): the notice names that asset and the build-script revision, and promises nothing else.
  const asset = `${ffmpegSourceAssetBase('<version>', input.pin.version)}.tar`
  if (!input.notice.includes(asset)) return `resources/ffmpeg-mac/FFMPEG-NOTICE.md does not name the release asset that holds the corresponding source (${asset})`
  // Where: the release the app came from (the release workflow uploads the source to the repository
  // electron-builder publishes to), never a named repository that might not hold that release.
  if (!/same GitHub release/.test(input.notice)) return 'resources/ffmpeg-mac/FFMPEG-NOTICE.md does not say the source is on the same GitHub release the app was downloaded from'
  const revision = input.pin.source && input.pin.source.buildScriptRevision
  if (!revision || !input.notice.includes(revision)) return 'resources/ffmpeg-mac/FFMPEG-NOTICE.md does not name the build-script revision pinned in scripts/lib/ffmpeg-mac-pin.json (source.buildScriptRevision)'
  if (SOURCE_ON_REQUEST.test(input.notice)) return 'resources/ffmpeg-mac/FFMPEG-NOTICE.md promises to send the source on request; the source is attached to the release instead, and the notice says only that'
  return null
}

/** Words of an open-ended "ask us and we will send it" offer, which the notices must not make. */
const SOURCE_ON_REQUEST = /\b(ask|write to|contact)\b[^.]*\b(send|post|mail|provide)\b[^.]*\bsource\b|\bsend you the source\b|\bon request\b|\bupon request\b/i

/**
 * The fixed name of the release assets that hold ffmpeg's corresponding source, without extension:
 * `<base>.tar` (the bundle) and `<base>.SHA256SUMS` (its hash).
 * @param {string} appVersion TalkWeaver's version (package.json), or `<version>` in the notices
 * @param {string} ffmpegVersion
 */
function ffmpegSourceAssetBase(appVersion, ffmpegVersion) {
  return `TalkWeaver-${appVersion}-ffmpeg-${ffmpegVersion}-corresponding-source`
}

/** Where the staged macOS binary is, inside the app electron-builder has just laid out. */
function stagedMacFfmpegPath(appOutDir, productFilename) {
  return join(appOutDir, `${productFilename}.app`, 'Contents', 'Resources', 'ffmpeg', 'ffmpeg')
}

/**
 * Why the ffmpeg staged inside the app cannot be signed and shipped, or null.
 * @param {{ app: string, pin: { binarySha256: string }, lstat: (path: string) => import('node:fs').Stats | null,
 *           read: (path: string) => Buffer | null }} input
 *   `app`: the staged `<productFilename>.app`; `lstat` does not follow links (null when missing).
 * @returns {string | null}
 */
function stagedMacFfmpegProblem(input) {
  const parts = ['Contents', 'Resources', 'ffmpeg']
  let at = input.app
  for (const part of parts) {
    at = join(at, part)
    const stat = input.lstat(at)
    if (!stat) return `the staged app has no ${at}; the pinned macOS ffmpeg was not copied into it`
    if (stat.isSymbolicLink() || !stat.isDirectory()) return `refused: ${at} in the staged app is not a plain folder (a link or a file)`
  }
  const binary = join(at, 'ffmpeg')
  const stat = input.lstat(binary)
  if (!stat) return `the staged app has no ffmpeg at ${binary}`
  if (stat.isSymbolicLink() || !stat.isFile()) return `refused: the staged ffmpeg (${binary}) is not a plain file (a link or something else)`
  if ((stat.mode & 0o111) !== 0o111) return `refused: the staged ffmpeg (${binary}) cannot be run (mode ${(stat.mode & 0o777).toString(8)}; it must be executable by everyone, 755)`
  const bytes = input.read(binary)
  if (!bytes) return `the staged ffmpeg (${binary}) could not be read`
  if (bytes.includes(NONFREE)) return `refused: the staged ffmpeg (${binary}) was built with --enable-nonfree`
  const actual = sha256(bytes)
  if (actual !== input.pin.binarySha256) return `refused: the staged ffmpeg (${binary}) is not the pinned build (SHA-256 ${actual}, pinned ${input.pin.binarySha256}); it changed after the before-pack check`
  return null
}

/** The attestation afterPack writes beside the staged binary; the app's signature then seals it. */
const MAC_FFMPEG_ATTESTATION = 'ffmpeg.pin.json'

/**
 * What afterPack records inside the app once it has checked the staged binary: the pinned version,
 * the SHA-256 of the bytes it checked (before signing) and the SHA-256 of the pin file it checked them
 * against. scripts/verify-mac-package.mjs requires it, so an app laid out without afterPack (a
 * prepackaged one) is refused there.
 * @param {{ pin: { version: string, arch?: string }, pinBytes: Buffer, binarySha256: string }} input
 */
function macFfmpegAttestation(input) {
  return {
    about: 'Written by TalkWeaver\'s packaging (scripts/electron-builder-staged-check.cjs, afterPack) after it checked the ffmpeg beside this file against the pin, before the app was signed. Checked by scripts/verify-mac-package.mjs.',
    version: input.pin.version,
    arch: input.pin.arch,
    binarySha256: input.binarySha256,
    pinSha256: sha256(input.pinBytes),
  }
}

/**
 * Why this attestation does not vouch for the committed pin, or null: it must name the pin's version,
 * architecture and binary SHA-256, and the SHA-256 of the pin file. (That the binary itself is built
 * for that architecture is checked by scripts/verify-mac-package.mjs, from the binary.)
 * @param {{ text: string | null, pin: { version: string, arch: string, binarySha256: string }, pinBytes: Buffer }} input
 */
function macFfmpegAttestationProblem(input) {
  if (input.text === null || input.text === undefined) return `refused: the app has no ${MAC_FFMPEG_ATTESTATION} beside ffmpeg, so its ffmpeg was never checked by afterPack (an app laid out some other way, such as electron-builder --prepackaged). Package from the checkout.`
  let attestation
  try { attestation = JSON.parse(input.text) } catch { return `refused: ${MAC_FFMPEG_ATTESTATION} in the app is not JSON` }
  if (!attestation || typeof attestation !== 'object') return `refused: ${MAC_FFMPEG_ATTESTATION} in the app is not an object`
  if (attestation.version !== input.pin.version) return `refused: ${MAC_FFMPEG_ATTESTATION} names FFmpeg ${attestation.version}; the pin is ${input.pin.version}`
  if (typeof attestation.arch !== 'string' || !attestation.arch) return `refused: ${MAC_FFMPEG_ATTESTATION} names no architecture; the pin is for ${input.pin.arch}`
  if (attestation.arch !== input.pin.arch) return `refused: ${MAC_FFMPEG_ATTESTATION} names the architecture ${attestation.arch}; the pin is for ${input.pin.arch}`
  if (attestation.binarySha256 !== input.pin.binarySha256) return `refused: ${MAC_FFMPEG_ATTESTATION} says the checked binary had SHA-256 ${attestation.binarySha256}; the pin is ${input.pin.binarySha256}`
  const pinSha = sha256(input.pinBytes)
  if (attestation.pinSha256 !== pinSha) return `refused: ${MAC_FFMPEG_ATTESTATION} was written against another pin file (SHA-256 ${attestation.pinSha256}; scripts/lib/ffmpeg-mac-pin.json is ${pinSha})`
  return null
}

const MH_MAGIC_64 = 0xfeedfacf
const LC_SEGMENT_64 = 0x19
const LC_CODE_SIGNATURE = 0x1d

/**
 * The SHA-256 of a thin 64-bit Mach-O whose code signature has been removed
 * (`codesign --remove-signature`), with the one header field that signing changes besides the
 * signature itself, the __LINKEDIT segment's vmsize, set to zero. The published binary and any copy
 * of it re-signed (by electron-builder, ad hoc or with a Developer ID) give the same value; any other
 * change to the program does not. The pin records it as `contentSha256`.
 * @param {Buffer} stripped
 * @returns {{ sha256: string } | { problem: string }}
 */
function machoContentSha256(stripped) {
  if (!stripped || stripped.length < 32 || stripped.readUInt32LE(0) !== MH_MAGIC_64) return { problem: 'not a thin 64-bit Mach-O program' }
  const bytes = Buffer.from(stripped)
  const ncmds = bytes.readUInt32LE(16)
  const sizeofcmds = bytes.readUInt32LE(20)
  if (32 + sizeofcmds > bytes.length) return { problem: 'its load commands run past the end of the file' }
  let at = 32
  let linkedit = 0
  for (let i = 0; i < ncmds; i++) {
    if (at + 8 > 32 + sizeofcmds) return { problem: 'a load command runs past the load-command area' }
    const cmd = bytes.readUInt32LE(at)
    const size = bytes.readUInt32LE(at + 4)
    if (size < 8 || at + size > 32 + sizeofcmds) return { problem: 'a load command has an impossible size' }
    if (cmd === LC_CODE_SIGNATURE) return { problem: 'it still carries a code signature (remove it first)' }
    if (cmd === LC_SEGMENT_64 && size >= 72 && bytes.subarray(at + 8, at + 24).toString('latin1').replace(/\0+$/, '') === '__LINKEDIT') {
      bytes.fill(0, at + 32, at + 40)
      linkedit++
    }
    at += size
  }
  if (linkedit !== 1) return { problem: `it has ${linkedit} __LINKEDIT segments, not one` }
  return { sha256: sha256(bytes) }
}

module.exports = { MAC_FFMPEG_ATTESTATION, macFfmpegAttestation, macFfmpegAttestationProblem, machoContentSha256, stagedMacFfmpegPath, stagedMacFfmpegProblem, ffmpegShipProblem, ffmpegSourceAssetBase, macFfmpegNoticeProblem, macFfmpegPinProblem, sha256, shippedFfmpegPath, NONFREE, SOURCE_ON_REQUEST }
