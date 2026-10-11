// electron-builder `afterPack` (ticket 08, ADR-0003 amendment of 2026-10-09): what is signed and
// shipped is what was checked.
//
// afterPack runs after electron-builder has copied the app files and extraResources into the staged
// app, before it signs it. On macOS the ffmpeg inside the staged app
// (<appOutDir>/TalkWeaver.app/Contents/Resources/ffmpeg/ffmpeg) must have the pinned SHA-256, be a
// plain file reached through no link, be runnable and not be a nonfree build
// (scripts/lib/ffmpeg-ship-check.cjs, stagedMacFfmpegProblem). The before-pack hook checks
// ffmpeg-mac/ffmpeg; this checks the copy, which is the file that ships.
//
// Once the copy passes, this writes the attestation Contents/Resources/ffmpeg/ffmpeg.pin.json (the
// pinned version, the SHA-256 of the bytes checked, the SHA-256 of the pin file). electron-builder
// signs after afterPack, so the app's signature seals the attestation together with the binary.
//
// This hook keeps no state between calls and authorises nothing. Whether a package may be released is
// decided afterwards, from the package alone, by scripts/verify-mac-package.mjs: it refuses an app
// with no attestation (one laid out without this hook, e.g. electron-builder --prepackaged), an
// attestation that does not match the committed pin, a broken signature, and a binary that is not the
// pinned program. That verifier is the release gate (docs/RELEASING.md), not this hook.
'use strict'
const { lstatSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { MAC_FFMPEG_ATTESTATION, macFfmpegAttestation, macFfmpegPinProblem, stagedMacFfmpegProblem } = require('./lib/ffmpeg-ship-check.cjs')

const PIN_FILE = join(__dirname, 'lib', 'ffmpeg-mac-pin.json')
const lstatOrNull = (path) => { try { return lstatSync(path) } catch { return null } }
const readOrNull = (path) => { try { return readFileSync(path) } catch { return null } }

/**
 * @param {{ readPinBytes?: () => Buffer, lstat?: (path: string) => any, read?: (path: string) => Buffer | null }} [deps]
 */
function createStagedCheck(deps = {}) {
  const readPinBytes = deps.readPinBytes || (() => readFileSync(PIN_FILE))
  const lstat = deps.lstat || lstatOrNull
  const read = deps.read || readOrNull

  return async function afterPack(context) {
    const platform = context.electronPlatformName
    if (platform !== 'darwin' && platform !== 'mas') return
    const pinBytes = readPinBytes()
    const pin = JSON.parse(pinBytes.toString('utf8'))
    const pinProblem = macFfmpegPinProblem(pin)
    if (pinProblem) throw new Error(pinProblem)
    const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
    const problem = stagedMacFfmpegProblem({ app, pin, lstat, read })
    if (problem) throw new Error(problem)
    const folder = join(app, 'Contents', 'Resources', 'ffmpeg')
    const attestation = join(folder, MAC_FFMPEG_ATTESTATION)
    // 'wx': never follow or replace something already there (nothing else puts a file of this name in the app).
    try {
      writeFileSync(attestation, JSON.stringify(macFfmpegAttestation({ pin, pinBytes, binarySha256: pin.binarySha256 }), null, 2) + '\n', { flag: 'wx', mode: 0o644 })
    } catch (error) {
      throw new Error(`refused: could not write ${attestation} (${error && error.code === 'EEXIST' ? 'something is already there' : error && error.message})`)
    }
    console.log(`  • staged ffmpeg checked: ${join(folder, 'ffmpeg')} is the pinned FFmpeg ${pin.version} (sha256 ${pin.binarySha256}), a plain runnable file; attestation written to ${attestation}`)
  }
}

module.exports = { afterPack: createStagedCheck(), createStagedCheck }
