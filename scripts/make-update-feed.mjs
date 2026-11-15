#!/usr/bin/env node
// Writes one channel of talkweaver.app's updates.json from the files GitHub actually serves (ADR-0044;
// docs/RELEASING.md, "Publishing an alpha" and "Cut a release"). Run it after the GitHub release is PUBLISHED
// (a draft's files cannot be downloaded), in a checkout of the site repository, then review, commit and deploy.
//
//   node scripts/make-update-feed.mjs --site ../talkweaver.app --channel alpha   --version 0.45.0-alpha.2 --released 2026-11-16 --summary "One line." [--summary "…"]
//   node scripts/make-update-feed.mjs --site ../talkweaver.app --channel release --version 0.45.0 --released 2026-11-20   # summary from resources/whats-new/0.45.0.md
//
// It downloads TalkWeaver-mac-arm64.zip and TalkWeaver-windows-x64-setup.exe from the release, hashes them
// (SHA-512, as electron-updater checks) and writes the entry with its update files. A release also becomes
// `latest` (what copies before 0.45.0-alpha.2 read) and replaces an alpha it has caught up with.
// --file-dir <folder> reads the two files from a folder instead (for a dry run before publishing).
// A version published without notarisation (the workflow's skip_notarisation attaches NOT-NOTARISED.txt to its
// release; --not-notarised says so by hand) gets the line a person reads first in its summary:
// "This alpha is not notarised: after downloading it from the website, macOS asks you to allow it in System Settings."
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { compareVersions, isReleaseNumber, parseWhatsNew } from '@app-patterns/updates'
import { FEED_URL } from '../src/shared/update-identity.ts'
import { PUBLISHED_BUNDLE_ID, RELEASE_ASSET_PREFIX, isAlphaVersion, parseChannelFeed } from '../src/shared/update-channels.ts'
import { NOT_NOTARISED_ASSET, notNotarisedLine } from './lib/update-release-checks.mjs'

const { values: opt } = parseArgs({ options: {
  site: { type: 'string' }, channel: { type: 'string' }, version: { type: 'string' }, released: { type: 'string' },
  summary: { type: 'string', multiple: true }, 'file-dir': { type: 'string' }, 'dry-run': { type: 'boolean' }, 'not-notarised': { type: 'boolean' },
} })
const fail = (message) => { console.error(`make-update-feed: ${message}`); process.exit(1) }
if (!opt.site || !opt.channel || !opt.version || !opt.released) fail('usage: --site <talkweaver.app checkout> --channel alpha|release --version X --released YYYY-MM-DD [--summary "…"]…')
if (opt.channel === 'alpha' ? !isAlphaVersion(opt.version) : opt.channel === 'release' ? !isReleaseNumber(opt.version) : true) fail(`${opt.version} is not a${opt.channel === 'alpha' ? 'n alpha (X.Y.Z-alpha.N)' : ' release number'} for the ${opt.channel} channel`)
const feedPath = join(resolve(opt.site), 'public', 'updates.json')
if (!existsSync(feedPath)) fail(`${feedPath} not found: --site must be a checkout of techczech/talkweaver.app`)

let summary = opt.summary ?? []
if (!summary.length) {
  const notes = join(import.meta.dirname, '..', 'resources', 'whats-new', `${opt.version}.md`)
  if (!existsSync(notes)) fail(`no --summary and no ${notes}`)
  summary = parseWhatsNew(readFileSync(notes, 'utf8')).slice(0, 3).map((item) => (item.title ? `${item.title}. ${item.text}` : item.text))
}

// Published without notarisation? Then the summary says so first, in the words a person reads.
let notNotarised = opt['not-notarised'] === true
if (!notNotarised) {
  if (opt['file-dir']) notNotarised = existsSync(join(opt['file-dir'], NOT_NOTARISED_ASSET))
  else {
    const marker = await fetch(`${RELEASE_ASSET_PREFIX}v${opt.version}/${NOT_NOTARISED_ASSET}`, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': 'TalkWeaver-release-feed' } }).catch(() => null)
    notNotarised = marker?.status === 200
  }
}
if (notNotarised) {
  summary = [notNotarisedLine(opt.version), ...summary.filter((line) => line !== notNotarisedLine(opt.version))].slice(0, 3)
  console.log(`make-update-feed: ${opt.version} was published without notarisation: the summary says so first`)
}

const ASSETS = { mac: 'TalkWeaver-mac-arm64.zip', windows: 'TalkWeaver-windows-x64-setup.exe' }
async function describe(platform) {
  const name = ASSETS[platform]
  const url = `${RELEASE_ASSET_PREFIX}v${opt.version}/${name}`
  const hash = createHash('sha512')
  let size = 0
  if (opt['file-dir']) {
    for await (const chunk of createReadStream(join(opt['file-dir'], name))) { hash.update(chunk); size += chunk.length }
  } else {
    const response = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'TalkWeaver-release-feed' } })
    if (!response.ok || !response.body) fail(`${url} answered ${response.status}: publish the GitHub release first (a draft's files cannot be downloaded)`)
    for await (const chunk of response.body) { hash.update(chunk); size += chunk.length }
  }
  console.log(`make-update-feed: ${name}: ${size} bytes`)
  return { url, sha512: hash.digest('base64'), size, ...(platform === 'mac' ? { bundleId: PUBLISHED_BUNDLE_ID } : {}) }
}

const current = JSON.parse(readFileSync(feedPath, 'utf8'))
const entry = {
  version: opt.version, released: opt.released, summary,
  notes: `https://talkweaver.app/whats-new#${opt.version}`,
  download: { mac: 'https://talkweaver.app/download#mac', windows: 'https://talkweaver.app/download#windows' },
  update: { mac: await describe('mac'), windows: await describe('windows') },
}
const channels = current.channels ?? { release: { ...current.latest } }
let next
if (opt.channel === 'release') {
  const { update: _u, ...latest } = entry
  const keepAlpha = channels.alpha && compareVersions(channels.alpha.version, opt.version) > 0
  next = { schema: 1, latest, channels: { release: entry, ...(keepAlpha ? { alpha: channels.alpha } : {}) } }
} else {
  if (compareVersions(opt.version, channels.release.version) <= 0) fail(`the alpha ${opt.version} is not newer than the release ${channels.release.version}`)
  next = { schema: 1, latest: current.latest, channels: { release: channels.release, alpha: entry } }
}
const text = JSON.stringify(next, null, 2) + '\n'
const parsed = parseChannelFeed(text, FEED_URL)
if (!parsed.ok) fail(`the written feed would not validate (${parsed.reason}); nothing was written`)
if (opt['dry-run']) { console.log(text); process.exit(0) }
writeFileSync(feedPath, text)
console.log(`make-update-feed: wrote the ${opt.channel} channel (${opt.version}) to ${feedPath}. Review the diff, commit and deploy the site, then run npm run check:update-feed.`)
