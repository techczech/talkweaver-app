// The GPL corresponding source of the macOS ffmpeg (owner's decision of 2026-10-09: attached to every
// GitHub release that ships it). Plain Node, fixture files in a throwaway folder, no network:
// 1. the notices: FFMPEG-NOTICE.md and THIRD-PARTY-NOTICES.md name the release asset and the
//    build-script revision, and no longer offer to send the source on request; the package check
//    (macFfmpegNoticeProblem, run by before-pack) refuses the old wording;
// 2. the committed source manifest: every file pinned by an https address and a SHA-256, no moving
//    address, agreeing with the pin, a source for every library the build configures; and what it refuses;
// 3. the bundle script with the download handed in: the bundle and its SHA256SUMS from fixture bytes,
//    the cache, and a refusal (with nothing written) for a hash mismatch, a crate list that differs
//    from Cargo.lock, and a bad manifest (before any download);
// 4. the rebuild adapter in the bundle (macOS): rebuild/build-from-bundle.sh runs a fixture build.sh
//    whose every source comes from the bundle (x264-style top-folder rename, FFmpeg as .tar.bz2),
//    cargo pointed at the bundled crates, any other download refused offline; and, when the real
//    sources are cached, every library address the pinned build scripts ask for is in the map;
// 5. the release wiring: release.yml packages without publishing and hands the exact dmg, zip and
//    bundle to scripts/release-mac-assets.mjs for the repository electron-builder publishes to;
//    nothing else in it uploads Mac files; RELEASING.md says so; the downloads stay out of git;
// 6. scripts/release-mac-assets.mjs with a fake gh and a fake gate: it verifies and uploads copies (a
//    file changed after copying is not what is uploaded), refuses a published release or a name
//    already on the draft, and deletes what it uploaded when a download back does not match.
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readMacFfmpegPin } from './lib/ffmpeg-mac-fetch.mjs'
import { assembleSourceBundle, cargoLockCrates, readSourceManifest, readTarGz, rebuildUrlMap, sourceEntries, sourceManifestProblem } from './lib/ffmpeg-source-bundle.mjs'
import { releaseMacAssets, sumsProblem } from './release-mac-assets.mjs'

const require = createRequire(import.meta.url)
const { ffmpegSourceAssetBase, macFfmpegNoticeProblem, sha256 } = require('./lib/ffmpeg-ship-check.cjs')
const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (...parts) => readFileSync(join(repo, ...parts), 'utf8')
const scratch = mkdtempSync(join(tmpdir(), 'tw-ffmpeg-source-'))
let passed = 0
const step = async (name, run) => { await run(); passed++; console.log(`ok ${passed} - ${name}`) }

try {
  const pin = readMacFfmpegPin()
  const manifest = readSourceManifest()
  const asset = `${ffmpegSourceAssetBase('<version>', pin.version)}.tar`

  // ── 1. The notices ──────────────────────────────────────────────────────────────────────────
  await step('the notices name the release asset and the build-script revision, and promise nothing else', () => {
    assert.equal(asset, 'TalkWeaver-<version>-ffmpeg-9.0.2-corresponding-source.tar')
    const licence = read('resources', 'ffmpeg-mac', 'COPYING.GPLv3')
    const notice = read('resources', 'ffmpeg-mac', 'FFMPEG-NOTICE.md')
    assert.equal(macFfmpegNoticeProblem({ licence, notice, pin }), null)
    assert.ok(notice.includes(asset), 'FFMPEG-NOTICE.md names the asset')
    assert.ok(notice.includes(`${ffmpegSourceAssetBase('<version>', pin.version)}.SHA256SUMS`), 'and its checksum file')
    assert.match(notice, /attached to the same GitHub release\s+this copy of TalkWeaver was downloaded from/, 'the source is on the release the app came from')
    assert.ok(notice.includes('https://github.com/techczech/talkweaver-app/releases'), 'and public builds come from the public releases page')
    assert.doesNotMatch(notice, /talk-weaver/, 'no other repository is named')
    assert.match(macFfmpegNoticeProblem({ licence, notice: notice.replace(/same GitHub release/g, 'GitHub release'), pin }), /same GitHub release/, 'a notice that names a place instead of the app\'s own release is refused')
    assert.ok(notice.includes(pin.source.buildScriptRevision) && notice.includes(manifest.ffmpeg.sha256), 'and the build-script revision and FFmpeg source hash')
    const third = read('THIRD-PARTY-NOTICES.md')
    assert.ok(third.includes(asset) && third.includes(pin.source.buildScriptRevision), 'THIRD-PARTY-NOTICES.md names the asset and revision')
    assert.match(third, /same GitHub release the app was downloaded from/, 'THIRD-PARTY-NOTICES.md: the release the app came from')
    for (const [name, text] of [['FFMPEG-NOTICE.md', notice], ['THIRD-PARTY-NOTICES.md', third]]) {
      assert.doesNotMatch(text, /send you the source|ask the TalkWeaver project|on request/i, `${name} no longer offers the source on request`)
    }

    // The package check refuses the old wording and a notice that drops the asset or the revision.
    const promise = `${notice}\nIf any of these places stops working, ask the TalkWeaver project (https://example.org/issues) and it will send you the source.\n`
    assert.match(macFfmpegNoticeProblem({ licence, notice: promise, pin }), /promises to send the source/)
    assert.match(macFfmpegNoticeProblem({ licence, notice: `${notice}\nWrite to us and we will post the source to you.`, pin }), /promises/)
    assert.match(macFfmpegNoticeProblem({ licence, notice: notice.replaceAll(asset, 'the source archive'), pin }), /release asset/)
    assert.match(macFfmpegNoticeProblem({ licence, notice: notice.replaceAll(pin.source.buildScriptRevision, 'develop'), pin }), /build-script revision/)
    assert.match(macFfmpegNoticeProblem({ licence, notice, pin: { ...pin, source: { ...pin.source, buildScriptRevision: undefined } } }), /build-script revision/)
  })

  // ── 2. The committed manifest ───────────────────────────────────────────────────────────────
  await step('the source manifest pins every file by an https address and a SHA-256', () => {
    assert.equal(sourceManifestProblem(manifest, pin.source), null)
    assert.equal(manifest.ffmpegVersion, pin.version)
    assert.equal(manifest.build, pin.url)
    assert.equal(manifest.ffmpeg.sha256, pin.source.ffmpegSha256)
    assert.equal(manifest.buildScript.commit, pin.source.buildScriptRevision)
    assert.match(manifest.buildScript.commit, /^[0-9a-f]{40}$/)
    const entries = sourceEntries(manifest)
    assert.equal(entries.length, 2 + manifest.libraries.length + manifest.rustCrates.crates.length)
    for (const entry of entries) {
      assert.match(entry.url, /^https:\/\//, `${entry.path} over https`)
      assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${entry.path} pinned by SHA-256`)
      assert.doesNotMatch(entry.url, /\/(master|main|latest)(\/|\.|$)/, `${entry.path} not a moving address`)
    }
    assert.ok(manifest.rustCrates.crates.length > 100, 'the rav1e crates are listed')
  })

  await step('a source for every library this build configures', () => {
    // The configure line of build 1789931890_9.0.2 (its versions.txt / ffmpeg -buildconf).
    const configured = '--enable-libxml2 --enable-openssl --enable-libfreetype --enable-fontconfig --enable-libharfbuzz --enable-libbluray --enable-libsnappy --enable-libsrt --enable-libvmaf --enable-libass --enable-libklvanc --enable-libzimg --enable-libzvbi --enable-libaom --enable-libdav1d --enable-libopenh264 --enable-libopenjpeg --enable-librav1e --enable-libsvtav1 --enable-libvpx --enable-libvvenc --enable-libwebp --enable-libx264 --enable-libx265 --enable-libmp3lame --enable-libopus --enable-libvorbis --enable-libtheora'
    const library = { libfreetype: 'freetype', libharfbuzz: 'harfbuzz', libsnappy: 'snappy', libsrt: 'srt', libzimg: 'zimg', libzvbi: 'zvbi', libaom: 'aom', libdav1d: 'dav1d', libopenjpeg: 'openjpeg', librav1e: 'rav1e', libsvtav1: 'svt-av1', libvpx: 'vpx', libx264: 'x264', libx265: 'x265', libmp3lame: 'lame', libopus: 'opus', libopenh264: 'openh264' }
    const names = new Set(manifest.libraries.map((lib) => lib.name))
    for (const flag of configured.split(' ')) {
      const name = flag.replace('--enable-', '')
      assert.ok(names.has(library[name] ?? name) || names.has(name.replace(/^lib/, '')), `${flag}: its source is in the manifest`)
    }
    for (const dependency of ['zlib', 'fribidi', 'libogg']) assert.ok(names.has(dependency), `${dependency} (linked through another library) is in the manifest`)
  })

  await step('the manifest check refuses what is not pinned', () => {
    const lib0 = manifest.libraries[0]
    const withLib = (change) => ({ ...manifest, libraries: [{ ...lib0, ...change }, ...manifest.libraries.slice(1)] })
    const refused = {
      'plain http': withLib({ url: lib0.url.replace('https:', 'http:') }),
      'no hash': withLib({ sha256: undefined }),
      'a short hash': withLib({ sha256: 'abc123' }),
      'a master branch archive': withLib({ url: 'https://code.videolan.org/videolan/x264/-/archive/master/x264-master.tar.gz' }),
      'a latest address': withLib({ url: 'https://example.org/releases/latest/download/x.tar.gz' }),
      'a path in the file name': withLib({ file: '../escape.tar.gz' }),
      'a file named twice': { ...manifest, libraries: [lib0, lib0, ...manifest.libraries.slice(1)] },
      'a build-script address without the commit': { ...manifest, buildScript: { ...manifest.buildScript, url: 'https://git.martin-riedl.de/ffmpeg/build-script/archive/develop.tar.gz' } },
      'a crate without a hash': { ...manifest, rustCrates: { ...manifest.rustCrates, crates: [{ ...manifest.rustCrates.crates[0], sha256: '' }] } },
    }
    for (const [what, bad] of Object.entries(refused)) assert.ok(sourceManifestProblem(bad, pin.source), `refused: ${what}`)
    assert.match(sourceManifestProblem(manifest, { ...pin.source, buildScriptRevision: '0'.repeat(40) }), /different build-script revisions/)
    assert.match(sourceManifestProblem({ ...manifest, ffmpeg: { ...manifest.ffmpeg, sha256: 'f'.repeat(64) } }, pin.source), /different FFmpeg source hashes/)
  })

  // ── 3. The bundle, from fixture bytes ───────────────────────────────────────────────────────
  // A fixture "rav1e" archive with a Cargo.lock naming one registry crate, made with the system tar.
  // Real archives, so the rebuild adapter can be run on the fixture bundle.
  const tarOf = (root, folder, out, flag = '-czf') => {
    const made = spawnSync('tar', [flag, out, '-C', root, folder])
    assert.equal(made.status, 0, `fixture archive ${out}: ${made.stderr}`)
    return readFileSync(out)
  }
  const tree = (root, files) => { for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) } }
  tree(join(scratch, 'crate'), { 'cratey-1.2.3/Cargo.toml': '[package]\nname = "cratey"\nversion = "1.2.3"\n' })
  const crateBytes = tarOf(join(scratch, 'crate'), 'cratey-1.2.3', join(scratch, 'cratey.crate'))
  tree(join(scratch, 'libfoo'), { 'libfoo-2.0/foo.c': 'int foo(void) { return 2; }\n' })
  const libfooBytes = tarOf(join(scratch, 'libfoo'), 'libfoo-2.0', join(scratch, 'libfoo-2.0.tar.gz'))
  tree(join(scratch, 'ff'), { 'ffmpeg-1.0/VERSION': '1.0\n' })
  const ffmpegBytes = tarOf(join(scratch, 'ff'), 'ffmpeg-1.0', join(scratch, 'ffmpeg-1.0.tar.xz'), '-cJf')
  // A build script in the shape of the pinned one: script/functions.sh defines download(); build.sh
  // asks for libfoo from a moving address (as x264's master) and FFmpeg as .tar.bz2.
  tree(join(scratch, 'bs'), {
    'build-script/script/functions.sh': '#!/bin/sh\ndownload(){\n    curl -o "$2" -L -f "$1"\n}\n',
    'build-script/build.sh': [
      '#!/bin/sh', 'set -e', 'BASE_DIR="$( cd "$( dirname "$0" )" && pwd )"', '. "$BASE_DIR/script/functions.sh"',
      'mkdir -p out source && cd source',
      'download https://example.org/libfoo-master.tar.gz libfoo-master.tar.gz', 'tar -zxf libfoo-master.tar.gz',
      'cp libfoo-master/foo.c ../out/foo.c',
      'download https://example.org/ffmpeg-1.0.tar.bz2 ffmpeg.tar.bz2', 'bunzip2 ffmpeg.tar.bz2', 'mkdir ffmpeg', 'tar -xf ffmpeg.tar -C ffmpeg --strip-components=1',
      'cp ffmpeg/VERSION ../out/VERSION', 'echo "options: $*" > ../out/options.txt', '',
    ].join('\n'),
  })
  spawnSync('chmod', ['755', join(scratch, 'bs', 'build-script', 'build.sh')])
  const buildScriptBytes = tarOf(join(scratch, 'bs'), 'build-script', join(scratch, 'build-script.tar.gz'))
  const lockText = `version = 4\n\n[[package]]\nname = "rav1e"\nversion = "0.0.1"\n\n[[package]]\nname = "cratey"\nversion = "1.2.3"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${sha256(crateBytes)}"\n`
  const rustDir = join(scratch, 'rust', 'rav1e-0.0.1')
  mkdirSync(rustDir, { recursive: true })
  writeFileSync(join(rustDir, 'Cargo.lock'), lockText)
  const made = spawnSync('tar', ['-czf', join(scratch, 'rav1e.tar.gz'), '-C', join(scratch, 'rust'), 'rav1e-0.0.1'])
  assert.equal(made.status, 0, 'fixture archive made')
  const rustArchive = readFileSync(join(scratch, 'rav1e.tar.gz'))
  assert.deepEqual([...cargoLockCrates(lockText)], [['cratey@1.2.3', sha256(crateBytes)]], 'Cargo.lock: registry crates only')

  const bytesAt = new Map([
    ['https://example.org/ffmpeg-1.0.tar.xz', ffmpegBytes],
    ['https://example.org/build-script/archive/' + 'a'.repeat(40) + '.tar.gz', buildScriptBytes],
    ['https://example.org/libfoo-2.0.tar.gz', libfooBytes],
    ['https://example.org/rav1e-0.0.1.tar.gz', rustArchive],
    ['https://example.org/crates/cratey-1.2.3.crate', crateBytes],
  ])
  const urls = [...bytesAt.keys()]
  const fixtureManifest = {
    ffmpegVersion: '1.0',
    build: 'https://example.org/build/ffmpeg.zip',
    ffmpeg: { file: 'ffmpeg-1.0.tar.xz', url: urls[0], scriptUrl: 'https://example.org/ffmpeg-1.0.tar.bz2', sha256: sha256(bytesAt.get(urls[0])) },
    buildScript: { repository: 'https://example.org/build-script', commit: 'a'.repeat(40), file: `build-script-${'a'.repeat(40)}.tar.gz`, url: urls[1], sha256: sha256(bytesAt.get(urls[1])) },
    libraries: [
      { name: 'libfoo', version: '2.0', file: 'libfoo-2.0.tar.gz', url: urls[2], scriptUrl: 'https://example.org/libfoo-master.tar.gz', sha256: sha256(bytesAt.get(urls[2])) },
      { name: 'rav1e', version: '0.0.1', file: 'rav1e-0.0.1.tar.gz', url: urls[3], sha256: sha256(rustArchive), lockFile: 'rav1e-0.0.1/Cargo.lock' },
    ],
    rustCrates: { for: 'rav1e', lockFile: 'rav1e-0.0.1/Cargo.lock', crates: [{ name: 'cratey', version: '1.2.3', url: urls[4], sha256: sha256(crateBytes) }] },
    notIncluded: [{ name: 'a build tool', why: 'not in the binary' }],
  }
  let downloads = 0
  const download = async (url) => {
    downloads++
    if (!bytesAt.has(url)) throw new Error(`fixture has no ${url}`)
    return bytesAt.get(url)
  }
  const run = (name, extra = {}) => assembleSourceBundle({ manifest: fixtureManifest, appVersion: '0.0.1-test.1', outDir: join(scratch, name, 'out'), cacheDir: join(scratch, name, 'cache'), download, attempts: 2, retryDelayMs: 0, ...extra })

  await step('the bundle and its SHA256SUMS, with every pinned file inside', async () => {
    assert.equal(sourceManifestProblem(fixtureManifest), null)
    const bundle = await run('good')
    const base = 'TalkWeaver-0.0.1-test.1-ffmpeg-1.0-corresponding-source'
    assert.equal(bundle.tar, join(scratch, 'good', 'out', `${base}.tar`))
    assert.equal(bundle.sums, join(scratch, 'good', 'out', `${base}.SHA256SUMS`))
    assert.equal(readFileSync(bundle.sums, 'utf8'), `${sha256(readFileSync(bundle.tar))}  ${base}.tar\n`)
    assert.deepEqual(readdirSync(join(scratch, 'good', 'out')).sort(), [`${base}.SHA256SUMS`, `${base}.tar`], 'only the two assets, no partial file')
    const listed = spawnSync('tar', ['-tf', bundle.tar], { encoding: 'utf8' })
    assert.equal(listed.status, 0, listed.stderr)
    const files = listed.stdout.trim().split('\n').filter((name) => !name.endsWith('/'))
    assert.deepEqual(files, [
      `${base}/README.txt`, `${base}/source-manifest.json`, `${base}/SHA256SUMS`,
      `${base}/REBUILD.txt`, `${base}/rebuild/build-from-bundle.sh`, `${base}/rebuild/fetch-from-bundle.sh`, `${base}/rebuild/url-map.tsv`,
      `${base}/ffmpeg/ffmpeg-1.0.tar.xz`, `${base}/build-script/build-script-${'a'.repeat(40)}.tar.gz`,
      `${base}/libraries/libfoo-2.0.tar.gz`, `${base}/libraries/rav1e-0.0.1.tar.gz`, `${base}/libraries/rav1e-crates/cratey-1.2.3.crate`,
    ])
    // Unpacked, every file matches the SHA256SUMS inside, and the README names the revision.
    const into = join(scratch, 'good', 'x')
    mkdirSync(into)
    assert.equal(spawnSync('tar', ['-xf', bundle.tar, '-C', into]).status, 0)
    const sums = readFileSync(join(into, base, 'SHA256SUMS'), 'utf8').trim().split('\n')
    assert.equal(sums.length, 11)
    for (const line of sums) {
      const [hash, path] = line.split('  ')
      assert.equal(sha256(readFileSync(join(into, base, path))), hash, path)
    }
    assert.match(readFileSync(join(into, base, 'README.txt'), 'utf8'), new RegExp(`commit ${'a'.repeat(40)}`))
    assert.match(readFileSync(join(into, base, 'README.txt'), 'utf8'), /REBUILD\.txt and rebuild\/: how to build the program again from the files in this archive/)
    assert.match(readFileSync(join(into, base, 'REBUILD.txt'), 'utf8'), /rebuild\/build-from-bundle\.sh \.\.\/ffmpeg-build/, 'REBUILD.txt says how to build from the bundle')
    assert.doesNotMatch(readFileSync(join(into, base, 'README.txt'), 'utf8'), /Run build\.sh from them/, 'and no longer sends the reader to the downloading build script')
    if (process.platform !== 'win32') for (const script of ['build-from-bundle.sh', 'fetch-from-bundle.sh']) assert.equal(statSync(join(into, base, 'rebuild', script)).mode & 0o777, 0o755, `${script} is runnable`)
    assert.equal(readFileSync(join(into, base, 'rebuild', 'url-map.tsv'), 'utf8'), rebuildUrlMap(fixtureManifest))
    assert.deepEqual(readFileSync(join(into, base, 'libraries', 'libfoo-2.0.tar.gz')), bytesAt.get(urls[2]))

    // A second run takes everything from the cache and makes the same bytes.
    const before = downloads
    const again = await run('good', { download: async () => { throw new Error('no network in this run') } })
    assert.equal(downloads, before)
    assert.equal(again.sha256, bundle.sha256, 'the same inputs make the same bundle')
  })

  await step('a download whose SHA-256 is not the pinned one is refused, and nothing is written', async () => {
    const wrong = async (url) => (url === urls[2] ? Buffer.from('libfoo source, changed') : bytesAt.get(url))
    await assert.rejects(run('mismatch', { download: wrong }), /refused: libraries\/libfoo-2\.0\.tar\.gz .*SHA-256 [0-9a-f]{64}, not the pinned [0-9a-f]{64}; no bundle was written/)
    assert.equal(existsSync(join(scratch, 'mismatch', 'out')), false, 'no output folder')
    assert.ok(!readdirSync(join(scratch, 'mismatch', 'cache')).some((name) => name.includes('libfoo')), 'the wrong bytes are not cached')

    // A cached file that no longer has the pinned hash is fetched again, not used.
    const poisoned = join(scratch, 'poisoned', 'cache')
    mkdirSync(poisoned, { recursive: true })
    writeFileSync(join(poisoned, 'libraries__libfoo-2.0.tar.gz'), 'tampered')
    const bundle = await run('poisoned')
    assert.ok(existsSync(bundle.tar))
    assert.deepEqual(readFileSync(join(poisoned, 'libraries__libfoo-2.0.tar.gz')), bytesAt.get(urls[2]))

    // A download that only fails is refused after the attempts.
    await assert.rejects(run('offline', { download: async () => { throw new Error('offline') } }), /refused: ffmpeg\/ffmpeg-1\.0\.tar\.xz .*offline/)
  })

  await step('a crate list that differs from Cargo.lock is refused', async () => {
    const extra = { ...fixtureManifest, rustCrates: { ...fixtureManifest.rustCrates, crates: [...fixtureManifest.rustCrates.crates, { name: 'other', version: '1.0.0', url: 'https://example.org/crates/other-1.0.0.crate', sha256: sha256(Buffer.from('other')) }] } }
    bytesAt.set('https://example.org/crates/other-1.0.0.crate', Buffer.from('other'))
    await assert.rejects(run('extra-crate', { manifest: extra }), /lists the crate other@1\.0\.0, which rav1e-0\.0\.1\/Cargo\.lock does not name/)
    assert.equal(existsSync(join(scratch, 'extra-crate', 'out')), false)
    const missing = { ...fixtureManifest, rustCrates: { ...fixtureManifest.rustCrates, crates: [] } }
    await assert.rejects(run('missing-crate', { manifest: missing }), /names the crate cratey@1\.2\.3, which the ffmpeg source manifest does not list/)
  })

  await step('a bad manifest or version is refused before anything is downloaded', async () => {
    const before = downloads
    const unpinned = { ...fixtureManifest, libraries: [{ ...fixtureManifest.libraries[0], sha256: undefined }, fixtureManifest.libraries[1]] }
    await assert.rejects(run('unpinned', { manifest: unpinned }), /refused: libraries\/libfoo-2\.0\.tar\.gz is not pinned by a SHA-256/)
    await assert.rejects(run('badversion', { appVersion: 'latest' }), /not a TalkWeaver version/)
    assert.equal(downloads, before)
  })

  // ── 4. Rebuilding from the bundle ───────────────────────────────────────────────────────────
  await step('the rebuild map: each address the build scripts ask for, and how the bundle answers it', () => {
    assert.equal(rebuildUrlMap(fixtureManifest), [
      `${urls[0]}\tffmpeg/ffmpeg-1.0.tar.xz\tcopy`,
      'https://example.org/ffmpeg-1.0.tar.bz2\tffmpeg/ffmpeg-1.0.tar.xz\ttar.bz2',
      `${urls[2]}\tlibraries/libfoo-2.0.tar.gz\tcopy`,
      'https://example.org/libfoo-master.tar.gz\tlibraries/libfoo-2.0.tar.gz\ttop=libfoo-master',
      `${urls[3]}\tlibraries/rav1e-0.0.1.tar.gz\tcopy`,
    ].join('\n') + '\n')
    assert.throws(() => rebuildUrlMap({ ...fixtureManifest, libraries: [{ ...fixtureManifest.libraries[0], scriptUrl: 'https://example.org/other-9.zip' }] }), /no way to hand libfoo-2\.0\.tar\.gz over as other-9\.zip/)
    const real = rebuildUrlMap(manifest)
    assert.match(real, /\/x264\/-\/archive\/master\/x264-master\.tar\.gz\tlibraries\/x264-[0-9a-f]{40}\.tar\.gz\ttop=x264-master\n/, 'x264: the moving master address is answered with the pinned commit, under the folder name the script expects')
    assert.match(real, /ffmpeg-9\.0\.2\.tar\.bz2\tffmpeg\/ffmpeg-9\.0\.2\.tar\.xz\ttar\.bz2\n/, 'FFmpeg: the .tar.bz2 the script asks for, from the .tar.xz in the bundle')
  })

  // The pinned build scripts themselves, when their archive is in the cache: the first (used) download
  // of every library script is answered by the map. Build tools are not part of the program.
  const cachedScripts = join(repo, 'ffmpeg-mac-source', 'cache', `build-script__${manifest.buildScript.file}`)
  if (existsSync(cachedScripts) && sha256(readFileSync(cachedScripts)) === manifest.buildScript.sha256) {
    await step('every library address the pinned build scripts ask for is answered from the bundle', () => {
      const files = readTarGz(readFileSync(cachedScripts))
      const mapped = new Set(rebuildUrlMap(manifest).trim().split('\n').map((line) => line.split('\t')[0]))
      const tools = new Set(['cmake', 'nasm', 'ninja', 'pkg-config', 'sdl', 'libiconv', 'decklink'])
      let checked = 0
      for (const [path, body] of files) {
        const script = /\/script\/build-([\w-]+)\.sh$/.exec(path)?.[1]
        if (!script || tools.has(script)) continue
        const versionPath = [...files.keys()].find((key) => key.endsWith(`/version/${script}`))
        const version = versionPath ? files.get(versionPath).toString('utf8').trim() : ''
        const first = body.toString('utf8').split('\n').find((line) => /^\s*download /.test(line))
        assert.ok(first, `build-${script}.sh downloads its source`)
        const url = first.trim().split(/\s+/)[1]
          .replaceAll('$VERSION_WITHOUT_PATCH', version.split('.').slice(0, 2).join('.')).replaceAll('${VERSION}', version).replaceAll('$VERSION', version)
        assert.ok(mapped.has(url), `build-${script}.sh asks for ${url}, which rebuild/url-map.tsv does not answer`)
        checked++
      }
      assert.ok(checked >= 30, `${checked} library scripts checked`)
    })
  } else console.log('  (the pinned build-script archive is not cached: its addresses were not checked against the map)')

  if (process.platform === 'darwin') {
    await step('rebuild/build-from-bundle.sh builds from the bundle alone (fixture build script, offline)', async () => {
      const base = 'TalkWeaver-0.0.1-test.1-ffmpeg-1.0-corresponding-source'
      const bundle = await run('rebuild')
      const into = join(scratch, 'rebuild', 'x')
      mkdirSync(into)
      assert.equal(spawnSync('tar', ['-xf', bundle.tar, '-C', into]).status, 0)
      const root = join(into, base)
      const work = join(scratch, 'rebuild', 'work')
      const env = { ...process.env, TW_REBUILD_OFFLINE: '1', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
      const built = spawnSync(join(root, 'rebuild', 'build-from-bundle.sh'), [work, '-SKIP_TEST=YES'], { cwd: root, env, encoding: 'utf8' })
      assert.equal(built.status, 0, built.stdout + built.stderr)
      assert.equal(readFileSync(join(work, 'out', 'foo.c'), 'utf8'), 'int foo(void) { return 2; }\n', 'libfoo came from the bundle, under the folder name the script expects')
      assert.equal(readFileSync(join(work, 'out', 'VERSION'), 'utf8'), '1.0\n', 'FFmpeg came from the bundle, as the .tar.bz2 the script unpacks')
      assert.equal(readFileSync(join(work, 'out', 'options.txt'), 'utf8'), 'options: -SKIP_TEST=YES\n', 'build.sh got the options')
      assert.match(built.stderr, /from this archive \(top=libfoo-master\): https:\/\/example\.org\/libfoo-master\.tar\.gz <- libraries\/libfoo-2\.0\.tar\.gz/)
      assert.match(built.stderr, /from this archive \(tar\.bz2\): https:\/\/example\.org\/ffmpeg-1\.0\.tar\.bz2 <- ffmpeg\/ffmpeg-1\.0\.tar\.xz/)
      const cargo = readFileSync(join(work, '.cargo', 'config.toml'), 'utf8')
      assert.match(cargo, /\[source\.crates-io\]\nreplace-with = "corresponding-source"/)
      assert.ok(cargo.includes(`directory = "${join(scratch, 'rebuild', 'work', 'cargo-vendor')}"`), cargo)
      assert.match(cargo, /\[net\]\noffline = true/)
      assert.deepEqual(JSON.parse(readFileSync(join(work, 'cargo-vendor', 'cratey-1.2.3', '.cargo-checksum.json'), 'utf8')), { files: {}, package: sha256(crateBytes) }, 'each crate unpacked with the Cargo.lock checksum')
      assert.ok(existsSync(join(work, 'cargo-vendor', 'cratey-1.2.3', 'Cargo.toml')))
      const refused = spawnSync(join(root, 'rebuild', 'fetch-from-bundle.sh'), ['https://example.org/nasm-3.02.tar.gz', join(scratch, 'rebuild', 'nasm.tar.gz')], { env, encoding: 'utf8' })
      assert.equal(refused.status, 1, 'offline, an address not in the bundle is refused')
      assert.match(refused.stderr, /refused \(TW_REBUILD_OFFLINE=1\): https:\/\/example\.org\/nasm-3\.02\.tar\.gz is not in this archive/)
      const again = spawnSync(join(root, 'rebuild', 'build-from-bundle.sh'), [work], { cwd: root, env, encoding: 'utf8' })
      assert.notEqual(again.status, 0, 'an existing work folder is refused')
      writeFileSync(join(root, 'libraries', 'libfoo-2.0.tar.gz'), 'tampered')
      const tampered = spawnSync(join(root, 'rebuild', 'build-from-bundle.sh'), [join(scratch, 'rebuild', 'work2')], { cwd: root, env, encoding: 'utf8' })
      assert.notEqual(tampered.status, 0, 'a file that does not match SHA256SUMS stops the build')
      assert.equal(existsSync(join(scratch, 'rebuild', 'work2', 'build-script')), false, 'before anything is unpacked')
    })
  }

  // ── 5. The release wiring ───────────────────────────────────────────────────────────────────
  await step('release.yml packages without publishing and hands the exact Mac files to scripts/release-mac-assets.mjs', () => {
    const workflow = read('.github', 'workflows', 'release.yml')
    const mac = workflow.slice(workflow.indexOf('  macos:'), workflow.indexOf('  windows:'))
    const windows = workflow.slice(workflow.indexOf('  windows:'))
    const at = (text) => { const index = mac.indexOf(text); assert.ok(index > 0, `the macOS job has: ${text}`); return index }
    const assemble = at('run: node scripts/build-ffmpeg-source-bundle.mjs')
    const pack = at('run: npx electron-builder --mac --publish never\n')
    const release = at('node scripts/release-mac-assets.mjs --repo "$REPO" --tag "v$VERSION" "${DMG[0]}" "${ZIP[0]}" "ffmpeg-mac-source/$BASE.tar" "ffmpeg-mac-source/$BASE.SHA256SUMS"')
    assert.ok(assemble < pack && pack < release, 'make the source, package, then release the Mac files')
    assert.match(mac, /\[ \$\{#DMG\[@\]\} -eq 1 \] && \[ \$\{#ZIP\[@\]\} -eq 1 \]/, 'exactly one dmg and one zip')
    assert.match(mac, /REPO=\$\(node -p "const p=require\('\.\/package\.json'\)\.build\.publish; p\.owner \+ '\/' \+ p\.repo"\)/, 'to the repository electron-builder publishes to')
    assert.match(mac, /BASE="TalkWeaver-\$VERSION-ffmpeg-\$FFMPEG-corresponding-source"/, 'the source under its fixed asset name')
    assert.equal((mac.replace(/^\s*#.*$/gm, '').match(/electron-builder/g) ?? []).length, 1, 'the macOS job runs electron-builder once, to package')
    assert.doesNotMatch(workflow.replace(/^\s*#.*$/gm, ''), /gh release upload|--clobber|electron-builder publish|electron-builder --mac --publish (always|onTag)/, 'nothing else uploads Mac files')
    assert.match(windows, /npx electron-builder --win --publish always/, 'Windows is published as before')
    assert.doesNotMatch(windows, /ffmpeg-source|release-mac-assets/, 'the Windows job does not handle the Mac files')
    const packaged = read('.github', 'workflows', 'packaged.yml')
    const unsigned = packaged.indexOf('npx electron-builder --mac --dir --publish never')
    const gate = packaged.indexOf('node scripts/verify-mac-package.mjs release/mac-arm64/TalkWeaver.app')
    assert.ok(unsigned > 0 && gate > unsigned && gate < packaged.indexOf('npm run smoke:packaged-wrangler', unsigned), 'packaged.yml runs the gate on the unsigned build before the smoke')
    // docs/ is not in the public snapshot (scripts/public-snapshot.exclude).
    if (existsSync(join(repo, 'docs', 'RELEASING.md'))) {
      const flat = read('docs', 'RELEASING.md').replace(/\s+/g, ' ')
      assert.ok(flat.includes('TalkWeaver-<version>-ffmpeg-<ffmpeg version>-corresponding-source.tar') && flat.includes('npm run build:ffmpeg-source'), 'RELEASING.md names the asset and the step')
      assert.match(flat, /`scripts\/verify-mac-package\.mjs` decides whether a Mac package may be released/, 'and the release gate')
      assert.match(flat, /It is the release gate; there is no further guard inside electron-builder\./, 'and that nothing in the builder is the gate')
      assert.match(flat, /The public repo's own `release\.yml` must call this script for the Mac files and nothing else in it may publish Mac files/, 'and what the public workflow must do')
    }
    assert.match(read('.gitignore'), /^\/ffmpeg-mac-source\/$/m, 'downloads stay out of git')
    assert.equal(JSON.parse(read('package.json')).scripts['build:ffmpeg-source'], 'node scripts/build-ffmpeg-source-bundle.mjs')
  })

  // ── 6. scripts/release-mac-assets.mjs, with a fake gh ───────────────────────────────────────
  await step('the release script uploads the verified copies, refuses a published release or a name already there, and undoes a bad upload', async () => {
    const dir = join(scratch, 'release-files')
    mkdirSync(dir)
    const file = (name, text) => { const path = join(dir, name); writeFileSync(path, text); return path }
    const dmg = file('TalkWeaver-1.2.3-arm64.dmg', 'dmg bytes')
    const zip = file('TalkWeaver-1.2.3-arm64-mac.zip', 'zip bytes')
    const tar = file('TalkWeaver-1.2.3-ffmpeg-9.0.2-corresponding-source.tar', 'tar bytes')
    const sums = file('TalkWeaver-1.2.3-ffmpeg-9.0.2-corresponding-source.SHA256SUMS', `${sha256(Buffer.from('tar bytes'))}  TalkWeaver-1.2.3-ffmpeg-9.0.2-corresponding-source.tar\n`)
    const files = [dmg, zip, tar, sums]
    const names = files.map((path) => path.slice(dir.length + 1))
    /** A GitHub that keeps one release in memory; `corrupt` names an asset whose download comes back changed;
     *  `storedThenFails` names an asset whose upload is stored but reported as failed (a reset connection);
     *  `foreign` { name, bytes, conflict }: just before this run's upload of `name`, another publisher stores
     *  `bytes` under that name; with `conflict` this run's upload is then refused as already there, without
     *  it this run's upload is lost (reported as a reset connection, nothing stored). */
    const fakeGitHub = ({ release = null, corrupt = null, storedThenFails = null, foreign = null } = {}) => {
      const calls = []
      const state = { release }
      let nextId = 100
      if (release) for (const asset of release.assets.values()) asset.id ??= `RA_${nextId++}`
      const gh = (args) => {
        calls.push(args)
        const [, verb, tag] = args
        assert.equal(args[0], 'release')
        assert.ok(!args.includes('--clobber'), 'never --clobber')
        assert.equal(args[args.indexOf('--repo') + 1], 'owner/repo')
        assert.equal(tag, 'v1.2.3')
        if (verb === 'view') return state.release ? { status: 0, stdout: JSON.stringify({ isDraft: state.release.isDraft, assets: [...state.release.assets].map(([name, asset]) => ({ id: asset.id, name, size: asset.bytes.length })) }) } : { status: 1, stderr: 'release not found' }
        if (verb === 'create') { assert.ok(args.includes('--draft')); state.release = { isDraft: true, assets: new Map() }; return { status: 0 } }
        if (verb === 'upload') {
          const path = args[3]
          const name = path.split('/').pop()
          if (foreign && foreign.name === name) {
            state.release.assets.set(name, { bytes: Buffer.from(foreign.bytes), id: `RA_${nextId++}` })
            if (!foreign.conflict) return { status: 1, stderr: 'connection reset by peer' }
          }
          if (state.release.assets.has(name)) return { status: 1, stderr: 'asset under the same name already exists' }
          state.release.assets.set(name, { bytes: readFileSync(path), path, id: `RA_${nextId++}` })
          if (name === storedThenFails) return { status: 1, stderr: 'connection reset by peer' }
          return { status: 0 }
        }
        if (verb === 'download') {
          const name = args[args.indexOf('--pattern') + 1]
          const asset = state.release.assets.get(name)
          if (!asset) return { status: 1, stderr: 'no assets match' }
          writeFileSync(join(args[args.indexOf('--dir') + 1], name), name === corrupt ? Buffer.concat([asset.bytes, Buffer.from('!')]) : asset.bytes)
          return { status: 0 }
        }
        if (verb === 'delete-asset') { state.release.assets.delete(args[3]); return { status: 0 } }
        return { status: 1, stderr: `unexpected gh ${args.join(' ')}` }
      }
      return { gh, calls, state }
    }
    const quiet = () => {}
    const passGate = () => ({ problems: [] })

    // A good run: every file verified (the dmg and zip by the gate), each a copy, and the copies uploaded.
    {
      const github = fakeGitHub()
      const verified = []
      const verify = (path) => {
        verified.push({ path, bytes: readFileSync(path) })
        // The original is replaced after it was copied: the copy is what is verified and uploaded.
        if (path.endsWith('.dmg')) writeFileSync(dmg, 'swapped dmg bytes')
        return { problems: [] }
      }
      const result = await releaseMacAssets({ repo: 'owner/repo', tag: 'v1.2.3', files, gh: github.gh, verify, log: quiet })
      assert.deepEqual(verified.map((item) => item.path.split('/').pop()), [names[0], names[1]], 'the gate runs on the dmg and the zip')
      for (const item of verified) assert.ok(!item.path.startsWith(dir), 'on copies, not on the files handed in')
      assert.deepEqual([...github.state.release.assets.keys()], names, 'every file is on the draft')
      assert.equal(github.state.release.assets.get(names[0]).bytes.toString(), 'dmg bytes', 'the verified bytes were uploaded, not the file that replaced them')
      assert.equal(github.state.release.assets.get(names[0]).path, verified[0].path, 'the upload is the very copy that was verified')
      assert.deepEqual(result.uploaded.map((item) => item.sha256), [sha256(Buffer.from('dmg bytes')), sha256(Buffer.from('zip bytes')), sha256(Buffer.from('tar bytes')), sha256(readFileSync(sums))])
      assert.ok(github.calls.some((args) => args[1] === 'create'), 'a draft is made when there is none')
      assert.equal(github.calls.filter((args) => args[1] === 'download').length, 4, 'each upload is downloaded back')
      writeFileSync(dmg, 'dmg bytes')
    }
    // A package the gate refuses: nothing reaches GitHub.
    {
      const github = fakeGitHub()
      await assert.rejects(releaseMacAssets({ repo: 'owner/repo', tag: 'v1.2.3', files, gh: github.gh, verify: (path) => ({ problems: path.endsWith('.zip') ? ['no attestation'] : [] }), log: quiet }), /did not pass scripts\/verify-mac-package\.mjs --require-signed:\nno attestation/)
      assert.equal(github.calls.length, 0, 'gh is never called')
    }
    // A published release, or a draft already holding one of the names: refused, nothing uploaded.
    {
      const github = fakeGitHub({ release: { isDraft: false, assets: new Map() } })
      await assert.rejects(releaseMacAssets({ repo: 'owner/repo', tag: 'v1.2.3', files, gh: github.gh, verify: passGate, log: quiet }), /already published/)
      assert.ok(!github.calls.some((args) => ['upload', 'create'].includes(args[1])), 'nothing uploaded to a published release')
      const holding = fakeGitHub({ release: { isDraft: true, assets: new Map([[names[1], { bytes: Buffer.from('old zip') }]]) } })
      await assert.rejects(releaseMacAssets({ repo: 'owner/repo', tag: 'v1.2.3', files, gh: holding.gh, verify: passGate, log: quiet }), new RegExp(`already holds ${names[1].replace(/\./g, '\\.')}`))
      assert.ok(!holding.calls.some((args) => args[1] === 'upload'), 'nothing uploaded beside an asset of the same name')
      assert.equal(holding.state.release.assets.get(names[1]).bytes.toString(), 'old zip', 'and the old asset is left as it was')
      const reused = fakeGitHub({ release: { isDraft: true, assets: new Map([['TalkWeaver-1.2.3-setup.exe', { bytes: Buffer.from('exe') }]]) } })
      await releaseMacAssets({ repo: 'owner/repo', tag: 'v1.2.3', files, gh: reused.gh, verify: passGate, log: quiet })
      assert.ok(!reused.calls.some((args) => args[1] === 'create') && reused.state.release.assets.size === 5, 'a draft holding only other files (Windows) is used')
      const unknown = fakeGitHub()
      await assert.rejects(releaseMacAssets({ repo: 'owner/repo', tag: 'v1.2.3', files, gh: (args) => args[1] === 'view' ? { status: 1, stderr: 'HTTP 502' } : unknown.gh(args), verify: passGate, log: quiet }), /could not tell whether/, 'a failed lookup is not taken for "no release"')
    }
    // A download back that differs from the verified copy: what this run uploaded is deleted.
    {
      const github = fakeGitHub({ release: { isDraft: true, assets: new Map([['TalkWeaver-1.2.3-setup.exe', { bytes: Buffer.from('exe') }]]) }, corrupt: names[2] })
      await assert.rejects(releaseMacAssets({ repo: 'owner/repo', tag: 'v1.2.3', files, gh: github.gh, verify: passGate, log: quiet }), new RegExp(`${names[2].replace(/\./g, '\\.')} on the release has SHA-256 [0-9a-f]{64}; the verified file has ${sha256(Buffer.from('tar bytes'))}.*Deleted from the draft the assets this run uploaded \\(${names.join(', ').replace(/\./g, '\\.')}\\)\\.`, 's'))
      assert.deepEqual([...github.state.release.assets.keys()], ['TalkWeaver-1.2.3-setup.exe'], 'every file it uploaded is deleted; the rest of the draft is left')
      assert.deepEqual(github.calls.filter((args) => args[1] === 'delete-asset').map((args) => args[3]), names)
    }
    // An upload reported as failed after GitHub stored it (ambiguous failure): the draft is listed and the
    // stored asset deleted; other files on the draft are left.
    {
      const github = fakeGitHub({ release: { isDraft: true, assets: new Map([['TalkWeaver-1.2.3-setup.exe', { bytes: Buffer.from('exe') }]]) }, storedThenFails: names[0] })
      await assert.rejects(releaseMacAssets({ repo: 'owner/repo', tag: 'v1.2.3', files, gh: github.gh, verify: passGate, log: quiet }), new RegExp(`the upload of ${names[0].replace(/\./g, '\\.')} failed: connection reset by peer\\. Deleted from the draft the assets this run uploaded \\(${names[0].replace(/\./g, '\\.')}\\)\\.`))
      assert.deepEqual([...github.state.release.assets.keys()], ['TalkWeaver-1.2.3-setup.exe'], 'the asset stored by the "failed" upload is deleted')
      assert.deepEqual(github.calls.filter((args) => args[1] === 'delete-asset').map((args) => args[3]), [names[0]], 'and nothing else is touched')
      // The second upload stored then "failed": both of this run's assets are deleted.
      const second = fakeGitHub({ storedThenFails: names[1] })
      await assert.rejects(releaseMacAssets({ repo: 'owner/repo', tag: 'v1.2.3', files, gh: second.gh, verify: passGate, log: quiet }), /the upload of .* failed/)
      assert.deepEqual([...second.state.release.assets.keys()], [], 'every stored asset of this run is deleted')
      // The draft cannot be listed: whose assets are there cannot be told, so nothing is deleted and the
      // message says to check by hand.
      const blind = fakeGitHub({ storedThenFails: names[0] })
      let views = 0
      await assert.rejects(releaseMacAssets({ repo: 'owner/repo', tag: 'v1.2.3', files, gh: (args) => args[1] === 'view' && ++views > 1 ? { status: 1, stderr: 'HTTP 502' } : blind.gh(args), verify: passGate, log: quiet }), /Could not list the draft \(HTTP 502\), so nothing was deleted: check the draft by hand/)
      assert.equal(blind.calls.filter((args) => args[1] === 'delete-asset').length, 0, 'nothing is deleted blind')
    }
    // Another publisher uploads under one of this run's names after the check (the review's case): this
    // run's upload is refused as already there, nothing is deleted, and the message says why. The foreign
    // file has the very size of this run's, so only its being contested keeps it.
    {
      const github = fakeGitHub({ release: { isDraft: true, assets: new Map() }, foreign: { name: names[0], bytes: 'DMG BYTES', conflict: true } })
      await assert.rejects(releaseMacAssets({ repo: 'owner/repo', tag: 'v1.2.3', files, gh: github.gh, verify: passGate, log: quiet }), new RegExp(`the upload of ${names[0].replace(/\./g, '\\.')} was refused because an asset of that name is already on the draft.*another publisher may be uploading to v1\\.2\\.3\\. Nothing under that name was deleted.*Deleted from the draft the assets this run uploaded \\(none was there\\)\\.`, 's'))
      assert.equal(github.calls.filter((args) => args[1] === 'delete-asset').length, 0, 'the other publisher\'s asset is not deleted')
      assert.equal(github.state.release.assets.get(names[0]).bytes.toString(), 'DMG BYTES', 'and is on the draft as they uploaded it')
      // This run's own earlier upload is still deleted when a later name is contested.
      const later = fakeGitHub({ release: { isDraft: true, assets: new Map() }, foreign: { name: names[1], bytes: 'other zip bytes', conflict: true } })
      await assert.rejects(releaseMacAssets({ repo: 'owner/repo', tag: 'v1.2.3', files, gh: later.gh, verify: passGate, log: quiet }), new RegExp(`another publisher may be uploading.*Deleted from the draft the assets this run uploaded \\(${names[0].replace(/\./g, '\\.')}\\)\\.`, 's'))
      assert.deepEqual([...later.state.release.assets.keys()], [names[1]], 'this run\'s dmg deleted, the other publisher\'s zip left')
      // A foreign asset under this run's name, this run's upload lost in a reset: its size is not that of
      // this run's copy, so it is not taken for this run's and is left.
      const lost = fakeGitHub({ release: { isDraft: true, assets: new Map() }, foreign: { name: names[0], bytes: 'a different dmg', conflict: false } })
      await assert.rejects(releaseMacAssets({ repo: 'owner/repo', tag: 'v1.2.3', files, gh: lost.gh, verify: passGate, log: quiet }), /connection reset by peer\. Deleted from the draft the assets this run uploaded \(none was there\)\./)
      assert.equal(lost.calls.filter((args) => args[1] === 'delete-asset').length, 0, 'an asset of another size under this run\'s name is not deleted')
    }
    // What the files must be: a SHA256SUMS that agrees, plain files, distinct names, a package.
    {
      const run = (list) => releaseMacAssets({ repo: 'owner/repo', tag: 'v1.2.3', files: list, gh: fakeGitHub().gh, verify: passGate, log: quiet })
      const badSums = file('Other.SHA256SUMS', `${'0'.repeat(64)}  ${names[2]}\n`)
      await assert.rejects(run([dmg, zip, tar, badSums]), /gives TalkWeaver-1\.2\.3-ffmpeg-9\.0\.2-corresponding-source\.tar the SHA-256 0{64}/)
      assert.match(sumsProblem(`${'a'.repeat(64)}  elsewhere.tar\n`, new Map()), /not among the files/)
      symlinkSync(dmg, join(dir, 'linked.dmg'))
      await assert.rejects(run([join(dir, 'linked.dmg'), zip]), /not a plain file/)
      await assert.rejects(run([tar, sums]), /no \.dmg or \.zip/)
      await assert.rejects(run([dmg, dmg]), /two files are named/)
      await assert.rejects(run([dmg, join(dir, 'missing.zip')]), /does not exist/)
      await assert.rejects(releaseMacAssets({ repo: 'owner/repo', tag: 'latest', files, gh: fakeGitHub().gh, verify: passGate, log: quiet }), /--tag must be/)
      await assert.rejects(releaseMacAssets({ repo: 'owner', tag: 'v1.2.3', files, gh: fakeGitHub().gh, verify: passGate, log: quiet }), /--repo must be/)
    }
    const source = read('scripts', 'release-mac-assets.mjs').replace(/^\s*(\/\/|\/\*\*?|\*).*$/gm, '')
    assert.match(source, /verifyMacPackage\(path, \{ requireSigned: true \}\)/, 'the real gate is run with --require-signed')
    assert.doesNotMatch(source, /--clobber|readdirSync|globSync|\bglob\(/, 'no --clobber and no globbing in the script')
  })

  console.log(`ffmpeg-source-bundle: ${passed} checks passed`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
