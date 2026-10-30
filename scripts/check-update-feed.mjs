#!/usr/bin/env node
// The last step of a release (docs/RELEASING.md, ADR-0041): fetch the live https://talkweaver.app/updates.json
// and the latest PUBLISHED release of techczech/talkweaver-app, and fail when the versions differ, a link is
// off talkweaver.app, or a link does not answer. Run it after the release is published and the site is deployed.
//
//   node scripts/check-update-feed.mjs                      # the live feed and the live release
//   node scripts/check-update-feed.mjs --feed-file f.json --release-tag v0.42.0 --no-links   # offline
import { readFileSync } from 'node:fs'
import { validateFeed as validate } from '@app-patterns/updates'
import { FEED_URL } from '../src/shared/update-identity.ts'
const validateFeed = (text) => validate(text, FEED_URL)
import { feedAddresses, feedProblems } from './lib/update-release-checks.mjs'

const args = process.argv.slice(2)
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const timeout = () => AbortSignal.timeout(15_000)

const feedText = arg('--feed-file') ? readFileSync(arg('--feed-file'), 'utf8') : await (await fetch(FEED_URL, { signal: timeout() })).text()
const releaseTag = arg('--release-tag') ?? (await (await fetch('https://api.github.com/repos/techczech/talkweaver-app/releases/latest', { headers: { 'User-Agent': 'TalkWeaver-release-check', Accept: 'application/vnd.github+json' }, signal: timeout() })).json()).tag_name

const problems = feedProblems({ feedText, releaseTag })
const feed = validateFeed(feedText)
if (feed.ok && !args.includes('--no-links')) {
  for (const address of feedAddresses(feed.latest)) {
    try {
      const response = await fetch(address, { method: 'GET', redirect: 'follow', signal: timeout() })
      if (!response.ok) problems.push(`${address} answered ${response.status}`)
    } catch (error) {
      problems.push(`${address} could not be reached (${error.message})`)
    }
  }
}
if (problems.length) {
  for (const problem of problems) console.error(`check-update-feed: ${problem}`)
  process.exit(1)
}
console.log(`check-update-feed: updates.json and the latest release agree on ${feed.latest.version}; every link is on talkweaver.app${args.includes('--no-links') ? '' : ' and answers'}`)
