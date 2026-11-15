#!/usr/bin/env node
// The last step of a release or an alpha (docs/RELEASING.md, ADR-0044): fetch the live
// https://talkweaver.app/updates.json and check it against GitHub. It fails when
//  - the feed does not validate (every link on talkweaver.app; channels.release equal to latest; every update file a
//    release asset of techczech/talkweaver-app at its own tag);
//  - latest/channels.release is not the latest PUBLISHED release;
//  - channels.alpha (if any) is not newer than the release, or its GitHub release is missing, a draft or not a prerelease;
//  - a channel names no update file for the Mac or for Windows;
//  - a version published without notarisation (the workflow's skip_notarisation attaches NOT-NOTARISED.txt to its
//    release) does not say so, in the words a person reads, in its release notes and in its feed summary;
//  - a link does not answer;
//  - any update file the feed names, downloaded in full, does not have the stated size and SHA-512.
//
//   node scripts/check-update-feed.mjs                       # the live feed against GitHub
//   node scripts/check-update-feed.mjs --no-files            # without downloading the update files (about 1 GB)
//   node scripts/check-update-feed.mjs --feed-file f.json --release-tag v0.45.0 --alpha-release none --no-links --no-files   # offline
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { validateFeed as validate } from '@app-patterns/updates'
import { FEED_URL } from '../src/shared/update-identity.ts'
import { parseChannelFeed } from '../src/shared/update-channels.ts'
import { channelFeedProblems, feedAddresses, fileProblems, updateFilesOf } from './lib/update-release-checks.mjs'

const args = process.argv.slice(2)
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const timeout = (ms = 15_000) => AbortSignal.timeout(ms)
const GH = { 'User-Agent': 'TalkWeaver-release-check', Accept: 'application/vnd.github+json' }
const API = 'https://api.github.com/repos/techczech/talkweaver-app'

const feedText = arg('--feed-file') ? readFileSync(arg('--feed-file'), 'utf8') : await (await fetch(FEED_URL, { signal: timeout() })).text()
const latestRelease = arg('--release-tag') ? null : await (await fetch(`${API}/releases/latest`, { headers: GH, signal: timeout() })).json()
const releaseTag = arg('--release-tag') ?? latestRelease.tag_name
const releaseGitHub = arg('--release-github') ? JSON.parse(arg('--release-github')) : latestRelease ? { assets: (latestRelease.assets ?? []).map((a) => a.name), body: latestRelease.body ?? '' } : null
const parsed = parseChannelFeed(feedText, FEED_URL)
let alphaRelease = null
if (arg('--alpha-release')) alphaRelease = arg('--alpha-release') === 'none' ? null : JSON.parse(arg('--alpha-release'))
else if (parsed.ok && parsed.feed.alpha) {
  const answer = await fetch(`${API}/releases/tags/v${parsed.feed.alpha.version}`, { headers: GH, signal: timeout() })
  if (answer.ok) { const r = await answer.json(); alphaRelease = { tag: r.tag_name, draft: r.draft, prerelease: r.prerelease, assets: (r.assets ?? []).map((a) => a.name), body: r.body ?? '' } }
}

const problems = channelFeedProblems({ feedText, releaseTag, alphaRelease, releaseGitHub })
const feed = validate(feedText, FEED_URL)
if (feed.ok && !args.includes('--no-links')) {
  const entries = [feed.latest, ...(parsed.ok && parsed.feed.alpha ? [parsed.feed.alpha] : [])]
  for (const address of new Set(entries.flatMap(feedAddresses))) {
    try {
      const response = await fetch(address, { method: 'GET', redirect: 'follow', signal: timeout() })
      if (!response.ok) problems.push(`${address} answered ${response.status}`)
    } catch (error) {
      problems.push(`${address} could not be reached (${error.message})`)
    }
  }
}
const files = updateFilesOf(feedText)
if (!args.includes('--no-files')) {
  for (const file of files) {
    try {
      const response = await fetch(file.url, { redirect: 'follow', headers: { 'User-Agent': 'TalkWeaver-release-check' }, signal: timeout(30 * 60_000) })
      const hash = createHash('sha512')
      let size = 0
      if (response.ok && response.body) for await (const chunk of response.body) { hash.update(chunk); size += chunk.length }
      problems.push(...fileProblems(file, { status: response.status, size, sha512: hash.digest('base64') }))
      if (response.ok) console.log(`check-update-feed: ${file.channel} ${file.version} ${file.platform}: ${size} bytes, SHA-512 as stated`)
    } catch (error) {
      problems.push(`${file.url} could not be downloaded (${error.message})`)
    }
  }
}
if (problems.length) {
  for (const problem of problems) console.error(`check-update-feed: ${problem}`)
  process.exit(1)
}
const alphaLine = parsed.ok && parsed.feed.alpha ? `; the alpha channel offers ${parsed.feed.alpha.version} (a published prerelease)` : '; no alpha is offered'
console.log(`check-update-feed: updates.json and the latest release agree on ${feed.latest.version}${alphaLine}; every link is on talkweaver.app${args.includes('--no-links') ? '' : ' and answers'}; ${files.length} update file(s)${args.includes('--no-files') ? ' named (not downloaded)' : ' downloaded and match'}`)
