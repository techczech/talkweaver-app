// electron-builder `beforePack` (ticket 11): no package is made without a live-service bundle that
// matches its manifest and the Worker's sources. The check itself is scripts/check-worker-dist.mjs;
// it is run as its own Node process because it is an ES module that loads TypeScript sources.
// Ticket 08: no package is made without the ffmpeg that ships with the app
// (scripts/lib/ffmpeg-ship-check.cjs). Windows: ffmpeg-static's binary, and no installer with one
// marked unredistributable. macOS: the pinned plain-GPL build only, fetched here by
// scripts/fetch-ffmpeg-mac.mjs (a no-op when the pinned file is already in ffmpeg-mac/), checked by
// its SHA-256 for every target, with its GPL text and notice beside it.
// The copy electron-builder then puts inside the app is checked again before signing, and no package
// is made from an app this process did not lay out (--prepackaged): scripts/electron-builder-staged-check.cjs.
'use strict'
const { spawnSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { ffmpegShipProblem, macFfmpegNoticeProblem, macFfmpegPinProblem, shippedFfmpegPath } = require('./lib/ffmpeg-ship-check.cjs')

const readOrNull = (path) => { try { return readFileSync(path) } catch { return null } }

exports.default = async function beforePack(context) {
  const repo = join(__dirname, '..')
  const node = (script) => spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', join(repo, 'scripts', script)], { cwd: repo, stdio: 'inherit', windowsHide: true })
  if (node('check-worker-dist.mjs').status !== 0) throw new Error('worker-dist is not ready to ship: run npm run build (or npm run build:worker-dist) first')
  const platform = (context && context.electronPlatformName) || process.platform
  const targets = ((context && context.targets) || []).map((target) => String(target && target.name))

  let pin = null
  if (platform === 'darwin') {
    pin = JSON.parse(readFileSync(join(repo, 'scripts', 'lib', 'ffmpeg-mac-pin.json'), 'utf8'))
    const pinProblem = macFfmpegPinProblem(pin)
    if (pinProblem) throw new Error(pinProblem)
    if (node('fetch-ffmpeg-mac.mjs').status !== 0) throw new Error('the pinned macOS ffmpeg could not be put in ffmpeg-mac/ (see the message above)')
    const noticeProblem = macFfmpegNoticeProblem({
      licence: readOrNull(join(repo, 'resources', 'ffmpeg-mac', 'COPYING.GPLv3'))?.toString('utf8') ?? null,
      notice: readOrNull(join(repo, 'resources', 'ffmpeg-mac', 'FFMPEG-NOTICE.md'))?.toString('utf8') ?? null,
      pin,
    })
    if (noticeProblem) throw new Error(noticeProblem)
  }
  const problem = ffmpegShipProblem({
    binary: shippedFfmpegPath(repo, platform),
    targets,
    read: readOrNull,
    pin,
    arch: context ? context.arch : null,
  })
  if (problem) throw new Error(problem)
}
