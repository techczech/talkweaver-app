// Real-Electron harness for the Slide Browser (Light Table, ADR-0034): ⌘K overlay, search,
// filter chips, index rail, density, selection + action tray + multi-insert, the version
// filmstrip (badge → strip → version-insert), empty states, Esc ladder.
import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'url'; import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs'; import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url)); const REPO = join(__dirname, '..')
const results = []
const record = (n, p, d) => { results.push({ n, p }); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`) }

const root = mkdtempSync(join(tmpdir(), 'tw-e2e-browser-')); const vault = join(root, 'v'); const ud = join(root, 'ud')
const alpha = join(vault, 'topic-x', 'alpha-talk'); const beta = join(vault, 'topic-y', 'beta-talk')
mkdirSync(alpha, { recursive: true }); mkdirSync(beta, { recursive: true }); mkdirSync(ud, { recursive: true })
writeFileSync(join(alpha, 'alpha-talk-outline.md'), [
  '---', 'title: Alpha Talk', '---', '',
  '## Intro', '',
  '### Welcome', '', 'This slide body mentions zebracorn somewhere in the content.', '',
  '### Pricing note', '{statement} {id=vfixt}', '', 'Converging on a single price point over time.', '',
  '## Deep dive', '',
  '### Numbers', '', '- one thing', '- another thing', ''
].join('\n'))
// Version-store fixture for the filmstrip (Task 6): id vfixt with 2 recorded versions —
// head (newest) unsealed = 'current session'; older sealed by presenting = the canonical.
// The head's markdown MUST equal the outline's block verbatim: the app records a ledger
// sweep on save, and a differing head would append a third version mid-run.
const vdir = join(vault, '_SLIDE-VERSIONS', 'vfixt')
mkdirSync(vdir, { recursive: true })
writeFileSync(join(vdir, '20260601-120000--alpha-talk.md'), [
  '---', 'id: vfixt', 'talk: alpha-talk', 'outline: topic-x/alpha-talk/alpha-talk-outline.md',
  'saved_at: 2026-06-01T12:00:00.000Z', 'sealed_by: present', '---', '',
  '### Pricing note {id=vfixt}', '', 'An earlier, sealed take on pricing.', ''
].join('\n'))
writeFileSync(join(vdir, '20260620-090000--alpha-talk.md'), [
  '---', 'id: vfixt', 'talk: alpha-talk', 'outline: topic-x/alpha-talk/alpha-talk-outline.md',
  'saved_at: 2026-06-20T09:00:00.000Z', '---', '',
  '### Pricing note', '{statement} {id=vfixt}', '', 'Converging on a single price point over time.', ''
].join('\n'))
writeFileSync(join(beta, 'beta-talk-outline.md'), [
  '---', 'title: Beta Talk', '---', '',
  '## Marsupials', '',
  '### Other', '', 'Unrelated content about kangaroos.', ''
].join('\n'))
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }))

const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO })
const page = await app.firstWindow()
const consoleErrors = []
// twthumb:// loads fail by design until a slide's preview has rendered (the card falls back
// to its schematic label) — resource-load failures are not renderer errors.
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text()) })
await page.waitForLoadState('domcontentloaded'); await page.waitForTimeout(1200)

try {
  await page.locator('.talk-item', { hasText: 'Alpha Talk' }).first().click()
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  await page.waitForTimeout(400)

  // ── open + chrome ──
  await page.keyboard.press('Meta+k')
  // Gate-4 badge honesty: while an id's counts are still being fetched the stamped card may
  // show ONLY the silent skeleton pill; the dashed 'no versions yet' badge must never appear
  // for vfixt (which HAS versions) — dashed means a fetch confirmed zero. Poll through the
  // ripening window (cards render ~400ms, counts land ≥300ms later via the idle sweep).
  const ripen = await page.evaluate(() => new Promise((resolve) => {
    const t0 = Date.now(); let sawSkeleton = false; let sawNovers = false
    const tick = () => {
      if (document.querySelector('.lt-vbadge-sk')) sawSkeleton = true
      if (document.querySelector('.lt-vbadge.novers')) sawNovers = true
      if (Date.now() - t0 > 1100) return resolve({ sawSkeleton, sawNovers })
      setTimeout(tick, 30)
    }
    tick()
  }))
  record('badge is silent (skeleton pill) before counts arrive; dashed badge never lies',
    ripen.sawSkeleton && !ripen.sawNovers, JSON.stringify(ripen))
  record('⌘K opens the Slide Browser overlay', await page.locator('.lt-browser-root').count() === 1)
  record('room label reads Slide Browser', (await page.locator('.lt-room').textContent()) === 'Slide Browser')
  record('Focus view tab is present but disabled', await page.locator('.lt-viewtabs button[disabled]').count() === 1)
  record('search input is autofocused on open', await page.evaluate(() => document.activeElement?.closest('.lt-searchfield') != null))
  // Gate-4 micro-fix (Task 7c): ⌘K while the Browser is ALREADY open re-focuses + selects the
  // search field instead of toggling it closed. Blur search first (as arrowing into the grid
  // does), then a second ⌘K must keep the overlay open AND return focus to the search input.
  await page.locator('.lt-searchfield input').blur(); await page.waitForTimeout(100)
  record('search blurs before the re-focus test', await page.evaluate(() => document.activeElement?.closest('.lt-searchfield') == null))
  await page.keyboard.press('Meta+k'); await page.waitForTimeout(200)
  record('⌘K while open keeps the Browser open and re-focuses the search input',
    (await page.locator('.lt-browser-root').count()) === 1 &&
    (await page.evaluate(() => document.activeElement?.closest('.lt-searchfield') != null)))
  const cards = () => page.locator('.lt-card:not(.skeleton)').count()
  await page.waitForTimeout(500)
  const all = await cards()
  record('empty query lays out all slides grouped', all >= 5, `cards=${all}`)
  record('groups carry talk · section heads', await page.locator('.lt-group-head .lt-g-talk').count() >= 3)
  record('index rail lists both talks', await page.locator('.lt-rail .lt-talk-row').count() === 2)

  // ── search narrows + zero results ──
  await page.locator('.lt-searchfield input').fill('zebracorn'); await page.waitForTimeout(600)
  record('search narrows to the body-matched slide', (await cards()) === 1, `cards=${await cards()}`)
  await page.locator('.lt-searchfield input').fill('zzzqqq'); await page.waitForTimeout(600)
  record('zero-results empty state shows with the query echoed',
    (await page.locator('.lt-empty.show h3', { hasText: 'Nothing on the table' }).count()) === 1 &&
    (await page.locator('.lt-empty.show .lt-q').textContent())?.includes('zzzqqq'))
  await page.locator('.lt-empty.show .lt-btn', { hasText: 'Clear search' }).click(); await page.waitForTimeout(600)
  record('Clear search restores the full table', (await cards()) === all, `cards=${await cards()}`)

  // ── filter chips ──
  await page.locator('.lt-chip', { hasText: 'Talk…' }).click(); await page.waitForTimeout(200)
  await page.locator('.lt-pop.open .lt-opt', { hasText: 'Alpha Talk' }).click(); await page.waitForTimeout(400)
  record('Talk chip filters to one talk', (await page.locator('.lt-g-talk', { hasText: 'Beta Talk' }).count()) === 0 && (await cards()) > 0)
  record('active Talk chip renders .on with ⨯', await page.locator('.lt-chip.on', { hasText: 'Talk: Alpha Talk' }).count() === 1)
  record('Clear-all dashed chip appears when a filter is active', await page.locator('.lt-chip.lt-clear-all.show').count() === 1)
  await page.keyboard.press('Escape') // closes the talk popover
  await page.locator('.lt-chip', { hasText: 'Content only' }).click(); await page.waitForTimeout(400)
  const contentOnly = await cards()
  record('Content-only chip changes the set', contentOnly !== all && contentOnly > 0, `all=${all} contentOnly=${contentOnly}`)
  await page.locator('.lt-chip.lt-clear-all').click(); await page.waitForTimeout(400)
  record('Clear all filters restores the table', (await cards()) === all && (await page.locator('.lt-chip.on').count()) === 0)

  // ── index rail: section scoping + collapse ──
  await page.locator('.lt-sec-row', { hasText: 'Deep dive' }).click(); await page.waitForTimeout(400)
  record('rail section click scopes the grid to that section',
    (await page.locator('.lt-g-section', { hasText: 'Deep dive' }).count()) === 1 && (await page.locator('.lt-g-section', { hasText: 'Intro' }).count()) === 0)
  record('scoped section row highlights .current', await page.locator('.lt-sec-row.current').count() === 1)
  await page.locator('.lt-sec-row.current').click(); await page.waitForTimeout(300)
  record('clicking the section again clears the scope', (await page.locator('.lt-sec-row.current').count()) === 0)
  await page.locator('.lt-searchfield input').blur()
  await page.keyboard.press('i'); await page.waitForTimeout(400)
  record('I collapses the rail (reopen handle shows)', await page.evaluate(() =>
    document.querySelector('.lt-rail')?.classList.contains('collapsed') && document.querySelector('.lt-rail-reopen')?.classList.contains('show')))
  await page.keyboard.press('i'); await page.waitForTimeout(400)
  record('I reopens the rail', await page.evaluate(() => !document.querySelector('.lt-rail')?.classList.contains('collapsed')))

  // ── density ──
  await page.keyboard.press('5'); await page.waitForTimeout(200)
  record('density key 5 switches the grid to g5', await page.locator('.lt-grid.g5').count() >= 1)
  record('density persists to localStorage', await page.evaluate(() => window.localStorage.getItem('tw-browser-density') === '5'))
  await page.locator('.lt-density .lt-steps button', { hasText: '3' }).click(); await page.waitForTimeout(200)
  record('topbar density step works', await page.locator('.lt-grid.g3').count() >= 1)

  // ── keyboard selection + Esc ladder ──
  await page.keyboard.press('ArrowDown'); await page.waitForTimeout(150)
  record('arrow nav focuses a card (search blurred)', await page.locator('.lt-card.focused').count() === 1 &&
    await page.evaluate(() => document.activeElement?.closest('.lt-searchfield') == null))
  await page.keyboard.press('x'); await page.waitForTimeout(150)
  record('X selects the active card (sel-mark tick)', await page.locator('.lt-card.selected').count() === 1)
  await page.keyboard.press('s'); await page.waitForTimeout(150)
  const secSel = await page.locator('.lt-card.selected').count()
  record('S selects the whole section', secSel >= 2, `selected=${secSel}`)
  await page.keyboard.press('Escape'); await page.waitForTimeout(150)
  record('Esc first clears the selection', await page.locator('.lt-card.selected').count() === 0 && await page.locator('.lt-browser-root').count() === 1)

  // ── Space preview ──
  await page.keyboard.press(' '); await page.waitForTimeout(250)
  record('Space opens the preview lightbox', await page.locator('.preview-lightbox').count() === 1)
  await page.keyboard.press('Escape'); await page.waitForTimeout(200)
  record('Esc closes the preview (browser stays)', await page.locator('.preview-lightbox').count() === 0 && await page.locator('.lt-browser-root').count() === 1)

  // ── version filmstrip (A3): badge → strip → version-insert ──
  const alphaOutline = join(alpha, 'alpha-talk-outline.md')
  const diskBlocks = async () => (((await page.evaluate((p) => window.tw.talk.readOutline(p), alphaOutline)) || '').match(/^#{2,3} /gm) || []).length
  record('only the stamped card carries a version badge', (await page.locator('.lt-vbadge').count()) === 1 && all >= 5)
  await page.waitForTimeout(1000) // idle badge-count prefill (one id, one IPC round-trip)
  const badgeText = (await page.locator('.lt-vbadge').textContent()) || ''
  record('badge ripens to the recorded version count', badgeText.includes('2 versions'), `badge="${badgeText}"`)
  record('single-talk id hides the · talks span', (await page.locator('.lt-vbadge span.long').count()) === 0)
  await page.locator('.lt-vbadge').click(); await page.waitForTimeout(700)
  record('badge click opens the filmstrip row', await page.locator('.lt-strip-row.open').count() === 1)
  record('expanded card carries .expanded', await page.locator('.lt-card.expanded').count() === 1)
  record('strip head shows the mono id', (await page.locator('.lt-sh-id').textContent()) === 'id=vfixt')
  record('two version prints, newest first', await page.locator('.lt-vprint').count() === 2)
  record('canonical star sits on the sealed older version, not the unsealed head', await page.evaluate(() => {
    const prints = [...document.querySelectorAll('.lt-vprint')]
    return prints.length === 2 && !prints[0].classList.contains('canonical') && prints[1].classList.contains('canonical')
  }))
  record('seal lines derive current session / sealed by presenting', await page.evaluate(() => {
    const seals = [...document.querySelectorAll('.lt-vseal')].map((e) => e.textContent)
    return seals[0] === 'current session' && seals[1] === 'sealed by presenting'
  }))
  record('canonical date line carries · canonical', ((await page.locator('.lt-vprint.canonical .lt-vdate').textContent()) || '').includes('· canonical'))
  const preVer = await diskBlocks()
  await page.locator('.lt-vprint').nth(0).hover()
  await page.locator('.lt-vprint').nth(0).locator('.lt-vact:not(.lt-vact-adopt)').click(); await page.waitForTimeout(300)
  record('version-insert flashes Inserted ✓ and keeps the Browser open',
    (await page.locator('.lt-vprint').nth(0).locator('.lt-vact:not(.lt-vact-adopt)').textContent()) === 'Inserted ✓' &&
    await page.locator('.lt-browser-root').count() === 1)
  await page.waitForTimeout(900)
  record('the version block landed on disk', (await diskBlocks()) - preVer === 1, `blocks ${preVer} -> ${await diskBlocks()}`)
  record('flash reverts to Insert this version ↵', (await page.locator('.lt-vprint').nth(0).locator('.lt-vact:not(.lt-vact-adopt)').textContent()) === 'Insert this version ↵')
  await page.keyboard.press('Escape'); await page.waitForTimeout(400)
  record('Esc closes the strip (Browser stays)', await page.locator('.lt-strip-row').count() === 0 && await page.locator('.lt-browser-root').count() === 1)

  // ── selection action tray + multi-select insert (⌘↵, contract preserved from SearchPalette) ──
  const beforeBlocks = await diskBlocks()
  await page.locator('.lt-card').nth(0).click()
  await page.locator('.lt-card').nth(1).click({ modifiers: ['Shift'] })
  await page.waitForTimeout(150)
  const picked = await page.locator('.lt-card.selected').count()
  record('click + ⇧-click builds a range selection', picked === 2, `selected=${picked}`)
  record('action tray floats in with the selection', await page.locator('.lt-tray').count() === 1)
  record('tray count, word and primary label read the selection', await page.evaluate(() => {
    const n = document.querySelector('.lt-tray .lt-n')?.textContent
    const w = document.querySelector('.lt-tray .lt-w')?.textContent
    const b = document.querySelector('.lt-tray .lt-btn.primary')?.textContent || ''
    const hint = document.querySelector('.lt-tray .lt-t-hint')?.textContent || ''
    return n === '2' && w === 'slides selected' && b.includes('Insert 2 selected at caret') && hint.includes('⇧-click for a range')
  }))
  await page.locator('.lt-tray .lt-t-clear').click(); await page.waitForTimeout(200)
  record('tray Clear empties the selection and hides the tray',
    await page.locator('.lt-card.selected').count() === 0 && await page.locator('.lt-tray').count() === 0)
  await page.locator('.lt-card').nth(0).click(); await page.waitForTimeout(150)
  record('singular tray copy for one slide', ((await page.locator('.lt-tray .lt-w').textContent()) || '') === 'slide selected')
  await page.locator('.lt-card').nth(1).click({ modifiers: ['Shift'] }); await page.waitForTimeout(150)
  await page.keyboard.press('Meta+Enter'); await page.waitForTimeout(900)
  record('⌘↵ inserts the selection and closes the Browser', await page.locator('.lt-browser-root').count() === 0)
  const afterBlocks = await diskBlocks()
  record('2 slide blocks inserted on disk', afterBlocks - beforeBlocks === 2, `blocks ${beforeBlocks} -> ${afterBlocks}`)

  // ── Esc closes from a clean state ──
  await page.keyboard.press('Meta+k'); await page.waitForTimeout(600)
  await page.keyboard.press('Escape'); await page.waitForTimeout(300)
  record('Esc closes the Browser when nothing is staged', await page.locator('.lt-browser-root').count() === 0)

  // ── REAL twthumb:// prints once previews have rendered ──
  await page.evaluate((p) => window.tw.talk.readOutline(p).then((c) => window.tw.talk.thumbnails(p, c)), alphaOutline)
  await page.keyboard.press('Meta+k'); await page.waitForTimeout(900)
  const realThumbs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.lt-thumb img')).filter((i) => i.complete && i.naturalWidth > 0).length)
  record('cards show REAL twthumb:// images once previews exist', realThumbs > 0, `loaded=${realThumbs}`)
  await page.keyboard.press('Escape'); await page.waitForTimeout(200)

  // ── propagation checklist (A5, Task 7): behind + diverged targets, drive an adopt ──
  // Written to disk mid-run: slideStatus scans the vault fresh per call, so no rescan is
  // needed — and the earlier badge/rail assertions stay untouched by these extra carriers.
  const gamma = join(vault, 'topic-z', 'gamma-talk'); const delta = join(vault, 'topic-z', 'delta-talk')
  mkdirSync(gamma, { recursive: true }); mkdirSync(delta, { recursive: true })
  const gammaOutline = join(gamma, 'gamma-talk-outline.md'); const deltaOutline = join(delta, 'delta-talk-outline.md')
  // gamma carries the OLDER sealed version's exact block → judged 'behind'
  writeFileSync(gammaOutline, [
    '---', 'title: Gamma Talk', '---', '',
    '## Reuse', '',
    '### Pricing note {id=vfixt}', '', 'An earlier, sealed take on pricing.', ''
  ].join('\n'))
  // delta carries wording no recorded version has → judged 'diverged'
  writeFileSync(deltaOutline, [
    '---', 'title: Delta Talk', '---', '',
    '## Reuse', '',
    '### Pricing note', '{statement} {id=vfixt}', '', 'A delta-specific pricing take.', ''
  ].join('\n'))
  const gammaRel = 'topic-z/gamma-talk/gamma-talk-outline.md'
  const deltaRel = 'topic-z/delta-talk/delta-talk-outline.md'

  await page.keyboard.press('Meta+k'); await page.waitForTimeout(900)
  await page.locator('.lt-vbadge').first().click(); await page.waitForTimeout(700)
  record('adopt entry: filmstrip prints carry the secondary Adopt action', (await page.locator('.lt-vact-adopt').count()) >= 2)
  await page.locator('.lt-vprint').nth(0).hover()
  await page.locator('.lt-vprint').nth(0).locator('.lt-vact-adopt').click(); await page.waitForTimeout(900)
  record('Adopt this version in… opens the checklist over the Browser',
    (await page.locator('.lt-prop-scrim .lt-panel').count()) === 1 && (await page.locator('.lt-browser-root').count()) === 1)
  record('checklist head carries the mono id and the adopting chip', await page.evaluate(() => {
    const id = document.querySelector('.lt-prop-scrim .lt-ph-id')?.textContent
    const chip = document.querySelector('.lt-prop-scrim .lt-adopting')?.textContent || ''
    return id === 'id=vfixt' && /\d{1,2} \w{3} \d{4}/.test(chip)
  }))
  const gRow = page.locator(`.lt-prop-row[data-outline="${gammaRel}"]`)
  const dRow = page.locator(`.lt-prop-row[data-outline="${deltaRel}"]`)
  record('gamma row is behind and defaults to Replace',
    (await gRow.getAttribute('data-status')) === 'behind' &&
    ((await gRow.locator('.lt-rs-toggle button.on-replace').textContent()) || '') === 'Replace')
  record('delta row is diverged and defaults to Skip',
    (await dRow.getAttribute('data-status')) === 'diverged' &&
    ((await dRow.locator('.lt-rs-toggle button.on-skip').textContent()) || '') === 'Skip')
  record('reassurance footer copy is exact',
    ((await page.locator('.lt-prop-scrim .lt-reassure').textContent()) || '').trim() === 'Nothing is lost — replaced versions stay in history.')
  const label = () => page.locator('.lt-prop-scrim .lt-btn.primary').textContent().then((t) => (t || '').trim())
  const repCount = (t) => { const m = t.match(/Replace in (\d+)/); return m ? Number(m[1]) : 0 }
  const before = await label()
  record('primary recounts replace/skip', /Replace in \d+ presentation/.test(before) && / · skip \d+/.test(before), before)
  // diff drawer on demand
  await dRow.locator('.lt-pr-diff').click(); await page.waitForTimeout(400)
  record('View diff opens the two-column drawer with honest del/add lines', await page.evaluate(() => {
    const drawer = document.querySelector('.lt-diff-drawer.open')
    if (!drawer) return false
    const heads = [...drawer.querySelectorAll('.lt-dc-head b')].map((b) => b.textContent)
    return drawer.querySelectorAll('.lt-dl.del').length > 0 && drawer.querySelectorAll('.lt-dl.add').length > 0 &&
      heads[0] === 'In Delta Talk' && heads[1] === 'Version to adopt' &&
      (drawer.querySelector('.lt-diff-note')?.textContent || '').includes('restorable any time')
  }))
  // Space flips the focused toggle: delta Skip → Replace
  await page.locator(`[data-rs-toggle][data-outline="${deltaRel}"]`).focus()
  await page.keyboard.press(' '); await page.waitForTimeout(300)
  const after = await label()
  record('Space flips delta to Replace and the primary recounts live',
    (await dRow.locator('.lt-rs-toggle button.on-replace').count()) === 1 && repCount(after) === repCount(before) + 1,
    `${before} -> ${after}`)
  // confirm ⌘↵ → loss-proof adopt on disk
  await page.keyboard.press('Meta+Enter'); await page.waitForTimeout(1500)
  record('confirm closes the checklist (Browser stays open)',
    (await page.locator('.lt-prop-scrim').count()) === 0 && (await page.locator('.lt-browser-root').count()) === 1)
  record('success toast reads Replaced in N presentations',
    ((await page.locator('[role="status"]').allTextContents()).join(' ')).includes('Replaced in'))
  const gammaNow = readFileSync(gammaOutline, 'utf8'); const deltaNow = readFileSync(deltaOutline, 'utf8')
  record('behind target replaced on disk with the adopted version',
    gammaNow.includes('Converging on a single price point') && !gammaNow.includes('An earlier, sealed take'))
  record('diverged target (flipped to Replace) replaced on disk',
    deltaNow.includes('Converging on a single price point') && !deltaNow.includes('A delta-specific pricing take.'))
  const storeFiles = readdirSync(vdir).map((f) => readFileSync(join(vdir, f), 'utf8'))
  record('pre-adoption diverged wording preserved in _SLIDE-VERSIONS (nothing is lost)',
    storeFiles.some((c) => c.includes('A delta-specific pricing take.')))
  await page.keyboard.press('Escape'); await page.waitForTimeout(300)

  // ── Gate-4 g4 blowout guard: long nowrap origins/titles must never widen 1fr tracks ──
  const eps = join(vault, 'topic-z', 'epsilon-talk')
  mkdirSync(eps, { recursive: true })
  writeFileSync(join(eps, 'epsilon-talk-outline.md'), [
    '---', 'title: Epsilon Talk With An Extremely Long Wordy Title About Internationalisation Strategy And Governance', '---', '',
    '## A long section name about internationalisation strategy and governance', '',
    '### A very long slide title that rambles on about supercalifragilisticexpialidocious matters', '', 'Body one.', '',
    '### Another long slide title that likewise rambles on and on about many unrelated things', '', 'Body two.', ''
  ].join('\n'))
  // The Browser may still be open here (the Esc above lands on the strip when one is open) —
  // walk the Esc ladder fully closed, then reopen so the fresh search picks up epsilon.
  for (let i = 0; i < 5 && (await page.locator('.lt-browser-root').count()) === 1; i++) {
    await page.keyboard.press('Escape'); await page.waitForTimeout(250)
  }
  await page.keyboard.press('Meta+k'); await page.waitForTimeout(900)
  for (const d of ['2', '3', '4', '5', '6']) {
    await page.locator('.lt-density .lt-steps button', { hasText: d }).click(); await page.waitForTimeout(250)
    const m = await page.evaluate(() => {
      const t = document.querySelector('.lt-table-scroll')
      const tr = t.getBoundingClientRect()
      const counts = [...document.querySelectorAll('.lt-g-count')]
      return {
        over: t.scrollWidth - t.clientWidth,
        countsClipped: counts.filter((c) => c.getBoundingClientRect().right > tr.right).length
      }
    })
    record(`density ${d}: no horizontal blowout, group counts fully visible`,
      m.over <= 0 && m.countsClipped === 0, JSON.stringify(m))
  }
  await page.keyboard.press('Escape'); await page.waitForTimeout(300)

  // ── DUPLICATE COLLAPSE + MERGE-INTO-ONE (Task 9, ADR-0032) ──
  // Two BYTE-IDENTICAL copies of one slide across two talks (distinct term "quokka" isolates them):
  // they collapse to ONE stack card reading "in 2 talks"; its locations panel lists both copies and
  // offers Merge; the insert-time nudge offers the same; merging stamps both with one shared id on
  // disk while every bullet stays byte-for-byte.
  const zeta = join(vault, 'topic-dup', 'zeta-talk'); const eta = join(vault, 'topic-dup', 'eta-talk')
  mkdirSync(zeta, { recursive: true }); mkdirSync(eta, { recursive: true })
  const zetaOutline = join(zeta, 'zeta-talk-outline.md'); const etaOutline = join(eta, 'eta-talk-outline.md')
  const dupBlock = ['### Quokka pricing note', '', '- quokka baseline tier', '- quokka ceiling tier', '']
  writeFileSync(zetaOutline, ['---', 'title: Zeta Talk', '---', '', '## Reuse', '', ...dupBlock].join('\n'))
  writeFileSync(etaOutline, ['---', 'title: Eta Talk', '---', '', '## Pricing', '', ...dupBlock].join('\n'))

  for (let i = 0; i < 5 && (await page.locator('.lt-browser-root').count()) === 1; i++) {
    await page.keyboard.press('Escape'); await page.waitForTimeout(200)
  }
  await page.keyboard.press('Meta+k'); await page.waitForTimeout(700)
  await page.locator('.lt-searchfield input').fill('quokka'); await page.waitForTimeout(800)
  const dupCards = await page.locator('.lt-card:not(.skeleton)').count()
  record('byte-identical copies collapse to ONE stack card',
    dupCards === 1 && (await page.locator('.lt-card[data-kind="identical"].stack').count()) === 1, `cards=${dupCards}`)
  record('the stack shows the "in N talks" pill',
    ((await page.locator('.lt-clusterbadge').textContent()) || '').includes('in 2 talks'))

  // locations panel (the pill / E)
  await page.locator('.lt-clusterbadge').click(); await page.waitForTimeout(600)
  record('the pill opens the locations panel listing both copies',
    (await page.locator('.lt-loc-row').count()) === 2)
  record('locations offers Merge into one slide + a per-copy Insert + Show in Finder',
    (await page.locator('.lt-locs .lt-btn.primary', { hasText: 'Merge into one slide' }).count()) === 1 &&
    (await page.locator('.lt-loc-row .lt-loc-btn', { hasText: 'Insert this copy' }).count()) === 2 &&
    (await page.locator('.lt-loc-row .lt-loc-btn', { hasText: 'Finder' }).count()) === 2)
  await page.keyboard.press('Escape'); await page.waitForTimeout(300) // close locations

  // insert-time nudge: inserting the stack (tray path) offers to merge, and the offer survives close
  const alphaBlocksBefore = await diskBlocks()
  await page.locator('.lt-card[data-kind="identical"]').click(); await page.waitForTimeout(150)
  await page.keyboard.press('Meta+Enter'); await page.waitForTimeout(900)
  record('inserting a byte-identical stack closes the Browser and lands the slide',
    (await page.locator('.lt-browser-root').count()) === 0 && (await diskBlocks()) - alphaBlocksBefore === 1)
  const nudgeText = (await page.locator('[role="status"]').allTextContents()).join(' ')
  record('insert-time merge nudge appears with a Merge action',
    nudgeText.includes('identical to 1 other') &&
    (await page.locator('[role="status"] button', { hasText: 'Merge into one' }).count()) === 1, nudgeText)

  // the nudge action opens the confirm even though the Browser is closed
  await page.locator('[role="status"] button', { hasText: 'Merge into one' }).click(); await page.waitForTimeout(700)
  record('the nudge Merge action opens the confirm above everything',
    (await page.locator('.lt-merge-scrim .lt-panel').count()) === 1)
  record('confirm title + byte-identical body name both talks', await page.evaluate(() => {
    const h = document.querySelector('.lt-merge-scrim .lt-panel-head h2')?.textContent || ''
    const sub = document.querySelector('.lt-merge-scrim .lt-panel-sub')?.textContent || ''
    return h === 'Merge 2 identical copies into one slide?' && sub.includes('Zeta Talk') && sub.includes('Eta Talk')
  }))
  await page.locator('.lt-merge-scrim .lt-btn.primary', { hasText: 'Merge' }).click(); await page.waitForTimeout(1500)
  record('merge closes the confirm and toasts the count',
    (await page.locator('.lt-merge-scrim').count()) === 0 &&
    ((await page.locator('[role="status"]').allTextContents()).join(' ')).includes('Merged 2 copies into one slide'))

  // disk: both outlines now carry ONE shared id; every bullet is unchanged
  const zetaNow = readFileSync(zetaOutline, 'utf8'); const etaNow = readFileSync(etaOutline, 'utf8')
  const idRe = /\{id=([A-Za-z0-9_-]+)\}/
  const zetaId = (zetaNow.match(idRe) || [])[1]; const etaId = (etaNow.match(idRe) || [])[1]
  record('both outlines now carry the SAME shared ledger id', Boolean(zetaId) && zetaId === etaId, `zeta=${zetaId} eta=${etaId}`)
  record('merge changed no slide content (every bullet intact, byte-for-byte)',
    zetaNow.includes('- quokka baseline tier') && zetaNow.includes('- quokka ceiling tier') &&
    etaNow.includes('- quokka baseline tier') && etaNow.includes('- quokka ceiling tier'))

  // post-merge the stack reads "already one slide" — the merge action retires
  await page.keyboard.press('Meta+k'); await page.waitForTimeout(700)
  await page.locator('.lt-searchfield input').fill('quokka'); await page.waitForTimeout(800)
  await page.locator('.lt-clusterbadge').first().click(); await page.waitForTimeout(500)
  record('post-merge locations reads "already one slide" and drops the merge action',
    (await page.locator('.lt-loc-oneslide').count()) === 1 &&
    (await page.locator('.lt-locs .lt-btn.primary', { hasText: 'Merge into one slide' }).count()) === 0)
  for (let i = 0; i < 4 && (await page.locator('.lt-browser-root').count()) === 1; i++) {
    await page.keyboard.press('Escape'); await page.waitForTimeout(200)
  }

  // ── NEAR-IDENTICAL (now reachable, keyed on engine identity): two slides with the SAME content_hash
  // (the projection lowercases + whitespace-collapses + strips markdown) but DIFFERENT engine identity
  // (case is preserved) — "wombat" copies differing only in bullet case. They must collapse as NEAR
  // (fanned/amber), offer NO merge, and Uncollapse (U) must reveal the variants in place.
  const theta = join(vault, 'topic-dup', 'theta-talk'); const iota = join(vault, 'topic-dup', 'iota-talk')
  mkdirSync(theta, { recursive: true }); mkdirSync(iota, { recursive: true })
  writeFileSync(join(theta, 'theta-talk-outline.md'),
    ['---', 'title: Theta Talk', '---', '', '## Notes', '', '### Wombat overview', '', '- Shared Detail Here', ''].join('\n'))
  writeFileSync(join(iota, 'iota-talk-outline.md'),
    ['---', 'title: Iota Talk', '---', '', '## Notes', '', '### Wombat overview', '', '- shared detail here', ''].join('\n'))
  await page.keyboard.press('Meta+k'); await page.waitForTimeout(700)
  await page.locator('.lt-searchfield input').fill('wombat'); await page.waitForTimeout(800)
  const wombatCards = await page.locator('.lt-card:not(.skeleton)').count()
  record('case-only variants (same content_hash, different engine identity) collapse as NEAR — fanned/amber',
    wombatCards === 1 && (await page.locator('.lt-card.nearstack[data-kind="near"]').count()) === 1 &&
    (await page.locator('.lt-card.stack').count()) === 0, `cards=${wombatCards}`)
  record('a near cluster offers NO merge action (no cluster pill, an Uncollapse control instead)',
    (await page.locator('.lt-clusterbadge').count()) === 0 && (await page.locator('.lt-nearbadge').count()) === 1)
  // Uncollapse with U (blur search first so the grid key handler runs).
  await page.locator('.lt-searchfield input').blur(); await page.waitForTimeout(100)
  await page.keyboard.press('u'); await page.waitForTimeout(400)
  record('U uncollapses the near cluster into its variants in place',
    (await page.locator('.lt-card[data-kind="near-variant"]').count()) === 2 &&
    (await page.locator('.lt-clusterbadge').count()) === 0)
  record('uncollapsed near variants still offer no Merge action',
    (await page.locator('.lt-btn.primary', { hasText: 'Merge into one slide' }).count()) === 0)
  await page.keyboard.press('u'); await page.waitForTimeout(400)
  record('U re-collapses the variants back to one near card',
    (await page.locator('.lt-card.nearstack').count()) === 1 &&
    (await page.locator('.lt-card[data-kind="near-variant"]').count()) === 0)
  for (let i = 0; i < 4 && (await page.locator('.lt-browser-root').count()) === 1; i++) {
    await page.keyboard.press('Escape'); await page.waitForTimeout(200)
  }

  // Genuinely different slides (distinct words → distinct content_hash AND identity) stay two singles.
  const kappa = join(vault, 'topic-dup', 'kappa-talk'); const lambdaT = join(vault, 'topic-dup', 'lambda-talk')
  mkdirSync(kappa, { recursive: true }); mkdirSync(lambdaT, { recursive: true })
  writeFileSync(join(kappa, 'kappa-talk-outline.md'),
    ['---', 'title: Kappa Talk', '---', '', '## Notes', '', '### Platypus note', '', '- platypus one detail', ''].join('\n'))
  writeFileSync(join(lambdaT, 'lambda-talk-outline.md'),
    ['---', 'title: Lambda Talk', '---', '', '## Notes', '', '### Platypus note', '', '- platypus two detail', ''].join('\n'))
  await page.keyboard.press('Meta+k'); await page.waitForTimeout(700)
  await page.locator('.lt-searchfield input').fill('platypus'); await page.waitForTimeout(800)
  const platyCards = await page.locator('.lt-card:not(.skeleton)').count()
  record('genuinely different slides are NOT collapsed (two singles, no stack/nearstack)',
    platyCards === 2 && (await page.locator('.lt-card.nearstack').count()) === 0 &&
    (await page.locator('.lt-card.stack').count()) === 0, `cards=${platyCards}`)
  for (let i = 0; i < 4 && (await page.locator('.lt-browser-root').count()) === 1; i++) {
    await page.keyboard.press('Escape'); await page.waitForTimeout(200)
  }

  // ── SCOPED SEARCH OPERATORS (t:/s:/i:/e:) + title-priority ranking ──
  // Dominik's bug: `t:about me` searched the literal string and found nothing. Fixture: one slide
  // TITLED "About me" (title only), a DIFFERENT slide ("Colophon") with "about me" only in its
  // BODY; an exact-phrase pair; and a ranking pair whose body-match precedes its title-match in
  // file order (so ranking is observable). Distinctive nonces (zqbodyword/zqrank) isolate the
  // scoped assertions from every earlier fixture talk in the vault.
  const about = join(vault, 'topic-about', 'about-talk')
  mkdirSync(about, { recursive: true })
  writeFileSync(join(about, 'about-talk-outline.md'), [
    '---', 'title: About Talk', '---', '',
    '## Profile', '',
    '### About me', '', 'Biographical notes only.', '',
    '### Colophon', '', 'This mentions zqbodyword and is about me in the body only.', '',
    '## Phrases', '',
    '### Phrase kept', '', 'Here is an exact phrase kept together.', '',
    '### Scattered words', '', 'This is exact, but the other word phrase sits far away.', '',
    '## Ranking', '',
    '### Ordinary title', '', 'The zqrank word appears only in body here.', '',
    '### zqrank heading', '', 'Plain body content here.', ''
  ].join('\n'))

  const nCards = () => page.locator('.lt-card:not(.skeleton)').count()
  const titleShown = (t) => page.locator('.lt-card:not(.skeleton) .lt-l-title', { hasText: t }).count()
  const search = async (q) => { await page.locator('.lt-searchfield input').fill(q); await page.waitForTimeout(800) }

  await page.keyboard.press('Meta+k'); await page.waitForTimeout(700)
  record('search placeholder advertises the operators', await page.evaluate(() =>
    (document.querySelector('.lt-searchfield input')?.getAttribute('placeholder') || '')
      .includes('t: title') && document.querySelector('.lt-searchfield input').getAttribute('placeholder').includes('e: exact')))

  // THE BUG: t: constrains to the title. Only the slide TITLED "About me" matches; the body-only
  // "Colophon" slide does NOT (it would under a loose whole-string search).
  await search('t:about me')
  record('t:about me returns the TITLED slide (the exact bug — now works)', (await titleShown('About me')) === 1)
  record('t:about me does NOT return the body-only slide (title scope excludes body)',
    (await titleShown('Colophon')) === 0)

  // s: constrains to the slide body — the body-only "Colophon" IS reachable there.
  await search('s:about')
  record('s:about (body scope) reaches the body-only slide', (await titleShown('Colophon')) >= 1)
  await search('s:zqbodyword')
  record('s:<body-only nonce> matches exactly the body slide', (await nCards()) === 1 && (await titleShown('Colophon')) === 1,
    `cards=${await nCards()}`)

  // e: exact phrase — contiguous only. Plain (no operator) is all-words: both the contiguous slide
  // and the scattered one match; e:"…" keeps only the contiguous one.
  await search('exact phrase')
  const plainExact = await nCards()
  record('plain "exact phrase" (all-words) matches both the contiguous and the scattered slide', plainExact === 2, `cards=${plainExact}`)
  await search('e:"exact phrase"')
  record('e:"exact phrase" matches ONLY the contiguous phrase, not scattered words',
    (await nCards()) === 1 && (await titleShown('Phrase kept')) === 1 && (await titleShown('Scattered words')) === 0,
    `cards=${await nCards()}`)

  // Title-priority ranking: for a plain query hitting one slide's TITLE and another's BODY, the
  // title hit surfaces first even though the body hit precedes it in file order.
  await search('zqrank')
  record('default zqrank ranks the title-hit slide FIRST (body-hit precedes it in file order)',
    (await nCards()) === 2 &&
    (await page.locator('.lt-card:not(.skeleton) .lt-l-title').first().textContent()) === 'zqrank heading',
    `first="${await page.locator('.lt-card:not(.skeleton) .lt-l-title').first().textContent()}"`)

  // i: image-text scope is isolated to OCR text. This fixture has no images with OCR, so a body
  // word under i: matches nothing — proving i: does not leak into title/body. (A positive OCR
  // match needs an image + the OCR helper; that path is covered by diagnose-ocr.mjs, which drives
  // the same slideOcrText through the all-scope search.)
  await search('i:zqbodyword')
  record('i:<body word> matches nothing (image scope is OCR-only, no leak into body)', (await nCards()) === 0,
    `cards=${await nCards()}`)

  // Scope-aware zero-results copy.
  await search('t:zzznotitleanywhere')
  record('scoped zero-results copy names the scope (title)',
    ((await page.locator('.lt-empty.show p').first().textContent()) || '').includes('in the title'))
  await page.locator('.lt-searchfield input').fill('')
  for (let i = 0; i < 4 && (await page.locator('.lt-browser-root').count()) === 1; i++) {
    await page.keyboard.press('Escape'); await page.waitForTimeout(200)
  }

  record('no renderer console errors during the run', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
} catch (e) {
  record('browser harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.p)
  console.log(`\n=== BROWSER SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
