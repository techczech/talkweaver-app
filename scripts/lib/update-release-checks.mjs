// The two release checks of update notices (ADR-0041, docs/RELEASING.md): pure functions, so a test can
// drive them without a network. scripts/check-whats-new.mjs (before packing) and
// scripts/check-update-feed.mjs (the last release step) are their thin command-line sides.
import { isReleaseNumber, validateFeed as validate } from '@app-patterns/updates'
import { FEED_URL } from '../../src/shared/update-identity.ts'
const validateFeed = (text) => validate(text, FEED_URL)
import { parseWhatsNew } from '@app-patterns/updates'

/** Problems with a version's What's new notes. A preview needs none. Empty list = fine. */
export function whatsNewProblems(version, notesText) {
  if (!isReleaseNumber(version)) return []
  if (notesText === null || notesText === undefined) return [`resources/whats-new/${version}.md is missing: every release ships its What's new notes`]
  const items = parseWhatsNew(notesText)
  const problems = []
  if (items.length < 3 || items.length > 8) problems.push(`resources/whats-new/${version}.md has ${items.length} items; it needs three to eight short bullet items`)
  for (const item of items) if (item.text.length > 240) problems.push(`a What's new item is longer than 240 characters: "${item.text.slice(0, 40)}..."`)
  return problems
}

/**
 * Problems with the live feed against the latest published release (`tag` like `v0.42.0`). The feed must
 * validate (so every link is on talkweaver.app) and name the same version as the release.
 */
export function feedProblems({ feedText, releaseTag }) {
  const feed = validateFeed(feedText)
  if (!feed.ok) return [`updates.json is not a valid version list (${feed.reason})`]
  const problems = []
  const published = String(releaseTag ?? '').replace(/^v/, '')
  if (!isReleaseNumber(published)) problems.push(`the latest published release "${releaseTag}" is not a release number`)
  else if (published !== feed.latest.version) problems.push(`updates.json says ${feed.latest.version} but the latest published release is ${published}`)
  return problems
}

/** The distinct addresses (without the # part) a feed asks the app to open. */
export function feedAddresses(latest) {
  return [...new Set([latest.notes, latest.download.mac, latest.download.windows].map((link) => link.split('#')[0]))]
}
