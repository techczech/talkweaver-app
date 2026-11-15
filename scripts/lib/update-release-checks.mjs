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

// ── Channels and update files (ADR-0044) ──────────────────────────────────────────────────────────
import { compareVersions } from '@app-patterns/updates'
import { parseChannelFeed } from '../../src/shared/update-channels.ts'

/** The asset the release workflow attaches when it was run with skip_notarisation (docs/patch-public-release-alphas-0.45.0.patch). */
export const NOT_NOTARISED_ASSET = 'NOT-NOTARISED.txt'
/** What a person reads, in the release notes and in the feed's summary, about a version published without notarisation. */
export const notNotarisedLine = (version) =>
  `This ${/-alpha\./.test(version) ? 'alpha' : 'version'} is not notarised: after downloading it from the website, macOS asks you to allow it in System Settings.`

/** Problems with the not-notarised label: `github` is `{ assets: string[], body: string }` for that version's release. */
export function notarisationLabelProblems(entry, github) {
  if (!entry || !github || !(github.assets ?? []).includes(NOT_NOTARISED_ASSET)) return []
  const line = notNotarisedLine(entry.version)
  const problems = []
  if (!(entry.summary ?? []).includes(line)) problems.push(`${entry.version} was published without notarisation (${NOT_NOTARISED_ASSET} is on its release) but its updates.json summary does not say so: add "${line}" (scripts/make-update-feed.mjs does this)`)
  if (!String(github.body ?? '').includes(line)) problems.push(`${entry.version} was published without notarisation but its GitHub release notes do not say so: add "${line}"`)
  return problems
}

/**
 * Problems with the live feed's channels against what GitHub publishes. `releaseTag`: the latest published
 * release (`v0.45.0`); `alphaRelease`: what GitHub says about the alpha's tag, `{ tag, draft, prerelease, assets?,
 * body? }`, or null when it has no such release; `releaseGitHub`: `{ assets, body }` of the latest release, if known.
 * Empty list = fine.
 */
export function channelFeedProblems({ feedText, releaseTag, alphaRelease, releaseGitHub = null }) {
  const problems = [...feedProblems({ feedText, releaseTag })]
  const parsed = parseChannelFeed(feedText, FEED_URL)
  if (!parsed.ok) return [...problems, `updates.json channels are not valid (${parsed.reason}): channels.release must equal latest, and every update file must be a release asset of techczech/talkweaver-app at its own tag`]
  const { release, alpha } = parsed.feed
  for (const platform of ['mac', 'windows']) if (!release.update?.[platform]) problems.push(`the release ${release.version} names no ${platform} update file: copies on ${platform} will be sent to the download page`)
  if (alpha) {
    if (compareVersions(alpha.version, release.version) <= 0) problems.push(`the alpha ${alpha.version} is not newer than the release ${release.version}: remove channels.alpha (scripts/make-update-feed.mjs does this when it writes a release)`)
    if (!alphaRelease) problems.push(`the alpha ${alpha.version} has no GitHub release v${alpha.version}`)
    else {
      if (alphaRelease.draft) problems.push(`the alpha's GitHub release v${alpha.version} is still a draft`)
      if (!alphaRelease.prerelease) problems.push(`the alpha's GitHub release v${alpha.version} is not marked as a prerelease, so it may have become "latest"`)
    }
    for (const platform of ['mac', 'windows']) if (!alpha.update?.[platform]) problems.push(`the alpha ${alpha.version} names no ${platform} update file`)
    problems.push(...notarisationLabelProblems(alpha, alphaRelease))
  }
  problems.push(...notarisationLabelProblems(release, releaseGitHub))
  return problems
}

/** Every update file the feed names: `{ channel, version, platform, url, sha512, size }`. */
export function updateFilesOf(feedText) {
  const parsed = parseChannelFeed(feedText, FEED_URL)
  if (!parsed.ok) return []
  const out = []
  for (const [channel, entry] of [['release', parsed.feed.release], ['alpha', parsed.feed.alpha]]) {
    if (!entry?.update) continue
    for (const platform of ['mac', 'windows']) {
      const file = entry.update[platform]
      if (file) out.push({ channel, version: entry.version, platform, url: file.url, sha512: file.sha512, size: file.size })
    }
  }
  return out
}

/** A downloaded file against what the feed says about it. */
export function fileProblems(file, got) {
  if (got.status !== 200) return [`${file.url} answered ${got.status}`]
  const problems = []
  if (got.size !== file.size) problems.push(`${file.url} is ${got.size} bytes; updates.json says ${file.size}`)
  if (got.sha512 !== file.sha512) problems.push(`${file.url} has SHA-512 ${got.sha512}; updates.json says ${file.sha512}`)
  return problems
}
