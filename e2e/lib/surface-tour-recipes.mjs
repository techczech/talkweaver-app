// What each surface of the tour needs, beyond "send its command": see e2e/diagnose-surface-tour.mjs.
//
// seedWorld() writes extra material into the THROWAWAY vault copy and user-data folder (never the owner's): a rich
// delivered Run with recording, questions, reactions, polls and a board; a planned Run; a Run with pre-work answers
// and a published page; a conflict copy; scratch material. A recipe is { cmd } (a registry command), { run(t) } (the
// clicks), { skip } (never opened, with the reason), plus optional { verify(t, ctx) } and { observe: /regex/ }.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DAY = 86_400_000
const pad = (n) => String(n).padStart(2, '0')
const dayOf = (n) => { const d = new Date(Date.now() + n * DAY); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

export function seedWorld({ vault, userData }) {
  const ledger = (slug) => { const dir = join(vault, '_PRESENTATIONS', slug); mkdirSync(dir, { recursive: true }); return dir }
  const write = (dir, run) => writeFileSync(join(dir, `${run.id}.json`), JSON.stringify(run, null, 2))
  const outline = readFileSync(join(vault, 'layout-showcase', 'layout-showcase-outline.md'), 'utf8')
  const ids = [...outline.matchAll(/\{id=([a-z0-9-]+)\}/g)].map((m) => m[1])
  const [s1, s2, s3, s4, s5, s6] = ids
  const started = new Date(Date.now() - 2 * DAY); started.setHours(14, 0, 0, 0)
  const t = (m) => started.getTime() + m * 60_000
  const min = (m, s = 0) => (m * 60 + s) * 1000
  const base = { talkSlug: 'layout-showcase', talkTitle: 'TalkWeaver Layout Showcase', kind: 'delivery', slideSet: { kind: 'full' }, pathwayId: null, transcript: null }
  const dir = ledger('layout-showcase')
  let seq = 0
  const tap = (reaction, slideId, tMs) => ({ id: `sess:r${++seq}`, reaction, slideId, tMs })
  const cards = [
    ['c1', 'keep', 'More time for hands-on', 1, 1], ['c2', 'keep', 'Hands-on, please', 1, 2], ['c3', 'keep', 'The live demo', null, 3],
    ['c4', 'change', 'Shorter breaks', 2, 4], ['c5', 'change', 'Shorter breaks please', 2, 5], ['c6', 'change', 'Does anyone know the wifi password?', null, 6, true],
    ['c7', 'try', 'Try pair work', null, 7]
  ]
  write(dir, {
    ...base, id: 'run-rich', status: 'delivered', eventTitle: 'Digital Education Day', audience: 'Staff development', context: 'Morning keynote',
    startedAt: started.toISOString(), endedAt: new Date(t(62)).toISOString(), recordingMs: 62 * 60_000, wallClockMs: 62 * 60_000 + 800, timerTargetMin: 60,
    audio: { r2Key: 'presentations/layout-showcase/run-rich/audio.webm', bytes: 12, uploaded: false },
    slideTimeIndex: [{ event: 'enter', slideId: s1, tMs: 0 }, { event: 'enter', slideId: s2, tMs: min(5) }, { event: 'enter', slideId: s3, tMs: min(12) }],
    instantSlides: [{ id: 'link-1', kind: 'link', shownAt: t(12), afterSlideId: s3, url: 'https://example.org/reading' }, { id: 'text-1', kind: 'text', shownAt: t(20), afterSlideId: s2, text: 'Try it now: ask the person next to you.' }],
    questions: [
      { id: 'sess:question-1', text: 'Is the plan step something I can see and correct before it acts?', slideId: s2, tMs: min(9), answered: true },
      { id: 'sess:question-2', text: 'Where would you put Copilot in these three stages?', name: 'Tom', slideId: s3, tMs: min(26), answered: false }
    ],
    reactions: [tap('puzzled', s2, min(8)), tap('puzzled', s2, min(8, 5)), tap('helped', s2, min(8, 20)), tap('bookmark', s2, min(9)), tap('custom:Too fast', s3, min(11)), tap('custom:Just right', s3, min(11, 2))],
    polls: [
      { id: 'poll-rating', slideId: s2, type: 'rating', question: 'How confident are you with AI at work?', visibility: 'live', options: [{ optionId: 'w', label: 'Writing and editing' }, { optionId: 'f', label: 'Finding sources' }], labels: [{ optionId: 'n', label: 'Not yet' }, { optionId: 'a', label: 'A little' }, { optionId: 'v', label: 'Very' }] },
      { id: 'poll-board', slideId: s3, type: 'board', question: 'What should we keep, change, try?', visibility: 'live', options: [{ optionId: 'keep', label: 'Keep' }, { optionId: 'change', label: 'Change' }, { optionId: 'try', label: 'Try' }] }
    ],
    pollResponses: [{ responseId: 's:1', pollId: 'poll-rating', choice: { w: 'a', f: 'n' }, tMs: 1000, slideId: s2 }, { responseId: 's:2', pollId: 'poll-rating', choice: { w: 'v', f: 'a' }, tMs: 2000, slideId: s2 }],
    boards: [{
      id: 'poll-board', slideId: s3, question: 'What should we keep, change, try?', sessionId: 'session-rich', liveEndedAt: t(62),
      columns: [{ id: 'keep', label: 'Keep' }, { id: 'change', label: 'Change' }, { id: 'try', label: 'Try' }],
      cards: cards.map(([id, column, text, group, m, hidden]) => ({ id, column, text, acceptedAt: t(40 + m), ...(group ? { group } : {}), ...(hidden ? { hidden: true } : {}) })),
      groups: [{ n: 1, column: 'keep', cardIds: ['c1', 'c2'] }, { n: 2, column: 'change', cardIds: ['c4', 'c5'] }]
    }]
  })
  const recordings = join(userData, 'recordings'); mkdirSync(recordings, { recursive: true })
  writeFileSync(join(recordings, 'run-rich.webm'), 'mock-webm-data')
  // A rehearsal with a recording, and a delivery logged without one.
  write(dir, { ...base, id: 'run-rehearsal', kind: 'rehearsal', status: 'delivered', context: 'Workshop rehearsal', startedAt: new Date(t(-1440)).toISOString(), endedAt: new Date(t(-1440 + 27)).toISOString(), recordingMs: 27 * 60_000, wallClockMs: 27 * 60_000 + 800, timerTargetMin: 30, audio: { r2Key: 'presentations/layout-showcase/run-rehearsal/audio.webm', bytes: 12, uploaded: false }, slideTimeIndex: [{ event: 'enter', slideId: s1, tMs: 0 }] })
  writeFileSync(join(recordings, 'run-rehearsal.webm'), 'mock-webm-data')
  write(dir, { ...base, id: 'run-logged', status: 'delivered', eventTitle: 'Seminar', startedAt: new Date(t(-4320)).toISOString(), endedAt: new Date(t(-4320 + 40)).toISOString(), recordingMs: 0, wallClockMs: 40 * 60_000, timerTargetMin: 45, audio: null, slideTimeIndex: [] })
  // A planned Run of the main talk (its status chip, History's Planned group, the plan sheets).
  write(dir, { ...base, id: 'run-planned', status: 'planned', plannedDate: dayOf(6), startTime: '14:00', eventTitle: 'Open day workshop', audience: 'Prospective students', expectedPeople: 24, timeZone: ZONE, startedAt: '', endedAt: '', recordingMs: 0, wallClockMs: 0, timerTargetMin: 0, context: null, audio: null, slideTimeIndex: [] })

  // The pre-work talk: a planned Run with answers, published pages and a work file in use.
  const pdir = ledger('pre-work-workshop')
  const person = (n) => n.toString(16).padStart(16, '0')
  const entry = (n, kind, stepId, extra = {}) => ({ id: `${person(n)}:${kind}:${stepId}`, participant: person(n), stepId, kind, at: Date.now() - DAY + n * 3_600_000, ...extra })
  const entries = []
  for (let n = 1; n <= 6; n += 1) entries.push(entry(n, 'read', 'pwwelcome'))
  ;['-option-2', '-option-2', '-option-2', '-option-1', '-option-4'].forEach((s, i) => entries.push(entry(i + 1, 'answer', 'pwquiz', { choice: `poll-pwquiz${s}` })))
  ;['Use an agent on my own files safely', 'Which tool the university supports', 'Save time on admin email'].forEach((text, i) => entries.push(entry(i + 1, 'answer', 'pwhope', { text })))
  for (let n = 1; n <= 3; n += 1) entries.push(entry(n, 'done', 'pwtask', { done: true }))
  entries.push({ ...entry(2, 'question', 'pwtask', { text: 'Can I use it for an email that mentions a student by name?', name: 'Sam' }), id: `${person(2)}:q:a` })
  const PUB = new Date(Date.now() - DAY).toISOString()
  const SITE_URL = 'https://handouts.example'
  write(pdir, {
    id: 'run-said', talkSlug: 'pre-work-workshop', talkTitle: 'TalkWeaver **Pre-work Workshop**', kind: 'delivery', status: 'planned', plannedDate: dayOf(7), startTime: '10:00',
    eventTitle: 'Saïd workshop', audience: 'Research teams', expectedPeople: 18, timeZone: ZONE, slideSet: { kind: 'full' }, startedAt: '', endedAt: '', recordingMs: 0, wallClockMs: 0, timerTargetMin: 0,
    context: null, pathwayId: null, audio: null, transcript: null, slideTimeIndex: [], handoutUrl: `${SITE_URL}/pre-work-said/`, handoutFolder: 'pre-work-said',
    work: { pre: { fileId: 'pre-work-workshop-intake', opens: `${dayOf(-1)}T09:00`, closes: `${dayOf(7)}T09:00`, timeZone: ZONE, publishedAt: PUB }, post: { fileId: 'pre-work-workshop-after', opens: 'session-end', closes: `${dayOf(21)}T17:00`, timeZone: ZONE, publishedAt: PUB } },
    prework: { entries, people: 6, lastActivityAt: Date.now() - DAY }
  })
  const siteDir = join(userData, 'cloudflare-pages-site')
  const site = { 'pre-work-said/index.html': '<!doctype html><title>Saïd</title>', 'pre-work-said/pre-work/index.html': 'pre-work page', 'pre-work-said/post-work/index.html': 'post-work page' }
  for (const [file, text] of Object.entries(site)) { mkdirSync(join(siteDir, file, '..'), { recursive: true }); writeFileSync(join(siteDir, file), text) }

  // A conflict copy beside another talk's outline.
  const play = join(vault, 'play-on-next', 'play-on-next-outline.md')
  const text = readFileSync(play, 'utf8')
  writeFileSync(join(vault, 'play-on-next', "play-on-next-outline (Anna's conflicted copy 2026-09-30).md"), text.replace(/\n### /, '\n### An extra slide from the copy\n\nOnly in the other version.\n\n### '))
  // Scratch material for the Slide Scratchpad: an agent's picture and an HTML page in the talk's scratch folder.
  const scratch = join(vault, 'layout-showcase', 'scratchpad'); mkdirSync(scratch, { recursive: true })
  writeFileSync(join(scratch, 'agent-sketch.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="#e8efe9"/><circle cx="160" cy="90" r="50" fill="#3d7a5a"/></svg>')
  writeFileSync(join(scratch, 'agent-widget.html'), '<!doctype html><title>Widget</title><body style="font:20px sans-serif;padding:20px">An agent-made HTML page.</body>')
  // Research for the Research panel.
  const research = join(vault, 'layout-showcase', 'research'); mkdirSync(research, { recursive: true })
  const stamp = new Date(Date.now() - DAY).toISOString()
  writeFileSync(join(research, 'layout-evidence.md'), `---\ntitle: Layout evidence\nkind: evidence\ncreated: ${stamp}\nby: Tour agent\nsources:\n  - https://example.org/article\n---\n\nSlides with one claim and one picture are remembered best.\n`)
  writeFileSync(join(research, 'adoption-table.md'), `---\ntitle: Adoption table\nkind: table\ncreated: ${stamp}\nby: Tour agent\n---\n\n| Tool | Share |\n|---|---|\n| Chat | 62% |\n| Agents | 18% |\n`)
  writeFileSync(join(research, 'sketch-widget.md'), `---\ntitle: Sketch widget\nkind: widget\ncreated: ${stamp}\nby: Tour agent\nartefact: sketch-widget.html\n---\n\nA small widget.\n`)
  writeFileSync(join(research, 'sketch-widget.html'), '<!doctype html><title>Widget</title><p style="font:18px sans-serif">Widget</p>')
  return { slides: { s1, s2, s3, s4, s5, s6 } }
}

// ---- recipes -------------------------------------------------------------------------------------------------------
const R = {}
export const TOUR_RECIPES = R

const SKIP_PUBLISH = 'would publish or contact a network service'

// ---- helpers shared by recipes -----------------------------------------------------------------------------------
const talkRow = (t, title = 'Embedded Page') => t.page.locator(`aside.talk-list [data-talk-title*="${title}"]`).first()
const bar = (name) => (t) => t.click(t.page.locator('.toolbar-btn', { hasText: name }))
/** Caret onto the editor line that contains `text` (places the slide selection there). */
async function gotoLine(t, text, opts = {}) {
  const line = t.page.locator('.cm-line', { hasText: text }).filter({ visible: true }).nth(opts.nth ?? 0)
  await line.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {})
  await line.click({ position: { x: 50, y: 6 }, timeout: 3500 })
  await t.page.waitForTimeout(350)
}
/** A talk other than the base one, opened from the Talks list. */
async function otherTalk(t, title) { await t.openTalk(title) }
/** The Tools window at a view, reached by commands: Studio first (it makes the window), then the view's own command. */
async function toolsAt(t, kind) {
  const tools = await t.openTools()
  // History and Sessions are the one Runs view (R5): both names land there; 'history' also chooses the Past filter.
  const cmd = { runs: 'tools-view-runs', sessions: 'tools-view-runs', history: 'tools-view-runs', published: 'tools-view-published', workfiles: 'tools-view-workfiles' }[kind]
  if (cmd) await t.command(cmd, tools)
  else if (kind === 'importer') { await t.command('importer') }
  if (kind === 'history') { await tools.waitForTimeout(600); await tools.locator('[data-sessions-filter="past"]').click({ timeout: 3500 }).catch(() => {}) }
  await tools.waitForTimeout(1200)
  t.shootPage = tools; t.shootLabel = 'tools'
  return tools
}
const clickIn = async (t, page, loc, opts = {}) => { await loc.filter({ visible: true }).first().click({ timeout: opts.timeout ?? 3500, button: opts.button }); await page.waitForTimeout(opts.settle ?? 450) }

// ---- Authoring and commands ------------------------------------------------------------------------------------
R['action-bar'] = { run: async (t) => { t.method = 'visible by default (Settings → Writing → Show the action bar is on)' }, verify: (t) => t.visible('.tw-action-bar-btn') }
R['toolbar-insert'] = { run: bar('Insert') }
R['toolbar-deck'] = { run: bar('Talk') } // the Talk menu (named Deck before batch 1)
R['toolbar-tools'] = { run: bar('Tools') }
R['toolbar-present'] = { run: bar('Present') }
R['slide-context'] = { run: async (t) => { const tab = t.page.locator('[data-rc-tab="slides"] button'); if (await tab.count()) await tab.first().click(); await t.sleep(500); await t.page.locator('.tw-slide-card').first().click({ button: 'right' }); t.method = 'right-click a slide card in the strip (the sidebar\'s Strip tab)' } }
R['actions-here'] = { run: async (t) => { await t.click(t.page.locator('.tw-place-chip')) } }
R['status-place'] = { run: async (t) => { await t.click(t.page.locator('.tw-place-chip')) } }
R['talk-menu'] = { run: async (t) => { await t.click(talkRow(t), { button: 'right' }) } }
R['folder-menu'] = { run: async (t) => { await t.click(t.page.locator('aside.talk-list [data-folder-path]').first(), { button: 'right' }) } }
R['sort-talks'] = { run: async (t) => { await t.click(t.page.locator('button[aria-label="Sort"]')) } }
R['vault-menu'] = { run: async (t) => { await t.click(t.page.locator('button[aria-label="Actions for vault"]')) } }
R['talk-filter'] = { run: async (t) => { await t.click(t.page.locator('aside.talk-list input[aria-label="Filter talks"]')); await t.click(t.page.locator('.tl-pfx', { hasText: 'fo: folder' })); t.method = 'click a prefix chip under the Talks search' }, verify: async (t) => (await t.page.locator('aside.talk-list input[aria-label="Filter talks"]').inputValue()).startsWith('fo:') }
R['talk-search-assist'] = { run: async (t) => { const input = t.page.locator('aside.talk-list input[aria-label="Filter talks"]'); await input.click(); await input.fill('fo:Wo'); t.method = 'type "fo:Wo" in the Talks search'; await t.page.waitForTimeout(500) } }
R['talk-flyout'] = { run: async (t) => { await t.button('Ledger view'); await t.page.waitForTimeout(400); const row = t.page.locator('aside.talk-list [data-talk-title]').nth(2); await row.hover(); await t.page.waitForTimeout(900); t.method = 'Ledger view, hover a talk' } }
R['rename-talk'] = { run: async (t) => { await t.click(talkRow(t), { button: 'right' }); await t.click(t.page.locator('.actions-here, [role=menu], .tl-menu').getByText(/Rename/).first()) } }
R['delete-talk'] = { run: async (t) => { await t.click(talkRow(t), { button: 'right' }); await t.click(t.page.locator('.actions-here').getByText(/Move talk to Bin/).first()); t.note('Only the confirmation was opened; nothing was confirmed.') } }
R['move-talk'] = { run: async (t) => { await t.click(talkRow(t), { button: 'right' }); await t.click(t.page.locator('.actions-here, [role=menu], .tl-menu').getByText(/^Move/).first()) } }
R['vault-sheet-new'] = { run: async (t) => { await t.click(t.page.locator('.tl-addvault')); await t.sleep(600) } }
R['vault-sheet-join'] = { skip: 'needs the operating system folder chooser to pick an existing vault folder (native dialog, declined here)' }
R['vault-sheet-refused'] = { skip: 'needs the operating system folder chooser to pick a folder inside an open vault (native dialog, declined here)' }
R['vault-sheet-edit'] = { run: async (t) => { await t.click(t.page.locator('button[aria-label="Actions for vault"]')); await t.click(t.page.getByText('Edit this vault…')) } }
R['remove-example'] = { run: async (t) => t.missing('offered by the Guide only when the built-in example vault is loaded; the tour uses a copy of demo-vault as an ordinary vault') }
R['example-card'] = { skip: 'shown on the first-run screen when no vault is configured; the tour runs on a configured throwaway vault' }
R['vault-setup'] = { skip: 'first-run screen: only shown when no vault is configured; the tour runs on a configured throwaway vault (opening it would need removing the vault)' }

// ---- status bar --------------------------------------------------------------------------------------------------
R['status-version'] = { observe: /v0\.\d+\.\d+/, run: async (t) => { t.method = 'observe status bar' } }
R['status-slides'] = { observe: /\d+ slides/, run: async (t) => { t.method = 'observe status bar' } }
R['status-words'] = { observe: /\d+ words/, run: async (t) => { t.method = 'observe status bar' } }
R['status-dates'] = { observe: /Created .*Edited .*Delivered/, run: async (t) => { t.method = 'observe status bar' } }
R['status-save'] = { observe: /Unsaved|saved|ago|just now/i, run: async (t) => { await t.page.keyboard.type(' '); await t.sleep(300); t.method = 'type a character, observe the save state in the status bar' } }
R['status-run'] = { shootMain: true, windows: ['tools'], run: async (t) => {
  await t.command('plan-run'); await t.sleep(800)
  const sheet = t.page.locator('[data-testid="plan-run-sheet"]')
  await sheet.locator('[data-field="event"]').fill('Tour workshop'); await sheet.locator('[data-field="date"]').fill(dayOf(5)); await sheet.locator('[data-field="start"]').fill('14:00'); await sheet.locator('[data-field="expected"]').fill('10')
  await t.page.locator('[data-testid="plan-run-save"]').click(); await t.sleep(2500)
  for (const w of t.pagesOf('tools')) t.extraShots.push({ label: 'tools', page: w })
  t.method = 'Plan a Run → Save (writes a Run on the throwaway vault); the status bar chip is in the main window' }, noteFrom: async (t) => (await t.text('body')).slice(-200) }
R['status-build'] = { skip: 'a build or publish writes output files and may contact a service' }
R['status-shared'] = { skip: 'Share for comments publishes the talk to a service' }
R['status-update-answer'] = { skip: 'Check for Updates contacts the update service' }
R['status-conflict'] = { run: async (t) => { await otherTalk(t, 'TalkWeaver **Play on Next**'); await t.sleep(900) }, observe: /conflict/i }
R['toasts'] = { manyOk: true, run: async (t) => {
  await t.page.evaluate(() => {
    const send = (level, message) => window.dispatchEvent(new CustomEvent('tw-toast', { detail: { message, level, key: `tour-${level}` } }))
    send('info', 'Sample information notice'); send('success', 'Sample success notice'); send('warning', 'Sample warning notice'); send('error', 'Sample error notice')
  })
  t.method = 'dispatch the app\'s own tw-toast event in each of its four levels (sample wording, not real operations)'
}, observe: /Sample/ }

// ---- native menus and dialogs ------------------------------------------------------------------------------------
for (const [id, label] of [['menubar-talkweaver', 'TalkWeaver'], ['menubar-file', 'File'], ['menubar-edit', 'Edit'], ['menubar-slide', 'Slide'], ['menubar-talk', 'Talk'], ['menubar-view', 'View'], ['menubar-present', 'Present'], ['menubar-window', 'Window'], ['menubar-help', 'Help']]) {
  R[id] = { run: async (t) => {
    const menu = await t.app.evaluate(() => globalThis.__tourMenu?.() ?? null)
    const top = (menu ?? []).find((m) => m.label === label)
    const flat = (items) => (items ?? []).map((i) => i.type === 'separator' ? '—' : `${i.label}${i.accelerator ? ' (' + i.accelerator + ')' : ''}${i.submenu ? ' ▸ ' + flat(i.submenu).join(' / ') : ''}`)
    t.skip(`native macOS menu bar: an operating system menu that cannot be screenshotted headlessly. Items read from the app's menu: ${top ? flat(top.submenu).join(' | ').slice(0, 600) : 'menu not found'}`)
  } }
}
for (const id of ['native-vault', 'native-add-vault', 'native-archive', 'native-backup', 'native-ppt', 'native-import-destination', 'native-html', 'native-audio-export'])
  R[id] = { skip: 'native operating system file or folder chooser: cannot be screenshotted headlessly; the app declined it here' }
R['backup-enrol'] = { skip: 'offered only when presentation backups can be enabled with earlier edits available; not reachable on a fresh copy' }
R['migration'] = { skip: 'legacy recording migration is offered by the main process only for an old recording layout; not present in the demo vault' }

// ---- slides, images, reuse ----------------------------------------------------------------------------------------
R['image-meta'] = { run: async (t) => { await t.command('image'); await t.sleep(700); t.missing('the vault image pool is empty (the drawer says pictures appear once filed), so there is no image to open the details of') } }
R['plain-icon'] = { run: async (t) => { await t.page.locator('.tw-editor-tab', { hasText: 'Plain' }).click(); await t.sleep(900); await gotoLine(t, 'About'); await t.sleep(300); await t.command('icon-picker'); await t.sleep(600) } }
R['focus-detach'] = { skip: 'needs a reused slide in Slide Focus; the demo talks hold no reused slide to detach' }
R['propagation'] = { skip: 'offered after editing a slide reused in other talks; the demo vault has no reused slides' }
R['merge-slides'] = { run: async (t) => { await t.command('search'); await t.sleep(800); t.missing('merge needs slides ticked in two talks and a version cluster; not reachable here') } }
R['slide-batch'] = { run: async (t) => { await t.command('view-grid'); await t.sleep(900); const cards = t.page.locator('.grid-cell'); await cards.nth(2).click(); await cards.nth(4).click({ modifiers: ['Meta'] }); await cards.nth(5).click({ modifiers: ['Meta'] }); await t.sleep(500); t.method = 'grid: click a slide, then ⌘-click two more' } }
// The Inspector is the default tab of the right sidebar (R11a): this makes sure it is the one showing.
R['inspector'] = { run: async (t) => { await ensureInspector(t) }, verify: (t) => t.visible('.tw-inspector') }
R['explain'] = { run: async (t) => { await ensureInspector(t); await t.click(/Explain & markup/) } }
R['unresolved'] = { skip: 'needs an outline with unresolved trigger lines and an output operation (build or publish) to be started' }
R['disk-change-bar'] = { observe: /changed on disk/, run: async (t) => {
  const { writeFileSync, readFileSync } = await import('node:fs'); const { join } = await import('node:path')
  const f = join(t.vault, 'layout-showcase', 'layout-showcase-outline.md'); writeFileSync(f, readFileSync(f, 'utf8') + '\n<!-- changed outside -->\n'); await t.sleep(2500); t.method = 'change the open outline on disk from outside' } }
R['disk-change-sheet'] = { run: async (t) => {
  const { writeFileSync, readFileSync } = await import('node:fs'); const { join } = await import('node:path')
  const f = join(t.vault, 'layout-showcase', 'layout-showcase-outline.md'); await t.page.keyboard.type(' x'); writeFileSync(f, readFileSync(f, 'utf8') + '\n<!-- changed outside -->\n'); await t.sleep(2500)
  await t.click(/Overwrite|Leave|Review|Compare/).catch(() => {}); } }
R['conflict-compare'] = { run: async (t) => { await otherTalk(t, 'TalkWeaver **Play on Next**'); await t.sleep(700); await t.page.mouse.move(700, 450); await t.click(t.page.getByText(/conflict cop(y|ies) · Compare/).last()); await t.sleep(1800) } }
R['error-boundary'] = { skip: 'appears only if a renderer component throws; no safe way to trigger it without editing the app' }
R['image-edit'] = { run: async (t) => t.missing('needs the caret on a pooled image; the demo vault image pool is empty') }
for (const id of ['research-rename', 'research-kind', 'research-delete', 'research-move', 'research-copy']) {
  const cmd = { 'research-rename': 'research-rename', 'research-kind': 'research-change-kind', 'research-delete': 'research-delete', 'research-move': 'research-move', 'research-copy': 'research-copy' }[id]
  R[id] = { run: async (t) => { await t.command('research-panel'); await t.sleep(900); await t.click(t.page.locator('button.research-row').first()); await t.command(cmd); await t.sleep(500) } }
}
R['research-preview'] = { run: async (t) => { await t.command('research-panel'); await t.sleep(900); await t.click(t.page.locator('button.research-row').first()) } }
R['research-tidy'] = { run: async (t) => { await t.command('research-panel'); await t.sleep(900); await t.click(t.page.locator('button.research-row').first()); await t.page.locator('button[aria-label="Tidy research"]').evaluate((el) => el.click()); await t.sleep(500); t.method = 'Research → select an item → Tidy research (…)' } }
R['scratchpad-docked'] = { cmd: 'scratchpad-dock' }
R['scratchpad-float'] = { cmd: 'scratchpad-float' }
R['scratchpad-pill'] = { cmd: 'scratchpad-collapse' }

// ---- Tools window: Studio, History, Importer, Sessions, Published pages, Work files -----------------------------
const tpage = (t) => t.shootPage
const pickRun = async (t, kind = 'studio') => {
  const tools = tpage(t)
  await clickIn(t, tools, tools.locator('button.tws-scard').first(), { settle: 700 })
}
R['tools-rail'] = { run: async (t) => { const tools = await t.openTools(); t.shootPage = tools; t.shootLabel = 'tools'; await t.command('tools-view-runs', tools); t.method = 'Tools window with its rail' }, verify: (t) => t.visible('.tw-tools-rail-item', t.shootPage) }
R['tools-palette'] = { run: async (t) => { const tools = await t.openTools(); t.shootPage = tools; t.shootLabel = 'tools'; await tools.keyboard.press('Meta+Shift+P'); await tools.waitForTimeout(500); t.method = 'Tools window: ⌘⇧P' } }
R['studio-sessions'] = { run: async (t) => { const tools = await t.openTools(); t.shootPage = tools; t.shootLabel = 'tools'; t.method = 'Studio opens with its Recorded Runs sidebar' }, verify: (t) => t.visible('button.tws-scard', t.shootPage) }
R['studio-settings'] = { run: async (t) => { const tools = await t.openTools(); t.shootPage = tools; t.shootLabel = 'tools'; await t.click(tools.locator('button[aria-label="Open settings for Studio"]'), { page: tools }) } }
R['studio-help'] = { run: async (t) => { const tools = await t.openTools(); t.shootPage = tools; t.shootLabel = 'tools'; await t.click(tools.locator('button[aria-label="Keyboard cheat-sheet"]'), { page: tools }) } }
R['studio-transcript'] = { run: async (t) => { const tools = await t.openTools(); t.shootPage = tools; t.shootLabel = 'tools'; await pickRun(t); t.method = 'Studio: select a Run; the transcript pane is on the right' }, verify: (t) => t.page && t.shootPage.getByText(/TRANSCRIPT/i).first().isVisible() }
R['studio-delete'] = { run: async (t) => { const tools = await t.openTools(); t.shootPage = tools; t.shootLabel = 'tools'; await pickRun(t); await t.click(tools.getByRole('button', { name: /Delete/ }), { page: tools }); t.note('Only the confirmation was opened; nothing was confirmed or deleted.') } }
R['notes'] = { run: async (t) => { const tools = await t.openTools(); t.shootPage = tools; t.shootLabel = 'tools'; await pickRun(t); await t.click(tools.getByRole('button', { name: 'Manage notes' }), { page: tools }); await tools.waitForTimeout(800) } }
for (const [id, hint] of [['notes-contents', /Contents/], ['notes-recording-picker', /^Change$/], ['notes-format', /Plain text|Rich|Markdown/], ['notes-clean', /Clean…/], ['notes-rewrite', /Rewrite…/], ['notes-help', null], ['notes-document', /Notes/]]) {
  R[id] = { run: async (t) => {
    const tools = await t.openTools(); t.shootPage = tools; t.shootLabel = 'tools'; await pickRun(t)
    await t.click(tools.getByRole('button', { name: 'Manage notes' }), { page: tools }); await tools.waitForTimeout(900)
    if (id === 'notes-help') await t.click(tools.locator('button[aria-label="Keyboard cheat-sheet"]'), { page: tools })
    else if (id === 'notes-contents' || id === 'notes-document') { t.method = 'Manage notes opens with Contents and the document' }
    else {
      if (id === 'notes-rewrite') await t.click(tools.getByRole('button', { name: 'Notes', exact: true }), { page: tools })
      await t.click(tools.getByRole('button', { name: hint }), { page: tools })
    }
  } }
}
R['video-package'] = { run: async (t) => { const tools = await t.openTools(); t.shootPage = tools; t.shootLabel = 'tools'; await pickRun(t); await t.click(tools.getByRole('button', { name: /Animated video/ }), { page: tools }); await tools.waitForTimeout(800) } }
R['video-ready'] = { run: async (t) => t.missing('needs a Run that already has an animated video package; none can be made without running the video build') }
R['history-index'] = { run: async (t) => { await toolsAt(t, 'history'); t.missing('the talks index went when History merged into the Runs view (R5): View → Group → Talk groups the list by talk instead') } }
R['history-settings'] = { run: async (t) => { const tools = await toolsAt(t, 'history'); await t.click(tools.locator('button[aria-label="Open settings for Runs"]'), { page: tools }) } }
R['history-help'] = { run: async (t) => { const tools = await toolsAt(t, 'history'); await t.click(tools.locator('button[aria-label="Keyboard cheat-sheet"]'), { page: tools }) } }
const pickDelivered = async (t) => { const tools = await toolsAt(t, 'history'); await t.click(tools.locator('[data-sessions-row="layout-showcase/run-rich"]'), { page: tools }); await tools.waitForTimeout(500); return tools }
R['history-actions'] = { run: async (t) => { const tools = await pickDelivered(t); t.note('The History row menu is gone: each action is a control in the Run\'s ledger (kind, context, Open in Studio, upload, Delete this Run…).'); await tools.locator('[data-run-ledger]').first().scrollIntoViewIfNeeded().catch(() => {}) }, verify: (t) => t.visible('[data-run-ledger]', t.shootPage) }
R['history-kind'] = { run: async (t) => { const tools = await pickDelivered(t); await tools.locator('[data-run-kind]').first().scrollIntoViewIfNeeded().catch(() => {}); t.method = 'Runs: select a Run; its ledger has the kind of Run as three toggle buttons' }, verify: (t) => t.visible('[data-run-kind]', t.shootPage) }
R['history-delete'] = { run: async (t) => { const tools = await pickDelivered(t); await t.click(tools.locator('[data-run-delete]').first(), { page: tools }); t.note('Only the confirmation was opened; nothing was confirmed or deleted.') } }
R['history-detail'] = { run: async (t) => { await pickDelivered(t); t.method = 'Runs: select a Run that has been given; its page carries the ledger (the old Run details)' }, verify: (t) => t.visible('[data-run-ledger]', t.shootPage) }
const runDetails = async (t, find) => { const tools = await toolsAt(t, 'runs'); await t.click(tools.locator('[data-sessions-row="layout-showcase/run-rich"]'), { page: tools }); if (find) await tools.locator(find).first().scrollIntoViewIfNeeded().catch(() => {}); await tools.waitForTimeout(400); return tools }
R['board-results'] = { run: async (t) => { await runDetails(t, '.rb-act, [class*=run-board]') } }
R['board-hidden'] = { run: async (t) => { const tools = await runDetails(t, '.rb-act'); await t.click(tools.getByRole('button', { name: /^Show/ }).first(), { page: tools }) } }
R['results-share'] = { run: async (t) => { const tools = await runDetails(t, '.rb-act'); await t.click(tools.getByRole('button', { name: /Share/ }).first(), { page: tools }); t.note('Only the sheet was opened; no link was made.') } }
R['run-questions'] = { run: async (t) => { await runDetails(t, '[data-history-instant]') } } // scrolls to the instant slides, with the questions below
R['run-reactions'] = { run: async (t) => { await runDetails(t, '[data-history-reactions]') } }
R['import-settings'] = { run: async (t) => { const tools = await toolsAt(t, 'importer'); await t.click(tools.locator('button[aria-label="Open settings for Importer"]'), { page: tools }) } }
R['import-help'] = { run: async (t) => { const tools = await toolsAt(t, 'importer'); await t.click(tools.locator('button[aria-label="Keyboard cheat-sheet"]'), { page: tools }) } }
R['import-bench'] = { run: async (t) => { await toolsAt(t, 'importer'); t.missing('Recent imports exist only after an import has run; importing would write into the vault, so none is made here') } }
const sessionsRun = async (t, rowText = 'Saïd workshop') => { const tools = await toolsAt(t, 'runs'); await t.click(tools.locator('button.tw-sess-row', { hasText: rowText }), { page: tools }); await tools.waitForTimeout(700); return tools }
R['run-page'] = { run: async (t) => { await sessionsRun(t) } }
R['run-answers'] = { run: async (t) => { const tools = await sessionsRun(t); await tools.getByText(/Answers|answers/).first().scrollIntoViewIfNeeded().catch(() => {}) } }
R['run-extras'] = { run: async (t) => { const tools = await sessionsRun(t); await tools.locator('[data-run-section="extras"], [class*=extras]').first().scrollIntoViewIfNeeded().catch(() => {}) } }
R['plan-run-edit'] = { run: async (t) => { const tools = await sessionsRun(t); await t.click(tools.locator('[data-run-action="edit-plan"]'), { page: tools }) } }
R['plan-run-copy'] = { run: async (t) => { const tools = await sessionsRun(t, 'Digital Education Day'); await t.click(tools.getByText(/Plan the next Run/), { page: tools }) } }
R['plan-run-time'] = { run: async (t) => { const tools = await sessionsRun(t); await t.click(tools.locator('[data-run-action="change-pre-time"]').first(), { page: tools }) } }
R['published-detail'] = { run: async (t) => { const tools = await toolsAt(t, 'published'); await t.click(tools.locator('.tw-pub-pick').first(), { page: tools }) } }
R['unpublish'] = { run: async (t) => { const tools = await toolsAt(t, 'published'); await t.click(tools.locator('.tw-pub-pick').first(), { page: tools }); await t.click(tools.getByRole('button', { name: 'Unpublish' }).first(), { page: tools }); t.note('Only the confirmation was opened; nothing was unpublished.') } }
R['work-file-detail'] = { run: async (t) => { const tools = await toolsAt(t, 'workfiles'); await t.click(tools.locator('button.tw-wf-row').first(), { page: tools }) } }
R['work-file-new'] = { run: async (t) => { const tools = await toolsAt(t, 'workfiles'); await t.click(tools.getByRole('button', { name: /New file/ }), { page: tools }) } }
R['work-file-answer-route'] = { run: async (t) => { const tools = await toolsAt(t, 'workfiles'); await t.click(tools.locator('button.tw-wf-row').first(), { page: tools }); await tools.waitForTimeout(600) }, observe: /sent|answer|response/i }
R['studio'] = { run: async (t) => { const tools = await t.openTools(); t.shootPage = tools; t.shootLabel = 'tools' } }
R['history'] = { run: async (t) => { await toolsAt(t, 'history') }, verify: (t) => t.visible('[data-sessions-list]', t.shootPage) }
R['importer'] = { run: async (t) => { await toolsAt(t, 'importer') } }
R['sessions'] = { run: async (t) => { await toolsAt(t, 'runs') }, verify: (t) => t.visible('[data-sessions-list]', t.shootPage) }
R['published'] = { run: async (t) => { await toolsAt(t, 'published') } }
R['work-files'] = { run: async (t) => { await toolsAt(t, 'workfiles') } }

// ---- Settings window -----------------------------------------------------------------------------------------------
const SECTION = { general: 'general', writing: 'writing', presenting: 'presenting', publishing: 'publishing', recording: 'recording', 'talk-defaults': 'talk-defaults', importing: 'importing', accounts: 'accounts', shortcuts: 'shortcuts', changes: 'changes', updates: 'updates', 'get-started': 'get-started', backups: 'backups', cloudflare: 'cloudflare' }
for (const [id, key] of [['settings-general', 'general'], ['settings-writing', 'writing'], ['settings-presenting', 'presenting'], ['settings-publishing', 'publishing'], ['settings-recording', 'recording'], ['settings-talk-defaults', 'talk-defaults'], ['settings-importing', 'importing'], ['settings-accounts', 'accounts'], ['settings-shortcuts', 'shortcuts'], ['settings-updates', 'updates'], ['settings-get-started', 'get-started'], ['settings-backups', 'backups'], ['settings-cloudflare', 'cloudflare'], ['settings-changes', 'changes'], ['cloudflare-settings', 'cloudflare'], ['transcription-settings', 'recording'], ['agent-settings', 'get-started']]) {
  R[id] = { run: async (t) => { const sw = await t.openSettings(SECTION[key]); t.shootPage = sw; t.shootLabel = 'settings' } }
}
const inSettings = async (t, section) => { const sw = await t.openSettings(section); t.shootPage = sw; t.shootLabel = 'settings'; return sw }
R['settings'] = { run: async (t) => { await inSettings(t) } }
R['settings-inspector'] = { run: async (t) => { const sw = await inSettings(t, 'writing'); await t.click(sw.locator('.bsw-row, [class*=bsw-setting], [class*=bsw-row]').first(), { page: sw }) } }
R['settings-recent'] = { run: async (t) => { const sw = await inSettings(t, 'writing'); await t.click(sw.locator('button.bsw-nav[data-section="general"]:visible'), { page: sw }) } }
R['settings-reset-section'] = { run: async (t) => { const sw = await inSettings(t, 'writing'); await t.click(sw.getByRole('button', { name: 'Serif' }), { page: sw }); await t.click(sw.getByRole('button', { name: /Reset section/ }), { page: sw }); t.note('Only the confirmation was opened; nothing was reset.') } }
R['settings-reset-all'] = { run: async (t) => { const sw = await inSettings(t, 'updates'); await t.click(sw.getByRole('button', { name: /Reset all settings/ }), { page: sw }); t.note('Only the confirmation was opened; nothing was reset.') } }
R['settings-add-key'] = { run: async (t) => { const sw = await inSettings(t, 'accounts'); await t.click(sw.getByRole('button', { name: /Add key|Replace key/ }).first(), { page: sw }) } }
R['settings-refused'] = { skip: 'needs a native file chooser to pick an incompatible settings file (declined here)' }
R['settings-key-conflict'] = { run: async (t) => { const sw = await inSettings(t, 'shortcuts'); await t.click(sw.locator('[class*=bsw-key], button:has-text("⌘")').first(), { page: sw }); await sw.keyboard.press('Alt+Meta+r'); await sw.waitForTimeout(500) } }
R['settings-key-refused'] = { run: async (t) => { const sw = await inSettings(t, 'shortcuts'); await t.click(sw.locator('[class*=bsw-key], button:has-text("⌘")').first(), { page: sw }); await sw.keyboard.press('Meta+q'); await sw.waitForTimeout(500) } }
R['settings-notice'] = { run: async (t) => t.missing('needs a Settings operation that fails (for example a refused import file); none can be made safely here') }
R['settings-import'] = { skip: 'opening_changes_data and needs a native file chooser' }

// ---- Slide browser (Slides from other talks) -------------------------------------------------------------------
const browser = async (t) => {
  await t.command('search'); await t.sleep(1200)
  // A card is clicked whether or not its thumbnail has been drawn yet (the cards show "rendering…" first).
  await t.page.locator('.lt .lt-card').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
  await t.page.locator('.lt .lt-card').first().click({ timeout: 3500 }); await t.sleep(400)
}
const browserKey = (key, note) => async (t) => { await browser(t); await t.page.keyboard.press(key); await t.sleep(700); t.method = `slide browser: select a slide, press ${key}${note ? ' (' + note + ')' : ''}` }
R['slide-lightbox'] = { run: browserKey('Space', 'preview') }
R['insert-viewer'] = { run: browserKey('Enter', 'view & insert') }
R['locations'] = { run: browserKey('e', 'versions / where-used') }
// A click on a card selects it, so the tray is already up after `browser`; a second selection (shift-click) makes the count plural.
R['selection-tray'] = { run: async (t) => { await browser(t); await t.page.locator('.lt .lt-card').nth(1).click({ modifiers: ['Shift'], timeout: 3500 }); await t.sleep(700); t.method = 'slide browser: click one card, shift-click another' } }
R['talk-beside'] = { run: browserKey('0', 'talk beside') }
R['slide-versions'] = { run: async (t) => { await browser(t); await t.click(t.page.getByText(/near-identical/).first()) } }
R['browser-rail'] = { run: async (t) => { await browser(t); t.method = 'slide browser: rail visible on the left (I toggles it)' }, verify: (t) => t.visible('.lt-rghead') }
R['browser-find-talk'] = { run: async (t) => { await t.command('search'); await t.sleep(1000); await t.page.getByPlaceholder(/Name, folder, event/).click(); await t.page.keyboard.type('Play'); await t.sleep(700) } }
R['browser-filter-groups'] = { run: async (t) => { await t.command('search'); await t.sleep(1000); await t.page.getByText(/^Filters$/i).first().scrollIntoViewIfNeeded().catch(() => {}); t.method = 'slide browser: Filters groups in the left rail' }, verify: (t) => t.visible('.lt-fsub-head') }
R['browser-browse-tabs'] = { run: async (t) => { await t.command('search'); await t.sleep(1000); await t.page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Collections')?.click()); await t.sleep(600); t.method = 'slide browser: Browse → Collections tab' } }
R['merge-slides'] = { run: async (t) => t.missing('merge needs a version cluster of two or more selected slides; the demo vault holds only one such near-identical cluster and merging rewrites talks') }

// ---- Inspector and slide kinds ---------------------------------------------------------------------------------
/** Select a slide by its title through the Slide outline sidebar (the editor only renders the lines in view). */
async function selectSlideByTitle(t, title) {
  await t.page.locator('.sidebar-mode-btn', { hasText: 'Slide outline' }).click({ timeout: 3000 }); await t.sleep(500)
  await t.page.locator('button.so-slide', { hasText: title }).first().click({ timeout: 3500 }); await t.sleep(900)
}
// The Inspector is the default tab of the right sidebar (R11a); make sure it is the one showing.
const ensureInspector = async (t) => {
  if (await t.visible('.tw-inspector')) return
  const tab = t.page.locator('[data-rc-tab="inspector"] button')
  if (await tab.count()) await tab.first().click()
  else await t.command('toggle-inspector')
  await t.sleep(700)
}
const inspect = async (t, line, talk) => {
  if (talk) await otherTalk(t, talk)
  await ensureInspector(t); await t.sleep(300)
  if (line) await selectSlideByTitle(t, line.replace(/^#+ /, ''))
}
R['poll-help'] = { run: async (t) => { await inspect(t, '### Poll'); t.method = 'Inspector on the Poll slide' } }
R['quote-notes'] = { run: async (t) => { await inspect(t, '### A quote') } }
R['board-inspector'] = { run: async (t) => { await inspect(t, 'What should we keep, change or try?', 'TalkWeaver **Pre-work Workshop**') } }
R['reactions-options'] = { run: async (t) => { await inspect(t, 'How is the pace so far?', 'TalkWeaver **Pre-work Workshop**') } }
R['prework-inspector'] = { run: async (t) => { t.missing('the demo Pre-work Workshop keeps its steps in a work file, not as slides, so no work-file slide exists to select') } }
R['html-inspector'] = { run: async (t) => { await inspect(t, 'A page that runs when you present', 'TalkWeaver **Embedded Page**') } }
R['web-inspector'] = { run: async (t) => { await inspect(t, 'A web link', 'TalkWeaver **Link Checks**') } }
R['plain-look'] = { run: async (t) => { await ensureInspector(t); await t.command('view-plain'); await t.sleep(900); await gotoLine(t, 'About') }, verify: (t) => t.visible('.tw-inspector') }
R['slide-provenance'] = { run: async (t) => t.missing('shown only for a slide reused from another talk (with an origin line); the demo vault has none') }
// House rule R11: the Plain view's Talk details is one line that links to the Talk tab; Talk design… and Metadata… are no longer dialogs, their
// commands open the Talk tab (and Metadata… its Advanced part).
R['origin'] = { run: async (t) => { await t.command('view-plain'); await t.sleep(900); t.method = 'view-plain; the Talk details line (one line, links to the Talk tab)' }, verify: (t) => t.visible('[data-talk-details]') }
R['deck-design'] = { run: async (t) => { await t.command('deck-design'); await t.sleep(900) }, verify: (t) => t.visible('[data-talk-tab]') }
R['metadata'] = { run: async (t) => { await t.command('metadata'); await t.sleep(700); await t.page.locator('[data-talk-section="advanced"] > summary').click(); await t.sleep(1200) }, verify: (t) => t.visible('[data-metadata-embedded]') }
R['talk-tab-advanced'] = { run: async (t) => { await t.command('deck-design'); await t.sleep(700); await t.page.locator('[data-talk-section="advanced"] > summary').click(); await t.sleep(1200) }, verify: (t) => t.visible('[data-metadata-embedded]') }
R['mode-back'] = { run: async (t) => { await t.command('vault-gallery'); await t.sleep(1000) }, verify: (t) => t.visible('[data-mode-back]') }
R['talk-activity'] = { run: async (t) => { await t.command('view-markdown'); await t.sleep(900); await t.page.locator('[data-fm-edit-in-tab]').first().click(); await t.sleep(900); t.method = 'view-markdown; the Metadata table\'s Edit in the Talk tab' }, verify: (t) => t.visible('[data-talk-tab]') }

// ---- Pathways ----------------------------------------------------------------------------------------------------------
const newPathway = async (t) => {
  await t.command('pathways'); await t.sleep(900)
  await t.click(t.page.getByRole('button', { name: 'New', exact: true })); await t.sleep(500)
}
R['pathway-new'] = { run: async (t) => { await newPathway(t) } }
const makePathway = async (t) => {
  await newPathway(t)
  await t.page.keyboard.type('Tour pathway'); await t.page.keyboard.press('Enter'); await t.sleep(900)
}
R['pathway-rename'] = { run: async (t) => { await makePathway(t); await t.click(t.page.getByRole('button', { name: /Rename/ }).first()) } }
R['pathway-delete'] = { run: async (t) => { await makePathway(t); await t.click(t.page.getByRole('button', { name: /^Delete/ }).first()); t.note('Only the confirmation was opened; nothing was deleted.') } }
R['plan-new-pathway'] = { run: async (t) => { await makePathway(t); await t.command('view-markdown'); await t.sleep(500); await t.command('plan-run'); await t.sleep(800); const sel = t.page.locator('[data-field="slide-set"]'); const opts = await sel.locator('option').evaluateAll((os) => os.map((o) => [o.value, o.textContent])); const m = opts.find(([, label]) => /New pathway/.test(label ?? '')); if (!m) t.missing('the Slides choice offers no New pathway option here'); await sel.selectOption(m[0]); await t.sleep(600); t.method = 'Plan a Run: choose New pathway… in Slides' } }

// ---- Vault Gallery ------------------------------------------------------------------------------------------------------
const gallery = async (t, mode) => {
  await t.command('vault-gallery'); await t.sleep(1000)
  if (mode === 'talk') { await t.click(t.page.locator('.vg-tr', { hasText: 'All talks' })); await t.sleep(900); await t.click(t.page.locator('.vault-gallery').getByText('Ai Chat And Terminal Slides').first()); await t.sleep(600) }
}
R['gallery-tree'] = { run: async (t) => { await gallery(t); t.method = 'Vault Gallery opens with its Folders tree on the left' }, verify: (t) => t.visible('.vg-tr') }
R['gallery-details'] = { run: async (t) => { await gallery(t, 'talk'); await t.click(t.page.getByRole('button', { name: 'Details' }).first()) } }
R['gallery-actions'] = { run: async (t) => { await gallery(t, 'talk'); await t.click(t.page.locator('.vault-gallery').getByRole('button', { name: /More/ }).first()) } }
R['gallery-move'] = { run: async (t) => { await gallery(t, 'talk'); await t.click(t.page.locator('.vault-gallery').getByRole('button', { name: /More/ }).first()); await t.click(t.page.getByText(/^Move/).first()) } }
R['gallery-handouts'] = { run: async (t) => { await gallery(t, 'talk'); await t.click(t.page.locator('.vault-gallery').getByText('Handouts', { exact: true }).first()) } }
R['gallery-storage'] = { run: async (t) => { await gallery(t); await t.click(t.page.getByRole('button', { name: 'Details' }).first()); await t.click(t.page.getByRole('button', { name: /Measure/ }).first()); await t.sleep(900) } }
R['gallery-preview'] = { run: async (t) => { await gallery(t, 'talk'); await t.page.keyboard.press('Space'); await t.sleep(900); t.method = 'Vault Gallery: select a talk, press Space (Preview title slide)' } }

// ---- Guide, updates, agents -----------------------------------------------------------------------------------------------
R['guide-chapters'] = { run: async (t) => { await t.command('get-started-open-guide'); await t.sleep(900); await t.click(t.page.getByText('Learn the commands', { exact: true })); await t.sleep(400) }, verify: (t) => t.page.getByText('Chapters', { exact: true }).first().isVisible() }
R['guide-how'] = { run: async (t) => { await t.command('get-started-open-guide'); await t.sleep(900); await t.click(t.page.getByText('How it works', { exact: true })); await t.sleep(500) } }
R['guide-features'] = { run: async (t) => { await t.command('get-started-open-guide'); await t.sleep(900); await t.click(t.page.getByText('Features to delight you', { exact: true })); await t.sleep(500) } }
R['agent-offer'] = { run: async (t) => t.missing('offered at first run only when an AI agent is detected on this computer; the throwaway profile shows no offer') }
R['agent-done'] = { run: async (t) => t.missing('shown after the agent skill has been installed; installing writes into agent folders, so it is not done here') }
R['agent-later'] = { run: async (t) => t.missing('the agent skill mark appears in the status bar only when an AI agent is detected on this computer; the throwaway profile shows none') }
R['update-popover'] = { run: async (t) => t.missing('shown only when a newer version is found; the update check contacts the update service and is blocked here') }

// ---- Scratchpad ----------------------------------------------------------------------------------------------------------------
const openPad = async (t) => { await t.click(t.page.getByText('Expand', { exact: true }).first()); await t.sleep(900) }
R['scratchpad-preview'] = { run: async (t) => { await openPad(t); await t.click(t.page.getByText('Agent sketch', { exact: true })); await t.sleep(700) } }
R['scratchpad-group'] = { run: async (t) => { await openPad(t); await t.page.getByRole('checkbox').first().check(); await t.command('scratchpad-move-to-group'); await t.sleep(500) } }
R['scratchpad-new-group'] = { run: async (t) => { await openPad(t); await t.command('scratchpad-new-group'); await t.sleep(500) } }
R['scratchpad-place'] = { run: async (t) => { await openPad(t); await t.command('scratchpad-change-place'); await t.sleep(500) } }
R['scratchpad-compare'] = { run: async (t) => { await openPad(t); const boxes = t.page.getByRole('checkbox'); await boxes.nth(0).check(); await boxes.nth(1).check(); await t.command('scratchpad-compare'); await t.sleep(700) } }
R['scratchpad-visual'] = { run: async (t) => t.missing('needs a Scratchpad slide holding several visuals; the throwaway Scratchpad holds an agent picture and an HTML page only') }

// ---- Presenter family ------------------------------------------------------------------------------------------------------------
// The Presenter window's own opening is flagged opening_changes_data, so by rule it is not opened: these surfaces are recorded as
// precondition-missing. With --allow-writes (throwaway copy only) the Presenter is opened and these recipes run; nothing is recorded,
// no live session is started and no microphone is used.
const PRESENTER_NEEDS = 'needs the Presenter window, whose own opening is flagged opening_changes_data: true (skipped by rule; rerun with --allow-writes to open it on the throwaway copy)'
async function pres(t) {
  if (!t.allowWrites) t.missing(PRESENTER_NEEDS)
  await t.command('present-presenter')
  const w = await t.windowOf('present', 12000); t.shootPage = w; t.shootLabel = 'presenter'
  await w.waitForTimeout(1800); t.method = 'present-presenter (command), then the Presenter window'
  return w
}
const pmenu = (menu, item) => async (t) => { const w = await pres(t); await t.click(w.locator('button.tw-menu-btn', { hasText: menu }), { page: w }); if (item) await t.click(w.locator('button.tw-mi', { hasText: item }).first(), { page: w }) }
const pbtn = (name, after) => async (t) => { const w = await pres(t); await t.click(w.locator('button', { hasText: name }).first(), { page: w }); if (after) await after(t, w) }
R['presenter-clock'] = { run: async (t) => { const w = await pres(t); await t.click(w.getByText('talk length').locator('xpath=following::button[1]'), { page: w }) } }
R['presenter-live-menu'] = { run: pmenu('Live') }
R['presenter-poll-menu'] = { run: pmenu('Poll') }
R['presenter-view-menu'] = { run: pmenu('View') }
R['presenter-notes-menu'] = { run: pmenu('View', /Notes placement/) }
R['presenter-live-link'] = { run: pmenu('Live', /join link/i) }
R['presenter-instant-compose'] = { run: pmenu('Live', /Compose instant slide/i) }
R['presenter-instant-paste'] = { run: pmenu('Live', /Instant slide from clipboard/i) }
R['presenter-quick-poll'] = { run: pbtn('Quick poll') }
R['presenter-poll-panel'] = { run: pmenu('Poll', /Show poll panel/i) }
R['presenter-board'] = { run: pmenu('Poll', /Board panel/i) }
R['presenter-outline'] = { run: pbtn('Outline') }
R['presenter-next'] = { observe: /NEXT/, run: async (t) => { await pres(t) } }
R['presenter-then'] = { observe: /THEN/, run: async (t) => { await pres(t) } }
R['presenter-notes'] = { observe: /NOTES/, run: async (t) => { await pres(t) } }
R['presenter-questions'] = { run: async (t) => { await pres(t); t.missing('the Questions count appears in the header only while a live session is collecting questions') } }
R['presenter-more'] = { run: pbtn('More') }
R['presenter-pen-pop'] = { run: async (t) => { const w = await pres(t); await t.click(w.locator('button', { hasText: 'Pen' }).first(), { page: w, button: 'right' }); await w.waitForTimeout(500) } }
R['presenter-pen-strip'] = { run: pbtn('Pen') }
R['presenter-palette'] = { run: async (t) => { const w = await pres(t); await w.keyboard.press('Meta+Shift+P'); await w.waitForTimeout(600) } }
R['presenter-guide'] = { run: pbtn(/Guide/) }
R['presenter-licence'] = { run: async (t) => { await t.command('present-window'); const w = await t.windowOf('present', 12000); t.shootPage = w; t.shootLabel = 'presentation'; await w.waitForTimeout(1500); const el = w.getByText(/licen[cs]e/i).first(); if (!(await el.count())) t.missing('the Presentation window of this talk shows no licence link (it appears for slides carrying licensed material)'); await t.click(el, { page: w }) } }
R['presenter-status-presenterRecSlot'] = { observe: /Not recording/, run: async (t) => { await pres(t) } }
R['presenter-status-presenterLiveStatus'] = { observe: /Not live/, run: async (t) => { await pres(t) } }
R['presenter-status-presenterPointerChip'] = { run: pbtn('Pointer') }
R['presenter-status-presenterPenChip'] = { run: pbtn('Pen') }
R['presenter-status-presenterHighlightChip'] = { run: pbtn('Highlight') }
R['presenter-status-sectionTimer'] = { run: pbtn('Start timer') }
for (const id of ['presenter-status-presenterVenueNotice', 'presenter-status-presenterModeChip', 'presenter-status-presenterInkStatus', 'presenter-status-presenterReactions', 'presenter-status-presenterQuestions', 'presenter-status-presenterBoardCount', 'presenter-status-presenterCount', 'presenter-status-presenterInstantStrip', 'presenter-gallery'])
  R[id] = { run: async (t) => { await pres(t); t.missing('appears only with live audience data, an active ink mode or an image-gallery slide; none exists without going live') } }
for (const id of ['presenter-recording', 'presenter-resume-offer', 'presenter-save-offer', 'presenter-start-offer', 'presenter-saved', 'presenter-audio-lost', 'presenter-audio-back', 'presenter-disk', 'presenter-kind'])
  R[id] = { skip: 'reaching this state means starting a recording and using the microphone; the tour never records' }
R['presenter-close'] = { skip: 'appears when closing the Presenter with an unsaved recording or live session; reaching it needs a recording or going live' }
R['presenter-live-setup'] = { skip: 'Go live runs the live-service set-up against a network service; the tour never goes live' }
R['presenter-end-boards'] = { skip: 'needs an active live session with open boards (going live, network)' }
for (const id of ['board-menu-screen', 'board-menu-column', 'board-menu-group', 'board-menu-card', 'board-menu-wording'])
  R[id] = { run: async (t) => { if (!t.allowWrites) t.missing(PRESENTER_NEEDS); t.missing('needs a live feedback board with cards; a board exists only in a live session (network)') } }

R['feedback'] = { skip: 'feedback inbox belongs to a talk shared for comments, which exists only after publishing to a service' }
R['publish-not-ready'] = { skip: 'clicking Publish starts a publish (in the app\'s test mode a rehearsal that still writes the handout address into the outline); the not-ready sheet appears only without a service, which the tour does not stage' }
R['publish-work-notice'] = { run: async (t) => t.missing('shown when publishing an evergreen handout whose talk has work files attached; reaching it goes through the publish path (service), which is not taken') }
R['board-copied'] = { skip: 'opening_changes_data: copies the board to the clipboard' }
// R18: the editor-only state is Slides with the sidebar off.
// What's new is a tab of the right sidebar (R11a); the tab row is on screen before it opens, so the recipe checks the tab itself.
R['whats-new'] = { cmd: 'whats-new', verify: (t) => t.visible('[data-rc-tab="whats-new"].rc-tab--on') }
R['editor'] = { run: async (t) => { await t.command('view-slides'); await t.sleep(400); if (await t.visible('[data-right-column]')) { await t.command('toggle-inspector'); await t.sleep(500) } }, verify: async (t) => !(await t.visible('[data-right-column]')) && (await t.visible('.cm-content')) }
R['slide-strip'] = { cmd: 'view-strip', verify: async (t) => (await t.visible('.tw-slide-card')) && !(await t.visible('.cm-content')) }
R['plain-editor'] = { cmd: 'view-plain', verify: async (t) => (await t.text('body')).includes('Talk details') }
R['markdown-editor'] = { cmd: 'view-markdown', verify: async (t) => (await t.text('body')).includes('METADATA') }
R['grid'] = { cmd: 'view-grid', verify: (t) => t.visible('[data-testid="grid-toggle"].pane-btn--active, .grid-col-btn') }

R['capture-embed-window'] = { cmd: 'capture-embed', run: async (t) => { await otherTalk(t, 'TalkWeaver **Embedded Page**'); await t.command('view-markdown'); await selectSlideByTitle(t, 'A page that runs when you present'); await t.sleep(3500); await t.command('capture-embed'); await t.sleep(3500); await t.command('capture-embed'); await t.sleep(2500) } }

/** Recipes by family for ids not listed above. */
export function fallbackRecipe(surface) {
  if (/^audience-/.test(surface.id)) return { skip: 'a page for participants, generated for a published handout or a live session; reaching it needs publishing or going live (network)' }
  return null
}
