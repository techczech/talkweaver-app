// Work-files ticket 22: the Published pages model (src/shared/published-pages.ts) on the drawn example
// (hifi shots 8-*, today = Wed 14 Oct 2026), and what main reads for it (src/main/published-pages.ts).
//   1. the drawn list: Run pages (Saïd, Keble, ITLC) then Talk handouts (two), newest first, each with its
//      link, published date and Unpublish; Medical Sciences (not published) and an unpublished Run are not listed;
//   2. a Run's pre-work and post-work pages sit inside its row, never rows of their own; the post-work link
//      reads "opens after the session" until it has opened (the checklist's own open test);
//   3. checked against the site folder: a folder missing here, the site's copy missing, a link that names
//      no folder of its own; what is blocked and what is not; never "publish again";
//   4. across vaults, keyed by vault; the empty list;
//   5. main: Runs and talks of every open vault with their folders, decided from their own facts;
//   6. review round 1: a talk's folder "here" by what is at its name (no home page still here; a link or a file
//      refused), the talk named by its outline (two outlines of one slug), a listing that fails is an error.
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-published-pages.mjs
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import {
  PAGE_FOLDER_MISSING, PAGE_FOLDER_UNCLEAR, PAGE_NOT_A_FOLDER, PAGE_NOT_HERE, PAGE_SITE_MISSING, PAGE_TALKS_UNREADABLE, SITE_LIST_ERROR, TALKS_UNREADABLE, publishedPages, shownLink,
} from '../src/shared/published-pages.ts'
import { TALK_NAME_SHARED, TALK_NOT_FOUND, talkByOutline, talkSiteFolder, siteEntry } from '../src/main/talk-unpublish.ts'
import { collectPublishedPages, siteClaims, siteListing } from '../src/main/published-pages.ts'
import { runChecklist } from '../src/shared/run-checklist.ts'

const TZ = 'Europe/London'
const NOW = new Date('2026-10-14T10:00:00Z')
const T1 = 'AI for research teams'
const T2 = 'Generative AI in teaching'
const pre = (opens, closes, extra = {}) => ({ fileId: 'research-teams-intake', opens, closes, timeZone: TZ, ...extra })
const post = (closes, extra = {}) => ({ fileId: 'session-feedback', opens: 'session-end', closes, timeZone: TZ, ...extra })
const named = (name) => ({ kind: 'named', name })

const said = (extra = {}) => ({
  vaultId: 'v1', talkSlug: 'ai-research', runId: 'said', talkTitle: T1, eventTitle: 'Saïd workshop', status: 'planned', plannedDate: '2026-10-21', startTime: '14:00',
  expectedPeople: 18, timeZone: TZ, handoutUrl: 'https://handouts.fyi/dl/said-21-oct', answers: { pre: 7 }, sent: ['pre', 'post'], folder: named('said-21-oct'),
  work: { pre: pre('2026-10-14T09:00', '2026-10-21T13:00', { publishedAt: '2026-10-14T08:00:00Z' }), post: post('2026-11-04T17:00', { publishedAt: '2026-10-14T08:00:00Z' }) }, ...extra,
})
const keble = (extra = {}) => ({
  vaultId: 'v1', talkSlug: 'ai-teaching', runId: 'keble', talkTitle: T2, eventTitle: 'Keble', status: 'planned', plannedDate: '2026-10-28', startTime: '16:00',
  timeZone: TZ, handoutUrl: 'https://handouts.fyi/dl/keble-28-oct', answers: { pre: 31 }, sent: ['pre'], folder: named('keble-28-oct'),
  work: { pre: pre('2026-10-12T09:00', '2026-10-28T15:00', { publishedAt: '2026-10-12T08:00:00Z' }) }, ...extra,
})
// Pre-work closed Fri 9 Oct; its Run page is still published, so it is listed (mockup data note).
const itlc = (extra = {}) => ({
  vaultId: 'v1', talkSlug: 'ai-teaching', runId: 'itlc', talkTitle: T2, eventTitle: 'ITLC lunchtime', status: 'delivered', plannedDate: '2026-10-09', startTime: '12:30',
  timeZone: TZ, handoutUrl: 'https://handouts.fyi/dl/itlc-9-oct', sent: ['pre'], folder: named('itlc-9-oct'), endedAt: '2026-10-09T12:30:00Z',
  work: { pre: pre('2026-10-01T09:00', '2026-10-09T11:30', { publishedAt: '2026-10-01T08:00:00Z' }) }, ...extra,
})
const med = () => ({
  vaultId: 'v1', talkSlug: 'ai-research', runId: 'med', talkTitle: T1, eventTitle: 'Medical Sciences', status: 'planned', plannedDate: '2026-11-04', startTime: '10:00',
  timeZone: TZ, folder: { kind: 'unclear' }, work: { pre: pre('2026-10-28T09:00', '2026-11-04T09:00') },
})
// Unpublished by ticket 17 (REPLACE): it keeps its link, and its pages show "not available": not listed.
const gone = () => ({ ...keble({ runId: 'gone', eventTitle: 'Gone', unpublishedAt: '2026-10-13T08:00:00Z' }) })
const talk = (vaultId, slug, title, folder = slug) => ({ vaultId, outline: `${slug}/${slug}-outline.md`, slug, title, outlinePath: `/vault/${slug}/${slug}-outline.md`, handoutUrl: `https://handouts.fyi/dl/${slug}`, folder: named(folder) })
const SITE = {
  exists: true,
  folders: [
    { name: 'said-21-oct', modifiedAt: '2026-10-14T08:00:00Z' }, { name: 'keble-28-oct' }, { name: 'itlc-9-oct' },
    { name: 'ai-for-research-teams', modifiedAt: '2026-10-02T09:00:00Z' }, { name: 'generative-ai-in-teaching', modifiedAt: '2026-09-19T09:00:00Z' },
  ],
}
const drawn = (extra = {}) => ({
  runs: [itlc(), med(), said(), gone(), keble()],
  talks: [talk('v1', 'generative-ai-in-teaching', T2), talk('v1', 'ai-for-research-teams', T1)],
  site: SITE, ...extra,
})

// ---- 1. the drawn list
{
  const list = publishedPages(drawn(), NOW)
  assert.equal(list.total, 5)
  assert.deepEqual(list.groups.map((group) => [group.id, group.label, group.rows.map((row) => row.title)]), [
    ['runs', 'Run pages', ['Saïd workshop', 'Keble', 'ITLC lunchtime']],
    ['talks', 'Talk handouts', [T1, T2]],
  ], 'Run pages first, newest first; Medical Sciences (not published) and an unpublished Run are not listed')
  const [s, k, i, t1, t2] = list.rows
  assert.deepEqual([s.linkShown, s.published, s.sub, s.kind], ['handouts.fyi/dl/said-21-oct', 'Published Wed 14 Oct', `Run page · ${T1}`, 'run'])
  assert.deepEqual([k.published, i.published], ['Published Mon 12 Oct', 'Published Thu 1 Oct'], 'a Run\'s date: when its pages went out')
  assert.deepEqual([t1.linkShown, t1.published, t1.sub, t2.published], ['handouts.fyi/dl/ai-for-research-teams', 'Published Fri 2 Oct', 'Talk handout', 'Published Sat 19 Sep'], 'a talk\'s date: when its home page was written')
  assert.ok(list.rows.every((row) => row.site === 'found' && row.note === null && row.unpublish.blocked === null), 'every page is in the site\'s copy: no note, Unpublish offered')
  assert.deepEqual(s.unpublish, { kind: 'run', vaultId: 'v1', talkSlug: 'ai-research', runId: 'said', blocked: null }, 'a Run unpublishes through ticket 17\'s path')
  assert.deepEqual(t1.unpublish, { kind: 'talk', vaultId: 'v1', outline: 'ai-for-research-teams/ai-for-research-teams-outline.md', blocked: null }, 'a talk is unpublished by its outline, never its slug')
  assert.deepEqual(s.confirm, { title: 'Unpublish Saïd workshop?', body: 'The handout, the pre-work page and the post-work page will show “This page is not available”. The 7 answers are kept.' }, 'the Run\'s confirmation is ticket 17\'s')
  assert.deepEqual(t1.confirm, { title: `Unpublish the handout for ${T1}?`, body: 'The handout will be taken off the site and its link will stop working.' })
  assert.equal(t1.outlinePath, '/vault/ai-for-research-teams/ai-for-research-teams-outline.md', 'Open talk')
  // A talk with published Runs: the confirmation says they stay up.
  const withRuns = publishedPages(drawn({ talks: [talk('v1', 'ai-research', T1)] }), NOW).rows.find((row) => row.kind === 'talk')
  assert.equal(withRuns.confirm.body, 'The handout will be taken off the site and its link will stop working. Pages published for its runs stay up.')
  assert.equal(shownLink('https://handouts.fyi/dl/x/'), 'handouts.fyi/dl/x')
  console.log('PASS 1: the drawn list: Run pages then Talk handouts, newest first, each with link, date and Unpublish')
}

// ---- 2. a Run's pages inside its row; post-work "opens after the session" until it opens
{
  const list = publishedPages(drawn(), NOW)
  const s = list.rows.find((row) => row.title === 'Saïd workshop')
  assert.deepEqual(s.links, [
    { kind: 'handout', label: 'Handout link', url: 'https://handouts.fyi/dl/said-21-oct' },
    { kind: 'pre-work', label: 'Pre-work link', url: 'https://handouts.fyi/dl/said-21-oct/pre-work' },
    { kind: 'post-work', label: 'Post-work link · opens after the session', url: 'https://handouts.fyi/dl/said-21-oct/post-work' },
  ])
  assert.ok(!list.rows.some((row) => /pre-work|post-work/.test(row.link)), 'no pre-work or post-work page is a row of its own')
  assert.equal(list.rows.filter((row) => row.unpublish.kind === 'run' && row.unpublish.runId === 'said').length, 1, 'one row for the Run')
  assert.deepEqual(list.rows.find((row) => row.title === 'Keble').links.map((link) => link.kind), ['handout', 'pre-work'], 'no post-work page: no post-work link')
  // The same open test as the checklist: once the app has opened it (openedAt), the label drops "opens after the session".
  const opened = said({ status: 'delivered', endedAt: '2026-10-21T15:00:00Z', work: { ...said().work, post: post('2026-11-04T17:00', { publishedAt: '2026-10-14T08:00:00Z', openedAt: '2026-10-21T15:58:00Z' }) } })
  const at = (iso) => publishedPages({ runs: [opened], talks: [], site: SITE }, new Date(iso)).rows[0].links[2].label
  for (const [when, label, checklist] of [
    ['2026-10-21T15:00:00Z', 'Post-work link · opens after the session', 'Post-work · opens after the session'],
    ['2026-10-22T10:00:00Z', 'Post-work link', 'Post-work · open'],
    ['2026-11-05T10:00:00Z', 'Post-work link · closed', 'Post-work · closed'],
  ]) {
    assert.equal(at(when), label, when)
    assert.equal(runChecklist(opened, new Date(when)).steps.find((step) => step.id === 'published').links[2].label, checklist, `the checklist agrees at ${when}`)
  }
  // Post-work at a set time: when it opens.
  const timed = said({ work: { ...said().work, post: { ...post('2026-11-04T17:00', { publishedAt: '2026-10-14T08:00:00Z' }), opens: '2026-10-22T09:00' } } })
  assert.equal(publishedPages({ runs: [timed], talks: [], site: SITE }, NOW).rows[0].links[2].label, 'Post-work link · opens Thu 22 Oct 09:00')
  // A Run with its handout only: one link, and its date from the site's copy.
  const plain = said({ sent: [], work: undefined, answers: undefined })
  const row = publishedPages({ runs: [plain], talks: [], site: SITE }, NOW).rows[0]
  assert.deepEqual([row.links.map((link) => link.kind), row.published, row.confirm.body], [['handout'], 'Published Wed 14 Oct', 'The handout will be taken off the site.'])
  console.log('PASS 2: a Run\'s pre-work and post-work links sit in its row; post-work reads "opens after the session" until the checklist\'s own test says it opened')
}

// ---- 3. checked against the site folder
{
  const missingHere = { exists: true, folders: SITE.folders.filter((entry) => !['said-21-oct', 'ai-for-research-teams'].includes(entry.name)) }
  const list = publishedPages(drawn({ site: missingHere }), NOW)
  const s = list.rows.find((row) => row.title === 'Saïd workshop')
  assert.deepEqual([s.site, s.note, s.unpublish.blocked, s.published], ['folder-missing', PAGE_FOLDER_MISSING, PAGE_FOLDER_MISSING, 'Published Wed 14 Oct'], 'a Run that sent work pages, its folder not here: blocked in ticket 17\'s words; its date from its own stamps')
  const t1 = list.rows.find((row) => row.title === T1)
  assert.deepEqual([t1.site, t1.note, t1.unpublish.blocked, t1.published], ['folder-missing', PAGE_NOT_HERE, null, 'Published'], 'a talk handout not here: said, and it goes ahead as 17\'s REMOVE; no date known')
  const plain = publishedPages({ runs: [said({ sent: [], work: undefined })], talks: [], site: missingHere }, NOW).rows[0]
  assert.deepEqual([plain.site, plain.note, plain.unpublish.blocked], ['folder-missing', PAGE_NOT_HERE, null], 'a Run with its handout only: goes ahead, as 17 does')

  const noSite = publishedPages(drawn({ site: { exists: false, folders: [] } }), NOW)
  assert.equal(noSite.total, 5, 'the site\'s copy missing: every page is still listed')
  assert.ok(noSite.rows.every((row) => row.site === 'site-missing'))
  assert.deepEqual(noSite.rows.filter((row) => row.unpublish.blocked).map((row) => row.title), ['Saïd workshop', 'Keble', 'ITLC lunchtime', T1, T2], 'every Run that sent work pages and every talk handout is blocked')
  assert.ok(noSite.rows.every((row) => row.note === PAGE_SITE_MISSING))

  const unclear = publishedPages(drawn({ runs: [said({ folder: { kind: 'unclear' } })], talks: [{ ...talk('v1', 'x', 'X'), folder: { kind: 'unclear' } }] }), NOW)
  assert.ok(unclear.rows.every((row) => row.site === 'unclear' && row.unpublish.blocked === PAGE_FOLDER_UNCLEAR))
  for (const sentence of [PAGE_SITE_MISSING, PAGE_FOLDER_MISSING, PAGE_FOLDER_UNCLEAR, PAGE_NOT_HERE]) assert.doesNotMatch(sentence, /publish (?:it )?again/i, 'D3: never "publish again"')
  console.log('PASS 3: checked against the site folder: missing here, the site\'s copy missing and an unclear link each said; blocked only where main refuses; never "publish again"')
}

// ---- 4. across vaults, keyed by vault; the empty list
{
  const list = publishedPages({
    runs: [said(), said({ vaultId: 'v2', folder: named('said-21-oct-2'), handoutUrl: 'https://handouts.fyi/dl/said-21-oct-2' })],
    talks: [talk('v1', 'ai-for-research-teams', T1), talk('v2', 'ai-for-research-teams', T1, 'ai-for-research-teams')],
    site: { exists: true, folders: [...SITE.folders, { name: 'said-21-oct-2' }] },
  }, NOW)
  assert.equal(new Set(list.rows.map((row) => row.key)).size, 4, 'the same talk and Run id in two vaults: two rows each')
  assert.deepEqual(list.rows.map((row) => row.vaultId).sort(), ['v1', 'v1', 'v2', 'v2'])
  assert.ok(list.rows.every((row) => row.unpublish.vaultId === row.vaultId), 'each Unpublish names its own vault')
  const empty = publishedPages({ runs: [med(), gone()], talks: [], site: { exists: true, folders: [] } }, NOW)
  assert.deepEqual([empty.total, empty.groups, empty.rows], [0, [], []], 'nothing published: the empty list')
  console.log('PASS 4: across vaults, keyed by vault; the empty list')
}

// ---- 5. main: what the view reads
{
  const root = mkdtempSync(join(tmpdir(), 'tw-published-pages-'))
  const site = join(root, 'site')
  const vaults = [{ id: 'v1', root: join(root, 'v1') }, { id: 'v2', root: join(root, 'v2') }]
  const outlines = {}
  const writeTalk = (vault, slug, title, url) => {
    const path = join(vault.root, slug, `${slug}-outline.md`)
    mkdirSync(join(vault.root, slug), { recursive: true })
    outlines[path] = `---\ntitle: ${title}\n${url ? `handout_url: ${url}\n` : ''}---\n\n### One\n`
    writeFileSync(path, outlines[path])
    return { slug, title, outlinePath: path }
  }
  const run = (vault, talkSlug, id, extra) => {
    mkdirSync(join(vault.root, '_PRESENTATIONS', talkSlug), { recursive: true })
    writeFileSync(join(vault.root, '_PRESENTATIONS', talkSlug, `${id}.json`), JSON.stringify({
      id, talkSlug, talkTitle: T1, kind: 'delivery', status: 'planned', plannedDate: '2026-10-21', startTime: '14:00', slideSet: { kind: 'full' },
      startedAt: '', endedAt: '', recordingMs: 0, wallClockMs: 0, timerTargetMin: 0, context: null, pathwayId: null, audio: null, transcript: null,
      slideTimeIndex: [], polls: [], pollResponses: [], ...extra,
    }))
  }
  const talks = {
    v1: [writeTalk(vaults[0], 'ai-research', T1, 'https://talks.test/t1ab'), writeTalk(vaults[0], 'unpublished', 'Not published', null)],
    v2: [writeTalk(vaults[1], 'ai-teaching', T2, 'https://talks.test/ai-teaching/'), writeTalk(vaults[1], 'claimed', 'Claimed', 'https://talks.test/claimed/')],
  }
  run(vaults[0], 'ai-research', 'said', { handoutUrl: 'https://talks.test/ai-research-said-2026-10-21/', handoutFolder: 'ai-research-said-2026-10-21' })
  run(vaults[0], 'ai-research', 'med', {})
  // A legacy Run whose link names the folder `claimed`: the talk of that name is unclear, never unpublished through it.
  run(vaults[1], 'ai-teaching', 'old', { handoutUrl: 'https://talks.test/claimed/' })
  for (const folder of ['ai-research', 'ai-research-said-2026-10-21', 'claimed']) { mkdirSync(join(site, folder), { recursive: true }); writeFileSync(join(site, folder, 'index.html'), folder) }
  mkdirSync(join(site, 'no-home'))
  utimesSync(join(site, 'ai-research', 'index.html'), new Date('2026-10-02T09:00:00Z'), new Date('2026-10-02T09:00:00Z'))
  // Fixed times, so the order (newest first) does not hang on milliseconds between writes.
  for (const [folder, at] of [['ai-research-said-2026-10-21', '2026-10-14T08:00:00Z'], ['claimed', '2026-10-10T08:00:00Z']]) utimesSync(join(site, folder, 'index.html'), new Date(at), new Date(at))
  const deps = {
    vaults: () => vaults,
    talks: (vaultRoot) => talks[vaults.find((vault) => vault.root === vaultRoot).id],
    readOutline: (path) => readFileSync(path, 'utf8'),
    siteDir: () => site,
    readRegistry: () => ({ 'ai-research': 't1ab' }),
    sentPhases: (r) => (r.id === 'said' ? ['pre'] : []),
  }
  const input = collectPublishedPages(deps)
  assert.deepEqual(input.site.folders.map((entry) => entry.name), ['ai-research', 'ai-research-said-2026-10-21', 'claimed'], 'the site\'s handout folders: real folders with a home page')
  assert.equal(input.site.folders[0].modifiedAt, '2026-10-02T09:00:00.000Z')
  assert.deepEqual(input.runs.map((r) => [r.vaultId, r.runId, r.folder, r.sent ?? []]), [
    ['v1', 'said', named('ai-research-said-2026-10-21'), ['pre']],
    ['v2', 'old', named('claimed'), []],
  ], 'Runs with a link, each with its folder from its own facts (a Run with none is not read)')
  assert.deepEqual(input.talks.map((t) => [t.vaultId, t.outline, t.slug, t.folder]), [
    ['v1', join('ai-research', 'ai-research-outline.md'), 'ai-research', { ...named('ai-research'), here: true }],
    ['v2', join('ai-teaching', 'ai-teaching-outline.md'), 'ai-teaching', { ...named('ai-teaching'), here: false }],
    ['v2', join('claimed', 'claimed-outline.md'), 'claimed', { kind: 'unclear' }],
  ], 'talks with handout_url: by short id, by name, and one whose folder a Run claims')
  const list = publishedPages(input, NOW)
  assert.deepEqual(list.rows.filter((row) => row.kind === 'run').map((row) => [row.key, row.site]), [['v1|run|ai-research/said', 'found'], ['v2|run|ai-teaching/old', 'found']])
  assert.deepEqual(list.rows.filter((row) => row.kind === 'talk').map((row) => [row.title, row.site]), [[T1, 'found'], ['Claimed', 'unclear'], [T2, 'folder-missing']])
  assert.deepEqual(siteClaims(deps, { vaultId: 'v1', outlinePath: talks.v1[0].outlinePath }), {
    runs: [{ handoutUrl: 'https://talks.test/ai-research-said-2026-10-21/', handoutFolder: 'ai-research-said-2026-10-21' }, { handoutUrl: 'https://talks.test/claimed/', handoutFolder: undefined }],
    talks: [{ slug: 'ai-teaching', handoutUrl: 'https://talks.test/ai-teaching/' }, { slug: 'claimed', handoutUrl: 'https://talks.test/claimed/' }],
    unreadable: 0,
  }, 'what a talk unpublish checks its folder against: every Run with a link and every OTHER talk with one')
  assert.deepEqual(siteListing(join(root, 'nowhere')), { exists: false, folders: [] })
  rmSync(root, { recursive: true, force: true })
  console.log('PASS 5: main reads every open vault\'s Runs and talks with links, each with its folder from its own facts, and the site\'s copy')
}

// ---- 6. review round 1
{
  const root = mkdtempSync(join(tmpdir(), 'tw-published-pages-r1-'))
  const site = join(root, 'site')
  const vault = { id: 'v1', root: join(root, 'v1') }
  const writeTalk = (folder, slug, url) => {
    const path = join(vault.root, folder, `${slug}-outline.md`)
    mkdirSync(join(vault.root, folder), { recursive: true })
    writeFileSync(path, `---\ntitle: ${slug}\n${url ? `handout_url: ${url}\n` : ''}---\n\n### One\n`)
    return { slug, title: slug, outlinePath: path }
  }
  mkdirSync(site, { recursive: true })
  // (1) What is at the talk's name, as Unpublish decides it: a real folder without a home page is here; a link and a file are not folders.
  const noHome = writeTalk('no-home', 'no-home', 'https://talks.test/no-home/')
  const linked = writeTalk('linked', 'linked', 'https://talks.test/linked/')
  const filed = writeTalk('filed', 'filed', 'https://talks.test/filed/')
  const absent = writeTalk('absent', 'absent', 'https://talks.test/absent/')
  mkdirSync(join(site, 'no-home', 'assets'), { recursive: true }); writeFileSync(join(site, 'no-home', 'no-home.html'), 'left behind')
  const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'index.html'), 'precious')
  symlinkSync(outside, join(site, 'linked'), 'dir')
  writeFileSync(join(site, 'filed'), 'a file')
  const deps = (talks) => ({ vaults: () => [vault], talks: () => talks, readOutline: (path) => readFileSync(path, 'utf8'), siteDir: () => site, readRegistry: () => ({}) })
  const input = collectPublishedPages(deps([noHome, linked, filed, absent]))
  assert.deepEqual(input.site.folders, [], 'the listing: none of these has a home page in a real folder')
  assert.deepEqual(input.talks.map((t) => [t.slug, t.folder]), [
    ['no-home', { ...named('no-home'), here: true }], ['linked', { kind: 'not-a-folder', name: 'linked' }],
    ['filed', { kind: 'not-a-folder', name: 'filed' }], ['absent', { ...named('absent'), here: false }],
  ])
  const rows = Object.fromEntries(publishedPages(input, NOW).rows.map((row) => [row.title, row]))
  assert.deepEqual([rows['no-home'].site, rows['no-home'].unpublish.blocked], ['found', null], 'a folder without a home page: here, and Unpublish removes it')
  for (const name of ['linked', 'filed']) assert.deepEqual([rows[name].site, rows[name].note, rows[name].unpublish.blocked], ['not-a-folder', PAGE_NOT_A_FOLDER, PAGE_NOT_A_FOLDER], `${name}: refused, as Unpublish refuses it`)
  assert.deepEqual([rows.absent.site, rows.absent.unpublish.blocked], ['folder-missing', null], 'nothing at the name: goes ahead, as 17\'s REMOVE')
  assert.doesNotMatch(PAGE_NOT_A_FOLDER, /publish (?:it )?again/i)
  assert.deepEqual([siteEntry(site, 'no-home'), siteEntry(site, 'linked'), siteEntry(site, 'filed'), siteEntry(site, 'absent')], ['folder', 'other', 'other', 'none'])

  // (2) The talk named by its outline. Two outlines of one vault with the same slug and the shared link:
  // neither excludes the other's claim (each is unclear), and the request by outline is refused.
  const one = writeTalk('first/same', 'same', 'https://talks.test/same/')
  const two = writeTalk('second/same', 'same', 'https://talks.test/same/')
  mkdirSync(join(site, 'same')); writeFileSync(join(site, 'same', 'index.html'), 'shared')
  const both = deps([one, two])
  assert.deepEqual(siteClaims(both, { vaultId: 'v1', outlinePath: one.outlinePath }).talks, [{ slug: 'same', handoutUrl: 'https://talks.test/same/' }], 'only the named outline is excluded: the other same-slug outline is a claim')
  const claims = siteClaims(both, { vaultId: 'v1', outlinePath: one.outlinePath })
  assert.deepEqual(talkSiteFolder({ slug: 'same', handoutUrl: 'https://talks.test/same/' }, ['same'], {}, claims, (name) => siteEntry(site, name)), { kind: 'unclear' }, 'so the folder is unclear and nothing is removed')
  const listed = collectPublishedPages(both)
  assert.deepEqual(listed.talks.map((t) => [t.outline, t.folder]), [[join('first', 'same', 'same-outline.md'), { kind: 'unclear' }], [join('second', 'same', 'same-outline.md'), { kind: 'unclear' }]])
  assert.equal(new Set(publishedPages(listed, NOW).rows.map((row) => row.key)).size, 2, 'two rows, keyed by outline')
  const guard = (path) => (path.startsWith(vault.root + sep) && path.endsWith('-outline.md') ? null : 'outside')
  assert.deepEqual(talkByOutline(vault.root, join('first', 'same', 'same-outline.md'), [one, two], guard), { ok: false, error: TALK_NAME_SHARED }, 'a slug two outlines share: refused')
  assert.deepEqual(talkByOutline(vault.root, join('no-home', 'no-home-outline.md'), [one, noHome], guard), { ok: true, talk: noHome }, 'by its outline')
  assert.deepEqual(talkByOutline(vault.root, '../elsewhere/x-outline.md', [noHome], guard), { ok: false, error: 'outside' }, 'outside the vault: the outline guard refuses')
  assert.deepEqual([talkByOutline(vault.root, 'nope/nope-outline.md', [noHome], guard), talkByOutline(vault.root, '', [noHome], guard), talkByOutline(vault.root, 7, [noHome], guard)].map((r) => r.error), [TALK_NOT_FOUND, TALK_NOT_FOUND, TALK_NOT_FOUND])
  assert.deepEqual([readFileSync(one.outlinePath, 'utf8'), readFileSync(two.outlinePath, 'utf8')].map((text) => /handout_url: https:\/\/talks.test\/same\//.test(text)), [true, true], 'neither outline changed')

  // (3) A listing that fails is an error, never an empty site; the model shows no rows and says so.
  const unreadable = join(root, 'unreadable')
  mkdirSync(unreadable)
  // A path that is a folder but whose listing throws: a folder with no read permission (where the platform honours it).
  chmodSync(unreadable, 0o000)
  let listingThrows = false
  try { readdirSync(unreadable) } catch { listingThrows = true }
  if (listingThrows) assert.deepEqual(siteListing(unreadable), { exists: true, folders: [], error: SITE_LIST_ERROR })
  chmodSync(unreadable, 0o755)
  const failed = publishedPages({ runs: [said()], talks: [talk('v1', 'ai-for-research-teams', T1)], site: { exists: true, folders: [], error: SITE_LIST_ERROR } }, NOW)
  assert.deepEqual([failed.total, failed.rows, failed.groups, failed.error], [0, [], [], SITE_LIST_ERROR], 'a failed listing: no rows, the error')
  assert.equal(publishedPages({ runs: [], talks: [], site: { exists: true, folders: [] } }, NOW).error, null, 'an empty site is not an error')
  rmSync(root, { recursive: true, force: true })
  assert.equal(publishedPages({ runs: [], talks: [], site: { exists: true, folders: [] } }, NOW).notice, null)
  console.log(`PASS 6: a talk's folder by what is at its name; the talk by its outline (a shared slug refused); a failed listing an error, not an empty site${listingThrows ? '' : ' (unreadable folder not simulated here)'}`)
}
// ---- 7. review round 2: talks that could not be read are said, never left out
{
  const root = mkdtempSync(join(tmpdir(), 'tw-published-pages-r2-'))
  const site = join(root, 'site')
  mkdirSync(join(site, 'only'), { recursive: true }); writeFileSync(join(site, 'only', 'index.html'), 'x')
  const vault = { id: 'v1', root: join(root, 'v1') }
  const path = join(vault.root, 'only', 'only-outline.md')
  mkdirSync(join(vault.root, 'only'), { recursive: true }); writeFileSync(path, '---\ntitle: Only\nhandout_url: https://talks.test/only/\n---\n')
  const deps = (read) => ({ vaults: () => [vault], talks: () => [{ slug: 'only', title: 'Only', outlinePath: path }], readOutline: read, siteDir: () => site, readRegistry: () => ({}) })
  // The only published outline cannot be read (null, as the app's reader gives, or a throw): the error with Retry, never "Nothing is published".
  for (const read of [() => null, () => { throw new Error('EACCES') }]) {
    const input = collectPublishedPages(deps(read))
    assert.deepEqual([input.talks, input.unreadable], [[], 1], 'counted, not silently left out')
    const list = publishedPages(input, NOW)
    assert.deepEqual([list.total, list.error, list.notice], [0, TALKS_UNREADABLE, null], 'nothing listed: the error, not the empty state')
  }
  // Some pages readable: shown, with the notice; talk handouts not offered for Unpublish (main refuses them); Run rows as before.
  const shown = publishedPages({ ...drawn(), unreadable: 2 }, NOW)
  assert.deepEqual([shown.total, shown.error, shown.notice], [5, null, TALKS_UNREADABLE])
  assert.ok(shown.rows.filter((row) => row.kind === 'talk').every((row) => row.unpublish.blocked === PAGE_TALKS_UNREADABLE && row.site === 'found'), 'talk handouts blocked while talks are unread')
  assert.ok(shown.rows.filter((row) => row.kind === 'run').every((row) => row.unpublish.blocked === null), 'Run rows unchanged (ticket 17\'s path)')
  assert.deepEqual(collectPublishedPages(deps((p) => readFileSync(p, 'utf8'))).unreadable, undefined, 'all readable: nothing said')
  assert.doesNotMatch(PAGE_TALKS_UNREADABLE, /publish (?:it )?again/i)
  rmSync(root, { recursive: true, force: true })
  console.log('PASS 7: talks that cannot be read: the error with Retry when nothing is listed, else the readable rows with a notice and talk handouts blocked')
}
console.log('published pages: ok')
