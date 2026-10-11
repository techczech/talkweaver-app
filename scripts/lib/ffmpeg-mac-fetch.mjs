// Fetch the one ffmpeg build the macOS app ships (ADR-0003, amendment of 2026-10-09), and nothing
// else: the address and both hashes come from scripts/lib/ffmpeg-mac-pin.json. Download and
// extraction are handed in, so scripts/test-transcription-setup.mjs drives this with fixture bytes.
//
// Order, each step refusing before the next: the pin itself (an immutable release address, both
// hashes); a copy already in place with the pinned hash is kept (and set to mode 0755); the downloaded archive's
// SHA-256 (nothing is written before it matches); the extracted `ffmpeg` (a plain file, not a link,
// with the pinned SHA-256 and no --enable-nonfree mark); then it replaces `<outDir>/ffmpeg` in one
// rename, so a half-written binary is never where the build looks.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { NONFREE, macFfmpegPinProblem, sha256 } = require('./ffmpeg-ship-check.cjs')

export const PIN_FILE = join(dirname(fileURLToPath(import.meta.url)), 'ffmpeg-mac-pin.json')

/** The committed pin. */
export function readMacFfmpegPin(file = PIN_FILE) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** Download over HTTPS, following no redirect: a pinned address answers itself. */
export async function downloadPinned(url) {
  const response = await fetch(url, { redirect: 'error' })
  if (!response.ok) throw new Error(`the download answered ${response.status} ${response.statusText}`)
  return Buffer.from(await response.arrayBuffer())
}

/** Unzip with macOS's own ditto (keeps the binary's signature intact). */
export function extractWithDitto(archive, into) {
  if (process.platform !== 'darwin') throw new Error('the macOS ffmpeg is extracted with ditto, which only macOS has; package for macOS on a Mac')
  execFileSync('/usr/bin/ditto', ['-x', '-k', archive, into], { stdio: 'pipe' })
}

/**
 * @param {{ pin: any, outDir: string, download?: (url: string) => Promise<Buffer>, extract?: (archive: string, into: string) => void }} input
 * @returns {Promise<{ path: string, fetched: boolean }>}
 */
export async function ensurePinnedMacFfmpeg({ pin, outDir, download = downloadPinned, extract = extractWithDitto }) {
  const problem = macFfmpegPinProblem(pin)
  if (problem) throw new Error(problem)
  const target = join(outDir, 'ffmpeg')
  if (existsSync(target) && lstatSync(target).isFile() && sha256(readFileSync(target)) === pin.binarySha256) {
    // A kept copy is made runnable too: electron-builder copies the file with its mode, and the
    // staged check (afterPack) refuses a binary that cannot be run.
    chmodSync(target, 0o755)
    return { path: target, fetched: false }
  }

  const archive = await download(pin.url)
  const archiveHash = sha256(archive)
  if (archiveHash !== pin.archiveSha256) throw new Error(`refused: the archive from ${pin.url} has SHA-256 ${archiveHash}, not the pinned ${pin.archiveSha256}; nothing was written`)

  mkdirSync(outDir, { recursive: true })
  const work = mkdtempSync(join(outDir, '.fetch-'))
  try {
    const zip = join(work, 'ffmpeg.zip')
    writeFileSync(zip, archive)
    const into = join(work, 'x')
    mkdirSync(into)
    extract(zip, into)
    const extracted = join(into, 'ffmpeg')
    if (!existsSync(extracted) || !lstatSync(extracted).isFile()) throw new Error(`refused: the pinned archive holds no plain file named ffmpeg at its top level`)
    const bytes = readFileSync(extracted)
    const binaryHash = sha256(bytes)
    if (binaryHash !== pin.binarySha256) throw new Error(`refused: the extracted ffmpeg has SHA-256 ${binaryHash}, not the pinned ${pin.binarySha256}`)
    if (bytes.includes(NONFREE)) throw new Error('refused: the pinned ffmpeg was built with --enable-nonfree (unredistributable)')
    chmodSync(extracted, 0o755)
    renameSync(extracted, target)
    return { path: target, fetched: true }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
