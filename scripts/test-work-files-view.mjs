// Work-files ticket 06: the Work files view's listing and used-by derivation (src/shared/work-files-view.ts,
// src/main/work-files.ts), against a temp vault with the example data of the locked mockup (#s9-*).
//   1. the example: Research teams intake (pre 2 · post 0, 4 runs), Session feedback (0 · 1, 2 runs),
//      Journal club prompts (1 · 1, 0 runs), in that order, with the drawn "Used as pre-work in …" line;
//   2. an open file's steps: kind, layout, id, thumbnail kind; findings listed and counted;
//   3. used by: talks by role from their front matter, unsent Runs, sent Runs with their dates;
//   4. a talk may name a file by its file name; a file with a bad id is still listed;
//   5. an empty vault and a missing folder list nothing; folders, links, big files and non-.md files are skipped.
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-work-files-view.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlannedRun, persistRunForTalk, readRunForTalk } from '../src/main/runs.ts'
import { talkTitleText, editWindowTitle } from '../src/shared/talk-title-text.ts'
import { displayName } from '../src/renderer/src/components/talklist/model.ts'
import { addWorkFileStep, createWorkFile, setWorkFileStepLocal } from '../src/main/work-file-write.ts'
import { workFileKey, buildWorkFileItems } from '../src/shared/work-files-view.ts'
import { MAX_WORK_FILE_BYTES, listWorkFiles, listWorkFilesAcross, listWorkFilesFor, workFileWriteRoot } from '../src/main/work-files.ts'
import { readTalkWorkNames, runCountText, usedByCounts, usedLine } from '../src/shared/work-files-view.ts'

const head = (id, title) => ['---', `id: ${id}`, `title: ${title}`, 'revision: 1', '---', ''].join('\n')
const RTI = head('research-teams-intake', 'Research teams intake') + [
  'Four short steps.', '',
  '### Watch: what the tools can do', '{id=watch}{video}', '![](https://youtu.be/dQw4w9WgXcQ)',
  '### Quick check', '{id=check}{check}{poll=single}', '- One {right}', '- Two', '- Three',
  '### Try one prompt on a paper of your own', '{id=try-a-prompt}{task}', '1. Pick a paper', '2. Try a prompt',
  '### What do you most want from the session?', '{id=what-you-want}{poll=open}', '',
].join('\n')
const SFB = head('session-feedback', 'Session feedback') + [
  '### How useful was the session for your work?', '{id=useful}{poll=rating}',
  '### One thing you will try', '{id=will-try}{poll=open}',
  '### Anything unclear?', '{id=unclear}{poll=open}', '',
].join('\n')
const JCP = head('journal-club-prompts', 'Journal club prompts') + [
  '### The paper', '{id=paper}', 'Read it.',
  '### Two checks', '{id=checks}{check}{poll=single}', '- a {right}', '- b',
  '### One question', '{id=ask}{poll=open}', '',
].join('\n')
const BROKEN = ['---', 'title: Broken one', '---', '', '### Step with a table {id=tab}', '| a | b |', '|--|--|', '| 1 | 2 |', ''].join('\n')

const outline = (title, extra = []) => ['---', `title: ${title}`, ...extra, '---', '', '## One', ''].join('\n')

function vault() {
  const root = mkdtempSync(join(tmpdir(), 'tw-work-files-'))
  const talks = []
  const talk = (slug, title, extra) => {
    mkdirSync(join(root, slug), { recursive: true })
    const outlinePath = join(root, slug, 'outline.md')
    writeFileSync(outlinePath, outline(title, extra))
    talks.push({ slug, title, outlinePath })
  }
  talk('ai-for-research-teams', 'AI for research teams', ['prework: research-teams-intake', 'postwork: session-feedback'])
  talk('gen-ai-in-teaching', 'Generative AI in teaching', ['prework: research-teams-intake # the intake'])
  talk('journal-club', 'Journal club', ['prework: "journal-club-prompts.md"', 'postwork: journal-club-prompts'])
  talk('plain-talk', 'A talk with none', [])
  return { root, talks }
}

const write = (root, name, text) => { mkdirSync(join(root, 'Work files'), { recursive: true }); writeFileSync(join(root, 'Work files', name), text) }

// Runs: the three sent ones carry research-teams-intake (pinned), one unsent; session feedback has one sent, one unsent.
function plan(root, slug, title, eventTitle, work, id) {
  return createPlannedRun(root, { talkSlug: slug, talkTitle: title, plannedDate: '2026-11-02', eventTitle, slideSet: { kind: 'full' }, work }, () => id)
}
function send(root, slug, id, phase, fileId, whenIso) {
  const run = readRunForTalk(root, slug, id)
  const attachment = { ...run.work[phase], pinned: { fileId, title: fileId, revision: 1, sha256: 'a'.repeat(64), copy: `${slug}/runs/${id}.${phase}.md`, pinnedAt: whenIso }, publishedAt: whenIso }
  persistRunForTalk(root, slug, id, { ...run, work: { ...run.work, [phase]: attachment } })
}

const { root, talks } = vault()
try {
  write(root, 'research-teams-intake.md', RTI)
  write(root, 'session-feedback.md', SFB)
  write(root, 'journal-club-prompts.md', JCP)
  const at = { opens: '2026-10-20T09:00', closes: '2026-11-01T09:00' }
  const post = { opens: 'session-end', closes: '2026-11-09T17:00' }
  plan(root, 'ai-for-research-teams', 'AI for research teams', 'Saïd workshop', { pre: { fileId: 'research-teams-intake', ...at } }, 'said')
  plan(root, 'ai-for-research-teams', 'AI for research teams', 'Keble', { pre: { fileId: 'research-teams-intake', ...at } }, 'keble')
  plan(root, 'gen-ai-in-teaching', 'Generative AI in teaching', 'ITLC lunchtime', { pre: { fileId: 'research-teams-intake', ...at } }, 'itlc')
  plan(root, 'ai-for-research-teams', 'AI for research teams', 'Medical Sciences', { pre: { fileId: 'research-teams-intake', ...at }, post: { fileId: 'session-feedback', ...post } }, 'med')
  send(root, 'ai-for-research-teams', 'said', 'pre', 'research-teams-intake', '2026-10-14T09:00:00.000Z')
  send(root, 'ai-for-research-teams', 'keble', 'pre', 'research-teams-intake', '2026-10-12T09:00:00.000Z')
  send(root, 'gen-ai-in-teaching', 'itlc', 'pre', 'research-teams-intake', '2026-10-01T09:00:00.000Z')
  const sentCheck = readRunForTalk(root, 'ai-for-research-teams', 'said')
  assert.equal(sentCheck.work.pre.pinned?.pinnedAt, '2026-10-14T09:00:00.000Z', 'fixture: the Run record keeps the pin')
  plan(root, 'ai-for-research-teams', 'AI for research teams', 'Saïd follow-up', { post: { fileId: 'session-feedback', ...post } }, 'said2')
  send(root, 'ai-for-research-teams', 'said2', 'post', 'session-feedback', '2026-10-14T10:00:00.000Z')

  const listing = listWorkFiles(root, talks)
  const [rti, sfb, jcp] = listing.items
  // 1. the list
  assert.deepEqual(listing.items.map((i) => i.title), ['Research teams intake', 'Session feedback', 'Journal club prompts'])
  assert.deepEqual(listing.items.map((i) => [i.preTalks, i.postTalks]), [[2, 0], [0, 1], [1, 1]])
  assert.deepEqual(listing.items.map(usedLine), [
    'Used as pre-work in 2 talks · as post-work in 0', 'Used as pre-work in 0 talks · as post-work in 1', 'Used as pre-work in 1 talk · as post-work in 1',
  ])
  assert.deepEqual(listing.items.map(runCountText), ['4 runs', '2 runs', '0 runs'])
  assert.deepEqual(listing.items.map((i) => [i.fileName, i.steps.length]), [['research-teams-intake.md', 4], ['session-feedback.md', 3], ['journal-club-prompts.md', 3]])
  assert.equal(rti.relPath, 'Work files/research-teams-intake.md')
  assert.equal(rti.absPath, join(root, 'Work files', 'research-teams-intake.md'))
  assert.equal(listing.folder, join(root, 'Work files'))
  assert.equal(listing.items.every((i) => i.findings.length === 0), true, JSON.stringify(listing.items.map((i) => i.findings)))

  // 2. steps
  assert.deepEqual(rti.steps.map((s) => [s.n, s.id, s.kind, s.thumb]), [[1, 'watch', 'video', 'video'], [2, 'check', 'check', 'icon'], [3, 'try-a-prompt', 'task', 'slide'], [4, 'what-you-want', 'question', 'icon']])
  assert.equal(rti.steps[0].kindLabel, 'Video')
  assert.equal(rti.steps[1].kindLabel, 'Quick check · 3 options')
  assert.equal(rti.steps[2].kindLabel, 'Task · slide, numbered steps')
  assert.equal(rti.steps[3].kindLabel, 'Open question')
  // Where each answer goes (2026-10-19 prework-responses design): a video counts only; every other step is Sent to you by default.
  assert.deepEqual(rti.steps.map((s) => s.route), ['counts', 'sent', 'sent', 'sent'])
  assert.deepEqual(rti.steps[2].source, ['### Try one prompt on a paper of your own', '{id=try-a-prompt}{task}', '1. Pick a paper'], 'the Edit panel previews the step\'s own source')
  assert.deepEqual(sfb.steps.map((s) => [s.kindLabel, s.icon]), [['Rating · 1 to 5', 'gauge'], ['Open question', 'message-circle-question'], ['Open question', 'message-circle-question']])

  // 3. used by
  assert.deepEqual(rti.usedTalks.map((t) => [t.slug, t.role]), [['ai-for-research-teams', 'pre'], ['gen-ai-in-teaching', 'pre']])
  assert.equal(usedByCounts(rti), '2 talks · 4 runs')
  assert.deepEqual(rti.runs.filter((r) => r.sentAt === null).map((r) => r.name), ['Medical Sciences'])
  assert.deepEqual(rti.runs.filter((r) => r.sentAt !== null).map((r) => [r.name, r.phase, r.sentAt.slice(0, 10)]).sort(), [['ITLC lunchtime', 'pre', '2026-10-01'], ['Keble', 'pre', '2026-10-12'], ['Saïd workshop', 'pre', '2026-10-14']])
  assert.deepEqual(sfb.usedTalks.map((t) => [t.title, t.role]), [['AI for research teams', 'post']])
  assert.equal(usedByCounts(sfb), '1 talk · 2 runs')
  assert.deepEqual(sfb.runs.map((r) => [r.name, r.phase, r.sentAt === null]).sort(), [['Medical Sciences', 'post', true], ['Saïd follow-up', 'post', false]])
  assert.deepEqual(jcp.usedTalks.map((t) => [t.slug, t.role]), [['journal-club', 'pre'], ['journal-club', 'post']], 'a file name and an id both name the file; one talk may use it in both roles')
  assert.equal(usedByCounts(jcp), '1 talk · 0 runs')

  // 2b / 4. findings; a bad id is still listed and found by its file name
  write(root, 'broken-one.md', BROKEN)
  const withBroken = listWorkFiles(root, [...talks, { ...talks[3], slug: 'x', outlinePath: talks[3].outlinePath }])
  const broken = withBroken.items.find((i) => i.fileName === 'broken-one.md')
  assert.ok(broken, 'listed')
  assert.equal(broken.title, 'Broken one')
  assert.ok(broken.findings.length >= 2 && broken.blocking >= 2, JSON.stringify(broken.findings))
  assert.ok(broken.findings.some((f) => /id/i.test(f.message)), 'names the missing id')
  assert.ok(broken.findings.some((f) => /layout/i.test(f.message) && f.message.includes('table')), 'names the layout: ' + JSON.stringify(broken.findings.map((f) => f.message)))
  assert.ok(broken.findings.every((f) => /\.$/.test(f.message)))
  writeFileSync(talks[3].outlinePath, outline('A talk with none', ['postwork: broken-one']))
  const byName = listWorkFiles(root, talks).items.find((i) => i.fileName === 'broken-one.md')
  assert.deepEqual(byName.usedTalks.map((t) => [t.slug, t.role]), [['plain-talk', 'post']])
  rmSync(join(root, 'Work files', 'broken-one.md'))

  // 5. skipped entries
  mkdirSync(join(root, 'Work files', 'sub.md'))
  writeFileSync(join(root, 'Work files', 'notes.txt'), RTI)
  writeFileSync(join(root, 'Work files', 'huge.md'), 'x'.repeat(MAX_WORK_FILE_BYTES + 1))
  writeFileSync(join(root, 'Work files', '.hidden.md'), RTI)
  symlinkSync(join(root, 'Work files', 'session-feedback.md'), join(root, 'Work files', 'link.md'))
  assert.equal(listWorkFiles(root, talks).items.length, 3, 'only plain .md files directly inside the folder')
} finally { rmSync(root, { recursive: true, force: true }) }

// 5b. empty and missing
{
  const empty = mkdtempSync(join(tmpdir(), 'tw-work-files-empty-'))
  try {
    assert.deepEqual(listWorkFiles(empty, []).items, [])
    mkdirSync(join(empty, 'Work files'))
    assert.deepEqual(listWorkFiles(empty, []).items, [])
  } finally { rmSync(empty, { recursive: true, force: true }) }
}

// Review fixes. Used-by matching: Runs by id only; talks by id, or file name only for a file with no id nobody else claims.
{
  const f = (fileName, id, extra = '') => ({ fileName, text: ['---', ...(id ? [`id: ${id}`] : []), 'title: T', 'revision: 1', '---', '', '### A', '{id=a}{poll=open}', extra].join('\n') })
  const talk = { slug: 't', title: 'T', outlinePath: '/x', prework: 'intake' }
  const sent = { id: 'r1', talkSlug: 't', work: { pre: { fileId: 'intake', pinned: { pinnedAt: '2026-10-01T09:00:00.000Z' } } } }
  const items = buildWorkFileItems([f('intake.md', 'intake-v2'), f('old.md', 'intake')], [talk], [sent])
  const by = (n) => items.find((i) => i.fileName === n)
  assert.equal(by('intake.md').runCount + by('intake.md').usedTalks.length, 0, 'a stem equal to another file id does not claim')
  assert.equal(by('old.md').runCount, 1)
  assert.deepEqual(by('old.md').usedTalks.map((t) => t.slug), ['t'])
  // Plain titles (issue 234): a talk title's inline Markdown is dropped wherever it is shown as text.
  const bold = buildWorkFileItems([f('old.md', 'intake')], [{ ...talk, title: '**Gen AI** in teaching' }], [])[0]
  assert.equal(bold.usedTalks[0].title, 'Gen AI in teaching', 'Used by shows the title without **')
  assert.equal(talkTitleText('**Gen AI** in teaching'), 'Gen AI in teaching')
  assert.equal(editWindowTitle('**Gen AI** in teaching'), 'TalkWeaver Edit \u2014 Gen AI in teaching', 'the window title has no **')
  assert.equal(editWindowTitle(undefined), 'TalkWeaver')
  assert.equal(displayName({ slug: 's', title: '**Bold** talk' }, 'title'), 'Bold talk', 'the Talks list label has no **')
  assert.equal(displayName({ slug: 's', title: '**Bold** talk' }, 'file'), 's')
  // Two files sharing an id: a finding on both, no claims.
  const dup = buildWorkFileItems([f('a.md', 'intake'), f('b.md', 'intake')], [talk], [sent])
  for (const i of dup) {
    assert.equal(i.runCount + i.usedTalks.length, 0)
    const finding = i.findings.find((x) => x.code === 'work-file-id-shared')
    assert.ok(finding && /Another work file has the same id \(.+\.md\)\. Give each file its own id\./.test(finding.message), JSON.stringify(i.findings))
  }
  // A file with no id is named by its file name from a talk, never by a Run.
  const noId = buildWorkFileItems([f('intake.md', '')], [talk], [sent])[0]
  assert.deepEqual([noId.usedTalks.length, noId.runCount], [1, 0])
  assert.match(noId.findings.find((x) => x.code === 'work-file-id-missing').message, /Talks can still name it by its file name; Runs cannot use it until it has one\./)
  // The reserved legacy id collects no Runs.
  const legacy = buildWorkFileItems([f('legacy-section.md', 'legacy-section')], [], [{ id: 'r2', talkSlug: 't', work: { pre: { fileId: 'legacy-section' } } }])[0]
  assert.equal(legacy.runCount, 0)
  // Sent means pinned: a published attachment without a pin is not sent.
  const pubOnly = buildWorkFileItems([f('intake.md', 'intake')], [], [{ id: 'r3', talkSlug: 't', work: { pre: { fileId: 'intake', publishedAt: '2026-10-01T09:00:00.000Z' } } }])[0]
  assert.equal(pubOnly.runs[0].sentAt, null)
  // Minutes on a non-task step reads as that, not as {readonly}.
  const mins = buildWorkFileItems([{ fileName: 'm.md', text: ['---', 'id: m', 'title: M', 'revision: 1', '---', '', '### Step', '{id=s}{minutes=5}', ''].join('\n') }], [], [])[0]
  const mf = mins.findings.find((x) => /minutes/i.test(x.message))
  assert.ok(mf, JSON.stringify(mins.findings))
  assert.equal(mf.message, 'Only a task can have minutes, step Step.')
}

// A `Work files/` folder that is a link out of the vault lists nothing; only the first 64 KB of an outline is read.
{
  const base = mkdtempSync(join(tmpdir(), 'tw-work-files-link-'))
  try {
    const outside = join(base, 'outside'); mkdirSync(outside)
    writeFileSync(join(outside, 'x.md'), RTI)
    const vaultDir = join(base, 'vault'); mkdirSync(vaultDir)
    symlinkSync(outside, join(vaultDir, 'Work files'))
    assert.deepEqual(listWorkFiles(vaultDir, []).items, [])
    const outlinePath = join(vaultDir, 'big.md')
    const head = ['---', 'title: Head', 'prework: research-teams-intake', '---', 'x'.repeat(200 * 1024)].join('\n')
    writeFileSync(outlinePath, head)
    rmSync(join(vaultDir, 'Work files'))
    mkdirSync(join(vaultDir, 'Work files')); writeFileSync(join(vaultDir, 'Work files', 'research-teams-intake.md'), RTI)
    const r = listWorkFiles(vaultDir, [{ slug: 'big', title: 'Big', outlinePath }])
    assert.deepEqual(r.items[0].usedTalks.map((t) => t.slug), ['big'], 'front matter in the head is still read from a huge outline')
  } finally { rmSync(base, { recursive: true, force: true }) }
}

// The front-matter reader: values, quotes, comments, `.md`, absent keys. The old boolean trigger is read as
// written; it names a file only when one has that id (ticket 08 review S7, below).
assert.deepEqual(readTalkWorkNames('---\ntitle: T\nprework: a-file\npostwork: "b-file.md"  # note\n---\nbody\nprework: not-this'), { prework: 'a-file', postwork: 'b-file' })
assert.deepEqual(readTalkWorkNames('---\nprework: true\n---\n'), { prework: 'true' })
assert.deepEqual(readTalkWorkNames('--- \nprework: wf-x # note\n---\n'), { prework: 'wf-x' }, 'the same block rule as the writer')
// `prework: true` names no file, unless a file's id is `true` (written `id: "true"` in the work file); an id two files share names neither (the strips read it the same way).
{
  const f = (fileName, id) => ({ fileName, text: ['---', ...(id ? [`id: ${id}`] : []), `title: ${fileName}`, 'revision: 1', '---', '', '### S', '{id=s}', 'x', ''].join('\n') })
  const legacy = [{ slug: 'old', title: 'Old', outlinePath: '/v/old.md', prework: 'true' }]
  assert.deepEqual(buildWorkFileItems([f('a.md', 'a')], legacy, []).flatMap((i) => i.usedTalks), [], 'the 0.39 switch names no file')
  assert.deepEqual(buildWorkFileItems([f('t.md', '"true"')], legacy, []).flatMap((i) => i.usedTalks.map((t) => t.slug)), ['old'], 'a file whose id is true is named by it')
  const shared = buildWorkFileItems([f('one.md', 'dup'), f('two.md', 'dup')], [{ slug: 's', title: 'S', outlinePath: '/v/s.md', prework: 'dup' }], [])
  assert.deepEqual(shared.flatMap((i) => i.usedTalks), [], 'a shared id names no file')
}
assert.deepEqual(readTalkWorkNames('no front matter\nprework: x'), {})
assert.deepEqual(readTalkWorkNames('﻿---\r\nprework: x\r\n---\r\n'), { prework: 'x' })

// The list handler's gate: no vault answers null; a vault answers the listing.
{
  const gated = mkdtempSync(join(tmpdir(), 'tw-work-files-gate-'))
  try {
    write(gated, 'research-teams-intake.md', RTI)
    assert.equal(listWorkFilesFor(null, talks), null, 'no vault answers null')
    const on = listWorkFilesFor(gated, talks)
    assert.deepEqual(on.items.map((i) => i.fileName), ['research-teams-intake.md'], 'a vault answers the listing')
    assert.equal(on.folder, join(gated, 'Work files'))
  } finally { rmSync(gated, { recursive: true, force: true }) }
}

// 6. "Open file" stays in TalkWeaver: no control hands a talk outline or a work file to the operating system
//    (which opens .md in whatever app owns it), and the Run page's Open file lands on the Work files view.
{
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  assert.ok(!/openPath/.test(read('src/renderer/src/components/WorkFilesView.tsx')), 'the Work files view never calls shell.openPath')
  assert.ok(!/data-wf-open-file|<span>Open file<\/span>/.test(read('src/renderer/src/components/WorkFilesView.tsx')), 'the file is already shown in the view: no button to open it elsewhere')
  const actions = read('src/renderer/src/components/talklist/actions.ts')
  assert.ok(!/openPath/.test(actions), 'the talk list never calls shell.openPath')
  assert.match(actions, /action === 'open-file'\) \{ onSelectTalk\(talk\)/, 'Open outline file opens the talk in the editor')
  const sessions = read('src/renderer/src/components/SessionsView.tsx')
  assert.match(sessions, /openWorkFile\(ref, effect\.phase\)[\s\S]{0,120}onShowWorkFile\(result\.fileName, result\.vaultId\)/, 'the Run page shows the file in the Work files view')
  assert.match(read('src/renderer/src/App.tsx'), /<WorkFilesView request=\{workFileRequest\}/, 'the Tools window passes the request to the Work files view')
  assert.match(read('src/renderer/src/components/WorkFilesView.tsx'), /if \(request\) \{ setSelected\(workFileKey\(request\.vaultId, request\.fileName\)\)/, 'the Work files view selects the file asked for')
}

// 6b. New work file always passes the listing's destination vault id, even when only one vault is open
//     (a primary vault that is unavailable leaves one listed vault, which must still receive the save).
{
  const view = readFileSync(new URL('../src/renderer/src/components/WorkFilesView.tsx', import.meta.url), 'utf8')
  assert.match(view, /workFiles\.create\(\{ title, presetId, adds, vaultId: vault\?\.id \}\)/, 'the create call always passes the vault id (no conditional spread)')
  assert.doesNotMatch(view, /newFileVault = several/, 'the destination vault is not gated on several vaults being open')
  assert.match(view, /const newFileVault = listing\?\.vaults\?\.find\(\(v\) => v\.id === listing\.newFileVaultId\)/, 'the destination vault comes from the listing')
  assert.match(view, /vault=\{newFileVault\}\s*\n\s*showVault=\{several\}/, 'the vault name is shown only when several vaults are open')
}

// 7. Several open vaults: the listing covers every one (tagged with its vault), a write lands in the vault named and
//    leaves the others untouched, and a named vault that is not there is refused, not re-targeted to the first.
{
  const a = mkdtempSync(join(tmpdir(), 'tw-wf-a-'))
  const b = mkdtempSync(join(tmpdir(), 'tw-wf-b-'))
  try {
    write(a, 'research-teams-intake.md', RTI)
    write(b, 'journal-club-prompts.md', JCP)
    write(b, 'session-feedback.md', SFB)
    const vaults = [{ id: 'va', name: 'Main', root: a }, { id: 'vb', name: 'Demo and test', root: b }]
    const all = listWorkFilesAcross(vaults, () => [], 'vb')
    assert.deepEqual(all.items.map((i) => `${i.vaultId}:${i.fileName}`), ['va:research-teams-intake.md', 'vb:journal-club-prompts.md', 'vb:session-feedback.md'], 'every open vault is listed')
    assert.deepEqual(all.vaults, [{ id: 'va', name: 'Main' }, { id: 'vb', name: 'Demo and test' }])
    assert.equal(all.newFileVaultId, 'vb', 'New work file goes to the vault asked for')
    assert.equal(listWorkFilesAcross(vaults, () => [], 'gone').newFileVaultId, 'va', 'an unknown vault falls back to the first (the current vault)')
    assert.equal(listWorkFilesAcross([], () => []), null)
    assert.notEqual(workFileKey('va', 'x.md'), workFileKey('vb', 'x.md'), 'the same file name in two vaults is two files')
    // "Open file" for a second-vault file: its key finds exactly that item.
    const wanted = all.items.find((i) => workFileKey(i.vaultId, i.fileName) === workFileKey('vb', 'session-feedback.md'))
    assert.equal(wanted.absPath, join(b, 'Work files', 'session-feedback.md'))

    // Writes: the one root rule (named vault only), then the writers.
    const rootOf = (id) => (id === undefined ? a : ({ va: a, vb: b })[id])
    assert.equal(workFileWriteRoot('vb', rootOf), b)
    assert.equal(workFileWriteRoot(undefined, rootOf), a, 'no vault named: the current vault')
    assert.equal(workFileWriteRoot('nope', rootOf), undefined, 'an unknown vault is refused, never the first vault')
    assert.equal(workFileWriteRoot(7, rootOf), undefined)
    const before = readFileSync(join(a, 'Work files', 'research-teams-intake.md'), 'utf8')
    const sfBefore = readFileSync(join(b, 'Work files', 'session-feedback.md'), 'utf8')
    const edited = addWorkFileStep(workFileWriteRoot('vb', rootOf), 'session-feedback.md', { kind: 'check' })
    assert.equal(edited.ok, true)
    assert.notEqual(readFileSync(join(b, 'Work files', 'session-feedback.md'), 'utf8'), sfBefore, 'the second vault file changed')
    assert.equal(readFileSync(join(a, 'Work files', 'research-teams-intake.md'), 'utf8'), before, 'the first vault is untouched')
    assert.equal(existsSync(join(a, 'Work files', 'session-feedback.md')), false, 'no copy appears in the first vault')
    const made = createWorkFile(workFileWriteRoot('vb', rootOf), { title: 'Made in the second' })
    assert.equal(made.ok, true)
    assert.equal(existsSync(join(b, 'Work files', made.fileName)), true)
    assert.equal(existsSync(join(a, 'Work files', made.fileName)), false, 'a new file lands in the named vault only')
    // The view and the IPC carry the vault.
    const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    assert.match(read('src/renderer/src/components/WorkFilesView.tsx'), /addStep\(item\.fileName, add, item\.vaultId\)/)
    assert.match(read('src/main/index.ts'), /workFileWriteRoot\(i\.vaultId, writableRootOfVault\)/)
    // Where a step's answer goes follows the same rule: a file of the same name in the current vault is left alone,
    // and a vault that is not open is refused.
    write(a, 'session-feedback.md', SFB)
    const sfB = readFileSync(join(b, 'Work files', 'session-feedback.md'), 'utf8')
    const routed = setWorkFileStepLocal(workFileWriteRoot('vb', rootOf), 'session-feedback.md', 'will-try', true)
    assert.equal(routed.ok, true)
    assert.match(readFileSync(join(b, 'Work files', 'session-feedback.md'), 'utf8'), /\{id=will-try\}\{poll=open\}\{local\}/, 'the named vault file gets {local}')
    assert.notEqual(readFileSync(join(b, 'Work files', 'session-feedback.md'), 'utf8'), sfB)
    assert.equal(readFileSync(join(a, 'Work files', 'session-feedback.md'), 'utf8'), SFB, 'the current vault file of the same name is untouched')
    assert.equal(workFileWriteRoot('nope', rootOf), undefined, 'set-step-local in a vault that is not open has no root')
    const main = read('src/main/index.ts')
    const handler = main.slice(main.indexOf("ipcMain.handle('work-files:set-step-local'"), main.indexOf("ipcMain.handle('work-files:move-prework'"))
    assert.match(handler, /workFileWriteRoot\(i\.vaultId, writableRootOfVault\)/, 'set-step-local resolves the vault like add-step')
    assert.match(handler, /i\.vaultId \? 'That vault is not open\.' : 'No vault is open\.'/, 'and refuses a vault that is not open in the same words')
    assert.doesNotMatch(handler, /writableVaultRoot\(\)/, 'never the first vault')
    assert.match(read('src/preload/index.ts'), /setStepLocal: \(fileName: string, stepId: string, local: boolean, vaultId\?: string\)[^\n]*\{ fileName, stepId, local, vaultId \}/)
    assert.match(read('src/renderer/src/components/WorkFilesView.tsx'), /setStepLocal\(item\.fileName, stepId, local, item\.vaultId\)/)
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }) }
}

// 8. Where an answer goes: {local} reads as Local only in the steps list; on a video it is a finding, and the video still counts only.
{
  const local = RTI.replace('{id=try-a-prompt}{task}', '{id=try-a-prompt}{task}{local}').replace('{id=watch}{video}', '{id=watch}{video}{local}')
  const [item] = buildWorkFileItems([{ fileName: 'research-teams-intake.md', text: local }], [], [])
  assert.deepEqual(item.steps.map((s) => s.route), ['counts', 'sent', 'local', 'sent'])
  assert.ok(item.findings.some((f) => f.code === 'prework-local-on-slide' && f.severity === 'warning'), '{local} on a video is a warning, not a blocker')
  const view = readFileSync(new URL('../src/renderer/src/components/WorkFilesView.tsx', import.meta.url), 'utf8')
  assert.match(view, /window\.tw\.workFiles\.setStepLocal\(/, 'the Edit panel writes through the work-file write path')
  assert.match(view, /data-wf-route=/, 'each step row carries its route tag')
}

console.log('PASS  work files listing, steps, findings and used-by')
