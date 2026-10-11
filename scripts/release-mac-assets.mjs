// The one way Mac release files reach GitHub (ticket 08; docs/RELEASING.md). release.yml's macOS job
// packages with `electron-builder --mac --publish never`, then runs
//
//   node scripts/release-mac-assets.mjs --repo <owner/repo> --tag <vX.Y.Z> <file> [more files]
//
// with the exact files to attach: the dmg, the zip, the ffmpeg corresponding-source tar and its
// SHA256SUMS. Nothing is globbed here. In order, and stopping at the first refusal:
//   1. each file (a plain file, not a link; no two with the same name) is copied into a new private
//      temporary folder, and from then on only the copies are used;
//   2. the copies are hashed; every .dmg and .zip copy must pass scripts/verify-mac-package.mjs
//      --require-signed; a .SHA256SUMS copy must name only files in the list, with their hashes; then
//      the copies are hashed again and must be unchanged. So the bytes uploaded are the bytes verified;
//   3. the release for the tag must not exist yet, or be a draft holding none of these names: a
//      published release, or an asset already there under one of the names, is refused (nothing is
//      ever replaced or skipped);
//   4. the draft is made if needed (the ids of the assets already on it are recorded) and the copies
//      uploaded one by one; each uploaded asset is then downloaded back and its SHA-256 compared with its
//      verified copy. Any failure (an upload that reports failure may still have been stored) lists the
//      draft again and deletes only what this run made: an asset under one of this run's names, whose id
//      was not on the draft before the uploads, and whose size is that of this run's verified copy. An
//      upload refused because the name already exists deletes nothing under that name (another publisher
//      may be uploading). If the draft cannot be listed, nothing is deleted.
// Exit 0 when every file is on the draft with the verified bytes; otherwise 1.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, chmodSync, copyFileSync, createReadStream, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyMacPackage } from './verify-mac-package.mjs'

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const TAG = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
/** Asset names: no glob characters (gh release download --pattern) and nothing GitHub would rename. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/

const sha256File = (path) => new Promise((done, fail) => {
  const hash = createHash('sha256')
  createReadStream(path).on('error', fail).on('data', (chunk) => hash.update(chunk)).on('end', () => done(hash.digest('hex')))
})

/** The real gh, its output captured. */
export function realGh(args) {
  return spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/**
 * Why a SHA256SUMS file does not vouch for the files beside it, or null.
 * @param {string} text
 * @param {Map<string, string>} hashes name → SHA-256 of the copies
 */
export function sumsProblem(text, hashes) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  if (!lines.length) return 'it names no file'
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) [ *]?(.+)$/.exec(line)
    if (!match) return `it has a line that is not "<sha256>  <name>": ${line}`
    const name = basename(match[2].trim())
    if (!hashes.has(name)) return `it names ${name}, which is not among the files being released`
    if (hashes.get(name) !== match[1]) return `it gives ${name} the SHA-256 ${match[1]}; the file being released has ${hashes.get(name)}`
  }
  return null
}

/**
 * @param {{ repo: string, tag: string, files: string[], gh?: (args: string[]) => { status: number | null, stdout?: string, stderr?: string },
 *           verify?: (path: string) => { problems: string[] }, log?: (line: string) => void, scratchRoot?: string }} input
 *   `gh` and `verify` are handed in by tests; the defaults are the real gh and
 *   verifyMacPackage(path, { requireSigned: true }).
 * @returns {Promise<{ uploaded: { name: string, sha256: string, path: string }[] }>} throws on any refusal
 */
export async function releaseMacAssets(input) {
  const gh = input.gh ?? realGh
  const verify = input.verify ?? ((path) => verifyMacPackage(path, { requireSigned: true }))
  const log = input.log ?? ((line) => console.log(`release-mac-assets: ${line}`))
  const { repo, tag, files } = input
  if (typeof repo !== 'string' || !REPO.test(repo)) throw new Error(`refused: --repo must be <owner>/<repo>, not ${repo}`)
  if (typeof tag !== 'string' || !TAG.test(tag)) throw new Error(`refused: --tag must be v<major>.<minor>.<patch>[-<pre>], not ${tag}`)
  if (!Array.isArray(files) || !files.length) throw new Error('refused: no files named')
  const names = files.map((file) => basename(file))
  for (const [index, name] of names.entries()) {
    if (!NAME.test(name)) throw new Error(`refused: ${files[index]}: the asset name ${name} may hold only letters, digits and . _ + -`)
    if (names.indexOf(name) !== index) throw new Error(`refused: two files are named ${name}`)
  }
  if (!names.some((name) => /\.(dmg|zip)$/.test(name))) throw new Error('refused: no .dmg or .zip among the files')

  const scratch = mkdtempSync(join(input.scratchRoot ?? tmpdir(), 'tw-release-mac-'))
  chmodSync(scratch, 0o700)
  try {
    // 1. Copies, in a folder only this user can reach.
    const copies = join(scratch, 'verified')
    mkdirSync(copies, { mode: 0o700 })
    const assets = []
    for (const [index, file] of files.entries()) {
      let stat
      try { stat = lstatSync(file) } catch { throw new Error(`refused: ${file} does not exist`) }
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`refused: ${file} is not a plain file (a link, a folder or something else)`)
      const path = join(copies, names[index])
      copyFileSync(file, path, constants.COPYFILE_EXCL)
      chmodSync(path, 0o400)
      assets.push({ name: names[index], path, source: file, size: statSync(path).size })
    }

    // 2. Hash, verify, hash again: only the copies.
    for (const asset of assets) asset.sha256 = await sha256File(asset.path)
    const hashes = new Map(assets.map((asset) => [asset.name, asset.sha256]))
    for (const asset of assets) {
      if (/\.(dmg|zip)$/.test(asset.name)) {
        const { problems } = verify(asset.path)
        if (problems.length) throw new Error(`refused: ${asset.source} did not pass scripts/verify-mac-package.mjs --require-signed:\n${problems.join('\n')}`)
      } else if (/\.SHA256SUMS$/.test(asset.name)) {
        const problem = sumsProblem(readFileSync(asset.path, 'utf8'), hashes)
        if (problem) throw new Error(`refused: ${asset.source}: ${problem}`)
      }
    }
    for (const asset of assets) {
      if (await sha256File(asset.path) !== asset.sha256) throw new Error(`refused: the verified copy of ${asset.name} changed while it was being verified`)
    }
    log(`verified ${assets.map((asset) => `${asset.name} (${asset.sha256})`).join(', ')}`)

    // 3. The release: none, or a draft without these names.
    const view = gh(['release', 'view', tag, '--repo', repo, '--json', 'isDraft,assets'])
    /** The ids of the assets on the draft before this run uploads anything. */
    const before = new Set()
    if (view.status === 0) {
      let release
      try { release = JSON.parse(view.stdout) } catch { throw new Error(`refused: gh release view ${tag} gave no JSON`) }
      if (release.isDraft !== true) throw new Error(`refused: the release ${tag} on ${repo} is already published; a published release is never added to`)
      for (const asset of release.assets ?? []) if (asset.id !== undefined && asset.id !== null) before.add(String(asset.id))
      const there = new Set((release.assets ?? []).map((asset) => asset.name))
      const clash = names.filter((name) => there.has(name))
      if (clash.length) throw new Error(`refused: the draft ${tag} on ${repo} already holds ${clash.join(', ')}; delete them from the draft by hand first (nothing is ever replaced)`)
    } else if (/release not found/i.test(`${view.stderr ?? ''}${view.stdout ?? ''}`)) {
      const create = gh(['release', 'create', tag, '--repo', repo, '--draft', '--title', tag.slice(1), '--notes', ''])
      if (create.status !== 0) throw new Error(`refused: could not make the draft ${tag} on ${repo}: ${String(create.stderr ?? '').trim()}`)
      log(`made the draft ${tag} on ${repo}`)
    } else {
      throw new Error(`refused: could not tell whether ${repo} has a release ${tag}: ${String(view.stderr ?? '').trim()}`)
    }

    // 4. Upload, download back, compare; undo on any failure.
    /** Names whose upload GitHub refused because an asset of that name was already there: never deleted. */
    const contested = new Set()
    try {
      for (const asset of assets) {
        const upload = gh(['release', 'upload', tag, asset.path, '--repo', repo])
        if (upload.status !== 0) {
          const said = `${upload.stderr ?? ''}${upload.stdout ?? ''}`.trim()
          if (/already[ _-]?exists|conflict|HTTP 409/i.test(said)) {
            contested.add(asset.name)
            throw new Error(`the upload of ${asset.name} was refused because an asset of that name is already on the draft, put there after this run checked it: another publisher may be uploading to ${tag}. Nothing under that name was deleted (${said})`)
          }
          throw new Error(`the upload of ${asset.name} failed: ${said}`)
        }
      }
      for (const asset of assets) {
        const back = join(scratch, 'downloaded', asset.name.replace(/[^A-Za-z0-9]/g, '_'))
        mkdirSync(back, { recursive: true, mode: 0o700 })
        const download = gh(['release', 'download', tag, '--repo', repo, '--pattern', asset.name, '--dir', back])
        if (download.status !== 0) throw new Error(`${asset.name} could not be downloaded back: ${String(download.stderr ?? '').trim()}`)
        let got
        try { got = await sha256File(join(back, asset.name)) } catch { throw new Error(`${asset.name} was not downloaded back`) }
        if (got !== asset.sha256) throw new Error(`${asset.name} on the release has SHA-256 ${got}; the verified file has ${asset.sha256}`)
      }
    } catch (error) {
      // An upload can fail after GitHub stored the file (a reset connection), so what this run uploaded
      // is read from the draft again. Only an asset this run made is deleted: one of this run's names (and
      // not a contested one), an id that was not on the draft before the uploads, and the size of this
      // run's verified copy. An asset another publisher put there under the same name is left alone.
      const ours = new Map(assets.filter((asset) => !contested.has(asset.name)).map((asset) => [asset.name, asset.size]))
      const listed = gh(['release', 'view', tag, '--repo', repo, '--json', 'assets'])
      let present = null
      if (listed.status === 0) {
        try {
          present = (JSON.parse(listed.stdout).assets ?? [])
            .filter((asset) => ours.has(asset.name) && asset.id !== undefined && asset.id !== null && !before.has(String(asset.id)) && asset.size === ours.get(asset.name))
            .map((asset) => asset.name)
        } catch { present = null }
      }
      const left = []
      for (const name of present ?? []) {
        const removed = gh(['release', 'delete-asset', tag, name, '--repo', repo, '--yes'])
        if (removed.status !== 0) left.push(name)
      }
      const outcome = present
        ? `Deleted from the draft the assets this run uploaded (${present.length ? present.join(', ') : 'none was there'})${left.length ? `, except ${left.join(', ')}: delete those by hand` : ''}`
        : `Could not list the draft (${String(listed.stderr ?? '').trim() || 'no JSON'}), so nothing was deleted: check the draft by hand for ${names.join(', ')}`
      throw new Error(`refused: ${error.message}. ${outcome}.`)
    }
    for (const asset of assets) log(`on the draft ${tag} of ${repo}: ${asset.name} (${asset.sha256}), downloaded back and identical`)
    return { uploaded: assets.map(({ name, sha256, path }) => ({ name, sha256, path })) }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** --repo <owner/repo> --tag <vX.Y.Z> <files…> */
export function parseArgs(argv) {
  const out = { repo: null, tag: null, files: [] }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--repo' || arg === '--tag') {
      if (index + 1 >= argv.length) throw new Error(`${arg} needs a value`)
      out[arg.slice(2)] = argv[++index]
    } else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`)
    else out.files.push(arg)
  }
  return out
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (process.platform !== 'darwin') throw new Error('needs macOS (scripts/verify-mac-package.mjs)')
    await releaseMacAssets(args)
  } catch (error) {
    console.error(`release-mac-assets: ${error.message}`)
    console.error('Usage: node scripts/release-mac-assets.mjs --repo <owner/repo> --tag <vX.Y.Z> <file> [more files]')
    process.exitCode = 1
  }
}
