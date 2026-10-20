// The image drawer's decisions (ticket 11), as pure functions: caption lines, tab membership, grouping
// with and without SlideWell, the one quiet line, which view shows for each answer, and arrow movement.
// Names in the fixtures are invented.
import assert from 'node:assert/strict'
import * as model from '../src/renderer/src/components/imageDrawerModel.ts'
import {
  captionFor, DRAWER_COPY, flatOrder, formatDay, groupHits, hitsForTab, moveIndex, quietLine, usedInLabel, viewFor
} from '../src/renderer/src/components/imageDrawerModel.ts'

const TALK = '/vault/talks/staff-briefing/staff-briefing.md'
const hit = (over) => ({
  key: 'k', source: 'screenshot', thumbUrl: 'twarchive://x', title: 'Transcript pane with speaker labels', detail: '', ocrText: '',
  match: 'words', score: 1, usedIn: [], ...over
})
const result = (hits, over = {}) => ({ provider: 'slidewell', hits, meaning: 'used', ...over })

// dates
assert.equal(formatDay('2026-10-08'), '8 Oct 2026')
assert.equal(formatDay('2026-01-31T10:00:00Z'), '31 Jan 2026')
assert.equal(formatDay(undefined), '')
assert.equal(formatDay('last week'), 'last week')

// used in: distinct talks, not slides
assert.equal(usedInLabel(hit({ usedIn: [] })), null)
assert.equal(usedInLabel(hit({ usedIn: [{ talkTitle: 'A', talkPath: '/a.md', slide: 2 }] })), 'Used in 1 talk')
assert.equal(usedInLabel(hit({ usedIn: [{ talkTitle: 'A', talkPath: '/a.md', slide: 2 }, { talkTitle: 'A', talkPath: '/a.md', slide: 9 }] })), 'Used in 1 talk')
assert.equal(usedInLabel(hit({ usedIn: [{ talkTitle: 'A', talkPath: '/a.md', slide: 2 }, { talkTitle: 'B', talkPath: '/b.md', slide: 1 }] })), 'Used in 2 talks')

// captions
assert.deepEqual(captionFor(hit({ app: 'Chrome', date: '2026-10-08', usedIn: [{ talkTitle: 'A', talkPath: '/a.md', slide: 2 }] }), TALK, true),
  { title: 'Transcript pane with speaker labels', detail: 'Chrome · 8 Oct 2026', usedIn: 'Used in 1 talk' }, 'screenshot: app · date, used in')
assert.equal(captionFor(hit({ source: 'added-image', date: '2026-09-29' }), TALK, true).detail, '29 Sep 2026', 'no app: the date alone')
assert.deepEqual(captionFor(hit({ source: 'archive-image', title: 'Digital Skills Forum 2024', presentationTitle: 'Digital Skills Forum 2024' }), TALK, true),
  { title: 'Digital Skills Forum 2024', detail: 'Old PowerPoint', usedIn: null }, 'old PowerPoint image names its presentation')
assert.equal(captionFor(hit({ source: 'archive-image', title: '', presentationTitle: undefined }), TALK, true).title, 'Image from an old PowerPoint')
assert.equal(captionFor(hit({ source: 'archive-image', presentationTitle: 'Digital Skills Forum 2024' }), TALK, false).detail, '', 'grouped list: the group already says old PowerPoints')
const own = hit({ source: 'talk-image', title: 'Raw transcript, before cleaning', usedIn: [{ talkTitle: 'Teaching with AI', talkPath: TALK, slide: 8 }] })
assert.equal(captionFor(own, TALK, true).detail, 'This talk · slide 8', 'the open talk’s own picture')
assert.equal(captionFor(own, TALK, true).usedIn, null)
const other = hit({ source: 'talk-image', title: 'Raw transcript', date: '2025-03-02', usedIn: [{ talkTitle: 'Oxford AI Day', talkPath: '/other.md', slide: 3 }] })
assert.equal(captionFor(other, TALK, true).detail, 'Oxford AI Day · 2025', 'another talk’s picture: talk · year')
assert.equal(captionFor(other, TALK, true).usedIn, 'Used in 1 talk')

// tabs: old slides have their own tab; the first tab holds everything else
const slide = hit({ key: 's', source: 'old-slide' })
const shot = hit({ key: 'a' })
assert.deepEqual(hitsForTab(result([shot, slide]), 'images').map((h) => h.key), ['a'])
assert.deepEqual(hitsForTab(result([shot, slide]), 'old-slides').map((h) => h.key), ['s'])
assert.deepEqual(hitsForTab(null, 'images'), [])

// grouping
const archive = hit({ key: 'p', source: 'archive-image' })
const own2 = { ...own, key: 'o' }
assert.deepEqual(groupHits([shot, archive], true, TALK).map((g) => g.label), [null], 'with SlideWell: one flat list in the search’s order')
assert.deepEqual(groupHits([archive, own2], false, TALK).map((g) => [g.label, g.hits.map((h) => h.key)]),
  [[DRAWER_COPY.groupThisTalk, ['o']], [DRAWER_COPY.groupOldPowerPoints, ['p']]], 'without SlideWell: this talk, then old PowerPoints')
assert.deepEqual(groupHits([archive], false, TALK).map((g) => g.label), [DRAWER_COPY.groupOldPowerPoints], 'an empty group has no heading')
assert.deepEqual(groupHits([], false, TALK), [])
assert.deepEqual(flatOrder(groupHits([archive, own2], false, TALK)).map((h) => h.key), ['o', 'p'], 'arrow keys follow the drawn order')

// views
const base = { tab: 'images', query: 'parakeet', loading: false, result: null, failed: false, status: { provider: 'slidewell' }, currentTalkPath: TALK }
assert.equal(viewFor({ ...base, query: '  ' }).kind, 'idle')
assert.equal(viewFor({ ...base, tab: 'old-slides', query: '' }).kind, 'idle', 'the Old slides tab searches like the first tab')
assert.equal(viewFor({ ...base, tab: 'old-slides', result: result([slide]) }).kind, 'results')
assert.equal(viewFor({ ...base, tab: 'old-slides', result: result([shot]) }).kind, 'none', 'pictures are not slides')
assert.equal(viewFor({ ...base, loading: true }).kind, 'searching')
assert.equal(viewFor({ ...base, failed: true }).kind, 'unavailable')
assert.deepEqual(viewFor({ ...base, result: result([]) }), { kind: 'none', query: 'parakeet' })
assert.deepEqual(viewFor({ ...base, result: result([slide]) }), { kind: 'none', query: 'parakeet' }, 'only old slides found: nothing on this tab')
const found = viewFor({ ...base, result: result([shot, archive]) })
assert.equal(found.kind, 'results')
assert.equal(found.count, 2)

// the quiet line
const SW = { provider: 'slidewell', archive: true }
assert.deepEqual(quietLine(SW, null, 'images'), { icon: false, text: 'From your SlideWell library: screenshots, added images and the pictures in your talks, plus images from your old PowerPoints' })
assert.equal(quietLine({ provider: 'slidewell', archive: false }, null, 'images').text, 'From your SlideWell library: screenshots, added images and the pictures in your talks', 'no archive: old PowerPoints are not claimed')
assert.deepEqual(quietLine({ provider: 'archive', archive: true }, null, 'images'), { icon: true, text: 'SlideWell is not set up, so screenshots and the pictures in your talks cannot be found here. Only images from your old PowerPoints can.' })
assert.deepEqual(quietLine({ provider: null, archive: false }, null, 'images'), { icon: true, text: 'SlideWell is not set up and no old-PowerPoint archive is chosen, so there is nothing to search. Screenshots and images need SlideWell; the archive folder is chosen in Settings.' })
assert.equal(quietLine(null, null, 'images'), null, 'no line until the sources are known')
assert.equal(quietLine(SW, result([], { meaning: 'unavailable' }), 'images').text, DRAWER_COPY.meaningOff)
assert.equal(quietLine(SW, result([], { meaning: 'off' }), 'images').text, DRAWER_COPY.sourceLine)
assert.deepEqual(quietLine({ provider: 'archive', archive: true }, null, 'old-slides'), { icon: false, text: 'Slides from your old PowerPoints, from the archive folder chosen in Settings. SlideWell is not needed.' })
assert.equal(quietLine(SW, null, 'old-slides').icon, false, 'old slides come from the archive, with or without SlideWell')
assert.deepEqual(quietLine({ provider: 'slidewell', archive: false }, null, 'old-slides'), { icon: true, text: 'No old-PowerPoint archive is chosen, so there are no old slides to search. Choose the archive folder in Settings.' })
assert.match(DRAWER_COPY.idle, /pasted into a talk appears here only once SlideWell has filed it/)
assert.ok(!/error|failed|couldn/i.test(DRAWER_COPY.noSlideWell + DRAWER_COPY.meaningOff + DRAWER_COPY.nothingToSearch + DRAWER_COPY.oldSlidesNoArchive), 'quiet lines never read as errors')

// arrows: two across
assert.equal(moveIndex(0, 'ArrowDown', 5), 2)
assert.equal(moveIndex(4, 'ArrowDown', 5), 4)
assert.equal(moveIndex(3, 'ArrowDown', 5), 4, 'last row, short: lands on the last image')
assert.equal(moveIndex(2, 'ArrowUp', 5), 0)
assert.equal(moveIndex(1, 'ArrowUp', 5), 0)
assert.equal(moveIndex(0, 'ArrowLeft', 5), 0)
assert.equal(moveIndex(4, 'ArrowRight', 5), 4)
assert.equal(moveIndex(1, 'ArrowRight', 5), 2)
assert.equal(moveIndex(3, 'ArrowDown', 0), 0)

// In your talks: its own answer, its own lines, no SlideWell needed
const vh = (id, extra = {}) => hit({ key: 'vault:v1:' + id, source: 'vault-image', title: 'Harbour lights', detail: 'harbour', ...extra })
const vaultAnswer = (hits, vaults = 1) => ({ vaults, hits })
assert.equal(DRAWER_COPY.tabInTalks, 'TalkWeaver Vaults')
assert.deepEqual(quietLine(null, null, 'in-talks', vaultAnswer([vh('img-aaaaaaa')])), { icon: false, text: 'Pictures already in your talks, from your open vaults. SlideWell is not needed.' }, 'no status needed, no SlideWell needed')
assert.deepEqual(quietLine({ provider: null, archive: false }, null, 'in-talks', null), { icon: false, text: 'Pictures already in your talks, from your open vaults. SlideWell is not needed.' }, 'same with nothing else set up')
assert.deepEqual(quietLine(null, null, 'in-talks', vaultAnswer([], 0)), { icon: true, text: 'Open a vault to see the pictures in its talks.' }, 'no vault open')
const inTalks = (over) => viewFor({ tab: 'in-talks', query: '', loading: false, result: null, vault: vaultAnswer([vh('img-aaaaaaa'), vh('img-bbbbbbb')]), failed: false, status: null, currentTalkPath: TALK, ...over })
assert.equal(inTalks({}).kind, 'results', 'an empty query lists the pictures (no idle state)')
assert.equal(inTalks({}).count, 2)
assert.equal(inTalks({ vault: null }).kind, 'searching')
assert.equal(inTalks({ vault: vaultAnswer([], 0) }).kind, 'no-vault')
assert.deepEqual(inTalks({ vault: vaultAnswer([]), query: ' zzz ' }), { kind: 'none', query: 'zzz' })
assert.equal(DRAWER_COPY.inTalksNone, 'No pictures in your talks match that.')
assert.equal(inTalks({ failed: true }).kind, 'unavailable')
assert.deepEqual(hitsForTab(result([vh('img-aaaaaaa'), hit()]), 'old-slides').length, 0, 'vault pictures are not old slides')
// captions: used-in counted in talks, the open talk named
const used = vh('img-aaaaaaa', { usedIn: [{ talkTitle: 'A', talkPath: TALK, slide: 0 }, { talkTitle: 'B', talkPath: '/b.md', slide: 0 }] })
assert.deepEqual(captionFor(used, TALK, true), { title: 'Harbour lights', detail: 'This talk', usedIn: 'Used in 2 talks' })
assert.deepEqual(captionFor(vh('img-bbbbbbb', { usedIn: [{ talkTitle: 'B', talkPath: '/b.md', slide: 0 }] }), TALK, true), { title: 'Harbour lights', detail: 'harbour', usedIn: 'Used in 1 talk' })
// insert: no direct-insert plan any more; every In your talks picture goes through images:import (main finds the talk's vault)
assert.equal(model.vaultInsertPlan, undefined, 'no vaultInsertPlan')

console.log('image drawer model: all checks passed')
