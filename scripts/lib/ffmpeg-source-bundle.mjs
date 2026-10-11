// The GPL corresponding source of the ffmpeg the macOS app ships, packed into one release asset
// (owner's decision of 2026-10-09: attached to every GitHub release that ships the Mac ffmpeg).
// What goes in is fixed by scripts/lib/ffmpeg-mac-source-manifest.json: FFmpeg, the build scripts at
// the revision that built the binary, every library linked into it and the Rust crates rav1e is built
// from, each by its address and SHA-256. The download is handed in, so
// scripts/test-ffmpeg-source-bundle.mjs drives this with fixture bytes and no network.
//
// Order, each step refusing before the next: the manifest itself (https addresses, a SHA-256 for
// each, no moving "master"/"latest" address, safe file names); each file, from the cache when its
// hash matches, else downloaded and kept only when its SHA-256 is the pinned one; the crate list
// against rav1e's own Cargo.lock; then the tar is written beside its final name and renamed into
// place, with a SHA256SUMS file. Nothing lands in the output folder unless every file matched.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { get as httpsGet } from 'node:https'

const require = createRequire(import.meta.url)
const { ffmpegSourceAssetBase, sha256 } = require('./ffmpeg-ship-check.cjs')

export const SOURCE_MANIFEST_FILE = join(dirname(fileURLToPath(import.meta.url)), 'ffmpeg-mac-source-manifest.json')
const HEX64 = /^[0-9a-f]{64}$/
const HEX40 = /^[0-9a-f]{40}$/
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
/** Address parts that name a moving target rather than one fixed file. */
const MOVING = /\/(master|main|latest|HEAD)(\/|\.|$)|[?&]ref=|\/redirect\//i

export function readSourceManifest(file = SOURCE_MANIFEST_FILE) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** Every file the bundle holds: where it goes inside the bundle, where it comes from, its hash. */
export function sourceEntries(manifest) {
  const entries = [
    { path: `ffmpeg/${manifest.ffmpeg.file}`, url: manifest.ffmpeg.url, sha256: manifest.ffmpeg.sha256 },
    { path: `build-script/${manifest.buildScript.file}`, url: manifest.buildScript.url, sha256: manifest.buildScript.sha256 },
    ...manifest.libraries.map((lib) => ({ path: `libraries/${lib.file}`, url: lib.url, sha256: lib.sha256 })),
    ...manifest.rustCrates.crates.map((crate) => ({ path: `libraries/${manifest.rustCrates.for}-crates/${crate.name}-${crate.version}.crate`, url: crate.url, sha256: crate.sha256 })),
  ]
  return entries
}

/**
 * Why this manifest cannot be used, or null.
 * @param {any} manifest
 * @param {{ ffmpegSha256?: string, buildScriptRevision?: string } | null} [pinSource] the pin's `source`, to agree with
 */
export function sourceManifestProblem(manifest, pinSource = null) {
  if (!manifest || typeof manifest !== 'object') return 'the ffmpeg source manifest is missing'
  for (const key of ['ffmpeg', 'buildScript', 'libraries', 'rustCrates']) if (!manifest[key]) return `the ffmpeg source manifest has no ${key}`
  if (!Array.isArray(manifest.libraries) || !manifest.libraries.length) return 'the ffmpeg source manifest lists no libraries'
  if (!Array.isArray(manifest.rustCrates.crates)) return 'the ffmpeg source manifest has no rustCrates.crates list'
  if (!HEX40.test(String(manifest.buildScript.commit))) return 'the ffmpeg source manifest names no build-script commit (40 hex digits)'
  if (!String(manifest.buildScript.url).includes(manifest.buildScript.commit)) return `the build-script archive address does not name the pinned commit: ${manifest.buildScript.url}`
  if (pinSource) {
    if (pinSource.ffmpegSha256 && manifest.ffmpeg.sha256 !== pinSource.ffmpegSha256) return 'the ffmpeg source manifest and scripts/lib/ffmpeg-mac-pin.json name different FFmpeg source hashes'
    if (manifest.buildScript.commit !== pinSource.buildScriptRevision) return 'the ffmpeg source manifest and scripts/lib/ffmpeg-mac-pin.json name different build-script revisions'
  }
  const seen = new Set()
  for (const lib of manifest.libraries) {
    if (!lib || !SAFE_FILE.test(String(lib.file)) || !lib.name || !lib.version) return `a library in the ffmpeg source manifest has no name, version or safe file name: ${JSON.stringify(lib)}`
  }
  for (const crate of manifest.rustCrates.crates) {
    if (!crate || !SAFE_FILE.test(`${crate.name}-${crate.version}`)) return `a crate in the ffmpeg source manifest has no safe name and version: ${JSON.stringify(crate)}`
  }
  for (const entry of sourceEntries(manifest)) {
    if (seen.has(entry.path)) return `the ffmpeg source manifest names ${entry.path} twice`
    seen.add(entry.path)
    if (!SAFE_FILE.test(entry.path.split('/').pop())) return `unsafe file name in the ffmpeg source manifest: ${entry.path}`
    if (typeof entry.sha256 !== 'string' || !HEX64.test(entry.sha256)) return `${entry.path} is not pinned by a SHA-256 (64 lower-case hex digits)`
    let url
    try { url = new URL(String(entry.url)) } catch { return `${entry.path} has no address: ${entry.url}` }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return `${entry.path} is not fetched from a plain https address: ${entry.url}`
    if (MOVING.test(url.pathname + url.search)) return `${entry.path} names a moving address (${entry.url}); pin a release or a commit`
  }
  return null
}

/**
 * Download over HTTPS (redirects followed, to https addresses only: the bytes are checked against the
 * pin, not the address). Node's plain https client, not `fetch`: `fetch` always sends
 * `sec-fetch-mode: cors`, and the GitLab hosts (gitlab.com, code.videolan.org) answer any request
 * carrying it with 406 Not Acceptable (seen 2026-10-11 for dav1d, x264 and SVT-AV1).
 */
export function downloadSource(url, redirectsLeft = 10) {
  return new Promise((done, fail) => {
    const at = new URL(url)
    if (at.protocol !== 'https:') { fail(new Error(`${url} is not an https address`)); return }
    httpsGet(at, { headers: { 'user-agent': 'talkweaver-ffmpeg-source-bundle', accept: '*/*' } }, (response) => {
      const status = response.statusCode ?? 0
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume()
        if (redirectsLeft <= 0) { fail(new Error(`${url} redirected too many times`)); return }
        let next
        try { next = new URL(response.headers.location, at).href } catch { fail(new Error(`${url} redirected to an address that cannot be read`)); return }
        downloadSource(next, redirectsLeft - 1).then(done, fail)
        return
      }
      if (status < 200 || status > 299) { response.resume(); fail(new Error(`${url} answered ${status} ${response.statusMessage ?? ''}`.trimEnd())); return }
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('error', fail)
      response.on('aborted', () => fail(new Error(`${url} stopped before the file was complete`)))
      response.on('end', () => done(Buffer.concat(chunks)))
    }).on('error', fail)
  })
}

/** The files of a .tar.gz, by path, read in memory (for the small archives this checks inside). */
export function readTarGz(bytes) {
  const tar = gunzipSync(bytes)
  const files = new Map()
  let longName = null
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512)
    if (header.every((byte) => byte === 0)) break
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '')
    const size = parseInt(field(124, 12).trim() || '0', 8)
    const type = field(156, 1)
    const prefix = field(345, 155)
    let name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
    longName = null
    const body = tar.subarray(at + 512, at + 512 + size)
    if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '')
    else if (type === 'x') {
      const path = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))
      if (path) longName = path[1]
    } else if (type === '0' || type === '') files.set(name, body)
    at += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

/** The registry crates a Cargo.lock names, as `name@version` → checksum. */
export function cargoLockCrates(lockText) {
  const crates = new Map()
  for (const block of lockText.split('[[package]]').slice(1)) {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1]
    const version = /^version = "([^"]+)"/m.exec(block)?.[1]
    const source = /^source = "([^"]+)"/m.exec(block)?.[1]
    const checksum = /^checksum = "([^"]+)"/m.exec(block)?.[1]
    if (name && version && source && source.startsWith('registry+')) crates.set(`${name}@${version}`, checksum ?? null)
  }
  return crates
}

/** Why the crate list differs from the Cargo.lock in the pinned rav1e archive, or null. */
export function crateListProblem(manifest, rustArchive) {
  const lockPath = manifest.rustCrates.lockFile
  const lock = readTarGz(rustArchive).get(lockPath)
  if (!lock) return `the pinned ${manifest.rustCrates.for} archive holds no ${lockPath}`
  const locked = cargoLockCrates(lock.toString('utf8'))
  const listed = new Map(manifest.rustCrates.crates.map((crate) => [`${crate.name}@${crate.version}`, crate.sha256]))
  for (const [key, checksum] of locked) {
    if (!listed.has(key)) return `${lockPath} names the crate ${key}, which the ffmpeg source manifest does not list`
    if (listed.get(key) !== checksum) return `the ffmpeg source manifest pins ${key} by another SHA-256 than ${lockPath}`
  }
  for (const key of listed.keys()) if (!locked.has(key)) return `the ffmpeg source manifest lists the crate ${key}, which ${lockPath} does not name`
  return null
}

function tarHeader(name, size, mode = 0o644, type = '0') {
  const header = Buffer.alloc(512, 0)
  let prefix = ''
  let base = name
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 155)
    prefix = name.slice(0, cut)
    base = name.slice(cut + 1)
    if (cut < 0 || Buffer.byteLength(prefix) > 155 || Buffer.byteLength(base) > 100) throw new Error(`a path too long for the bundle: ${name}`)
  }
  const put = (text, start, length) => header.write(text, start, length, 'utf8')
  const octal = (value, length) => value.toString(8).padStart(length - 1, '0') + '\0'
  put(base, 0, 100)
  put(octal(mode, 8), 100, 8)
  put(octal(0, 8), 108, 8)
  put(octal(0, 8), 116, 8)
  put(octal(size, 12), 124, 12)
  put(octal(0, 12), 136, 12) // mtime 0: the same inputs make the same bytes
  put('        ', 148, 8)
  put(type, 156, 1)
  put('ustar\0', 257, 6)
  put('00', 263, 2)
  put('root', 265, 32)
  put('root', 297, 32)
  put(prefix, 345, 155)
  let sum = 0
  for (const byte of header) sum += byte
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return header
}

function readme(manifest, base, appVersion) {
  const lines = [
    `Corresponding source for the ffmpeg program in TalkWeaver ${appVersion} for macOS`,
    '',
    `TalkWeaver for macOS ships FFmpeg ${manifest.ffmpegVersion}, the static build for Apple silicon made by`,
    `Martin Riedl: ${manifest.build}`,
    'It is licensed under the GNU General Public License, version 3 or later. This archive is its',
    'complete corresponding source:',
    '',
    `- ffmpeg/: the FFmpeg ${manifest.ffmpegVersion} source release.`,
    `- build-script/: the scripts that configured and built the binary, ${manifest.buildScript.repository}`,
    `  at commit ${manifest.buildScript.commit}.`,
    '- REBUILD.txt and rebuild/: how to build the program again from the files in this archive, without',
    '  downloading the sources again (the build scripts alone would fetch x264 from its moving master branch).',
    '- libraries/: the source of every library built into the binary, at the version the build used:',
    ...manifest.libraries.map((lib) => `    ${lib.name} ${lib.version}`),
    `  and libraries/${manifest.rustCrates.for}-crates/, the Rust crates ${manifest.rustCrates.for} is built from, as its Cargo.lock names them.`,
    '- source-manifest.json: where each file came from, with its SHA-256 and notes.',
    '- SHA256SUMS: the SHA-256 of every file in this archive (check with: shasum -a 256 -c SHA256SUMS).',
    '',
    'Not included, because they are not part of the program:',
    ...manifest.notIncluded.map((item) => `- ${item.name}: ${item.why}.`),
    '',
    `Each library keeps its own licence, inside its source archive. Archive: ${base}.tar`,
    '',
  ]
  return lines.join('\n')
}

const REBUILD_DIR = join(dirname(fileURLToPath(import.meta.url)), 'ffmpeg-rebuild')

/** The name of the file an address ends in (`.../x264-master.tar.gz` → `x264-master.tar.gz`). */
// The last segment of a web address (a file name compared as a string, never a path on disk).
const addressFile = (url) => String(url).replace(/^[a-z]+:\/\/[^/]*/i, '').replace(/[?#].*$/, '').split('/').filter((part) => part && part !== 'download').pop()
const archiveStem = (name) => name.replace(/\.(tar\.gz|tgz|tar\.xz|tar\.bz2)$/, '')
const archiveKind = (name) => /\.(tar\.gz|tgz|tar\.xz|tar\.bz2)$/.exec(name)?.[1] ?? null

/**
 * rebuild/url-map.tsv: for each address the pinned build scripts ask for, the file in the bundle that
 * holds it and how rebuild/fetch-from-bundle.sh hands it over (copy, tar.bz2, top=<folder>).
 * `url` is where this bundle fetched the file; `scriptUrl`, when the manifest gives one, is the address
 * the build script itself asks for (another compression, or x264's moving master branch).
 */
export function rebuildUrlMap(manifest) {
  const rows = []
  const add = (url, path, op) => rows.push(`${url}\t${path}\t${op}`)
  const entry = (item, path) => {
    add(item.url, path, 'copy')
    if (!item.scriptUrl || item.scriptUrl === item.url) return
    const want = addressFile(item.scriptUrl)
    const have = item.file
    if (want === have) return add(item.scriptUrl, path, 'copy')
    if (archiveStem(want) !== archiveStem(have) && archiveKind(want) === archiveKind(have)) return add(item.scriptUrl, path, `top=${archiveStem(want)}`)
    if (archiveStem(want) === archiveStem(have) && archiveKind(want) === 'tar.bz2' && archiveKind(have)) return add(item.scriptUrl, path, 'tar.bz2')
    throw new Error(`refused: no way to hand ${have} over as ${want} (the build script's ${item.scriptUrl})`)
  }
  entry(manifest.ffmpeg, `ffmpeg/${manifest.ffmpeg.file}`)
  for (const lib of manifest.libraries) entry(lib, `libraries/${lib.file}`)
  return rows.join('\n') + '\n'
}

function rebuildText(manifest, base) {
  return [
    `Building ffmpeg ${manifest.ffmpegVersion} again from this archive (macOS, Apple silicon)`,
    '',
    'The build scripts in build-script/ download every source themselves, and ask for x264 from its',
    'master branch, which keeps moving. rebuild/build-from-bundle.sh makes them take every source from',
    'this archive instead:',
    '',
    `  tar -xf ${base}.tar`,
    `  cd ${base}`,
    '  rebuild/build-from-bundle.sh ../ffmpeg-build -SKIP_TEST=YES',
    '',
    'It checks every file against SHA256SUMS, unpacks the build scripts into the new folder, replaces',
    'their download() so each address they ask for is answered from this archive (rebuild/url-map.tsv:',
    `FFmpeg ${manifest.ffmpegVersion} recompressed to the .tar.bz2 the scripts expect, x264 at the pinned commit under`,
    'the x264-master/ folder name they expect, every other library as it is), unpacks the Rust crates',
    'for rav1e and points cargo at them offline, then runs build.sh. The program is written to',
    '../ffmpeg-build/out/. Add --prepare-only before the folder to stop before build.sh.',
    '',
    'Requirements are those of the build scripts (build-script/README.md): the Xcode command line',
    'tools, python3 with virtualenv (for meson), rust with cargo and cargo-c. The build tools (nasm,',
    'ninja, pkg-config and its patches, cmake) and SDL (ffplay only) are not part of the ffmpeg program',
    'and are not in this archive; the scripts still download them. TW_REBUILD_OFFLINE=1 refuses every',
    'download that is not in this archive.',
    '',
  ].join('\n')
}

function rebuildMembers(manifest, base) {
  return [
    { path: 'REBUILD.txt', bytes: Buffer.from(rebuildText(manifest, base)) },
    { path: 'rebuild/build-from-bundle.sh', bytes: readFileSync(join(REBUILD_DIR, 'build-from-bundle.sh')), mode: 0o755 },
    { path: 'rebuild/fetch-from-bundle.sh', bytes: readFileSync(join(REBUILD_DIR, 'fetch-from-bundle.sh')), mode: 0o755 },
    { path: 'rebuild/url-map.tsv', bytes: Buffer.from(rebuildUrlMap(manifest)) },
  ]
}

/**
 * Put every pinned file in the cache, check it, and pack the bundle.
 * @param {{ manifest: any, pinSource?: any, appVersion: string, outDir: string, cacheDir: string,
 *           download?: (url: string) => Promise<Buffer>, attempts?: number, retryDelayMs?: number, log?: (line: string) => void }} input
 *   A file already in `cacheDir` with the pinned SHA-256 is used as it is, wherever it came from.
 * @returns {Promise<{ tar: string, sums: string, bytes: number, sha256: string, files: number }>}
 */
export async function assembleSourceBundle({ manifest, pinSource = null, appVersion, outDir, cacheDir, download = downloadSource, attempts = 5, retryDelayMs = 2000, log = () => {} }) {
  const problem = sourceManifestProblem(manifest, pinSource)
  if (problem) throw new Error(`refused: ${problem}`)
  if (!/^\d+\.\d+\.\d+([-.+][0-9A-Za-z.-]+)?$/.test(String(appVersion))) throw new Error(`refused: "${appVersion}" is not a TalkWeaver version`)
  const entries = sourceEntries(manifest)
  mkdirSync(cacheDir, { recursive: true })

  const cached = (entry) => join(cacheDir, entry.path.replaceAll('/', '__'))
  for (const entry of entries) {
    const file = cached(entry)
    if (existsSync(file) && sha256(readFileSync(file)) === entry.sha256) continue
    let last = ''
    let kept = false
    for (let attempt = 1; attempt <= attempts && !kept; attempt++) {
      try {
        const bytes = await download(entry.url)
        const actual = sha256(bytes)
        if (actual === entry.sha256) {
          writeFileSync(`${file}.partial`, bytes)
          renameSync(`${file}.partial`, file)
          kept = true
          log(`fetched ${entry.path} (${bytes.length} bytes)`)
        } else last = `it has SHA-256 ${actual}, not the pinned ${entry.sha256}`
      } catch (error) {
        last = error instanceof Error ? error.message : String(error)
      }
      // Some hosts (code.videolan.org) now and then answer with a bot check instead of the file.
      if (!kept && attempt < attempts) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** (attempt - 1)))
    }
    if (!kept) throw new Error(`refused: ${entry.path} from ${entry.url}: ${last}; no bundle was written`)
  }

  const rustLib = manifest.libraries.find((lib) => lib.name === manifest.rustCrates.for)
  if (manifest.rustCrates.crates.length || rustLib) {
    if (!rustLib) throw new Error(`refused: the ffmpeg source manifest lists crates for ${manifest.rustCrates.for} but not ${manifest.rustCrates.for} itself`)
    const crateProblem = crateListProblem(manifest, readFileSync(cached({ path: `libraries/${rustLib.file}` })))
    if (crateProblem) throw new Error(`refused: ${crateProblem}; no bundle was written`)
  }

  const base = ffmpegSourceAssetBase(appVersion, manifest.ffmpegVersion)
  const members = [
    { path: 'README.txt', bytes: Buffer.from(readme(manifest, base, appVersion)) },
    { path: 'source-manifest.json', bytes: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') },
    ...rebuildMembers(manifest, base),
    ...entries.map((entry) => ({ path: entry.path, file: cached(entry), sha256: entry.sha256 })),
  ]
  const sumsInside = members.map((member) => `${member.sha256 ?? sha256(member.bytes)}  ${member.path}`).join('\n') + '\n'
  members.splice(2, 0, { path: 'SHA256SUMS', bytes: Buffer.from(sumsInside) })

  mkdirSync(outDir, { recursive: true })
  const tar = join(outDir, `${base}.tar`)
  const sums = join(outDir, `${base}.SHA256SUMS`)
  const partial = `${tar}.partial`
  const fd = openSync(partial, 'w')
  const hash = createHash('sha256')
  try {
    const dirs = new Set()
    const write = (buffer) => { hash.update(buffer); writeSync(fd, buffer) }
    for (const member of members) {
      const parts = member.path.split('/')
      for (let i = 1; i < parts.length; i++) {
        const dir = `${base}/${parts.slice(0, i).join('/')}/`
        if (!dirs.has(dir)) { dirs.add(dir); write(tarHeader(dir, 0, 0o755, '5')) }
      }
      const bytes = member.bytes ?? readFileSync(member.file)
      if (member.sha256 && sha256(bytes) !== member.sha256) throw new Error(`refused: ${member.path} changed in the cache while packing`)
      write(tarHeader(`${base}/${member.path}`, bytes.length, member.mode ?? 0o644))
      write(bytes)
      const pad = (512 - (bytes.length % 512)) % 512
      if (pad) write(Buffer.alloc(pad, 0))
    }
    write(Buffer.alloc(1024, 0))
  } catch (error) {
    closeSync(fd)
    rmSync(partial, { force: true })
    throw error
  }
  closeSync(fd)
  const digest = hash.digest('hex')
  renameSync(partial, tar)
  writeFileSync(sums, `${digest}  ${base}.tar\n`)
  return { tar, sums, bytes: statSync(tar).size, sha256: digest, files: entries.length }
}
