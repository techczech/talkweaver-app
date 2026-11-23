// Look review of PR 469 (redesign slice 4). Hidden Electron, synthetic talks.
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'
import { scratchVault } from './lib/scratch-vault.mjs'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'

const root = resolve('.')
const out = resolve(process.env.TW_REVIEW_SHOTS || join(root, '.tw-review-look-469'))
const matrixOnly = process.env.TW_REVIEW_MATRIX_ONLY === '1'
mkdirSync(out, { recursive: true })
const sleep = ms => new Promise(done => setTimeout(done, ms))
async function until(check, ms = 12000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await check()) return true; await sleep(100) }
  return false
}
const log = { steps: [], errors: [], facts: {}, page: [] }
const fact = (key, value) => { log.facts[key] = value; console.log('FACT', key, JSON.stringify(value)) }
const save = () => writeFileSync(join(out, '_log.json'), JSON.stringify(log, null, 1))

// New: the way the app's own New talk and New slide write a talk. Old: a talk from before the redesign.
function talkSource(kind) {
  const list = kind === 'new' ? ['{list}'] : []
  const slide = (title, id, ...body) => [`### ${title} {id=${id}}`, ...list, '', ...body, '']
  return [
    '---', 'title: "Community garden update"', 'outline_version: 2', 'author: Maya Green',
    ...(kind === 'new' ? ['defaults:', '  title: top'] : []), '---', '',
    '## This year {id=s1}', '',
    ...slide('What we grew', 'w1', '- Tomatoes and beans did well', '- Not one bad week of weather', '- Sixty kilos shared with the food bank'),
    '### Watering rota {id=t1}', '{table}', '', '| Day | Morning | Evening |', '| --- | --- | --- |', '| Monday | Maya | Tom |', '| Tuesday | Asha | Lee |', '| Wednesday | Priya | Sam |', '',
    '## Next season {id=s2}', '',
    ...slide('Three priorities', 'p4k2m', '- Repair the beds', '- Share the tools', '- Welcome new growers', '', '![Garden beds](assets/garden-beds.png)'),
    ...slide('Where we organise', 'o1', '- WhatsApp for the rota', '- Google Sheets for the seed list', '- Zoom for the winter meeting'),
    ...slide('Jobs for Saturday morning and who has already said yes to each one', 'j1', '- Turn the compost', '  - Tom and Lee', '- Mend the fence', '  - Asha', '- Paint the shed', '  - Nobody yet'),
    '### Dates for the diary {id=d1}', '{carousel}', '',
    '#### 6 March: work day {id=d1a}', '', '- Bring gloves', '',
    '#### 20 March: seed swap {id=d1b}', '', '- Bring seeds to share', '',
    '#### 3 April: open morning {id=d1c}', '', '- Bring a friend', '',
    '### What a member said {id=q1}', '{quote}', '', 'The garden is the one place where I talk to my neighbours.', '', '— Asha, plot 14', '',
    '### How the year runs {id=tl1}', '{timeline}', '', '- March: beds open', '- June: first harvest', '- October: closing day', '',
    '### Come on Saturday {id=st1}', '{statement}', '', 'Everyone is welcome, tools are provided.', '',
    '### A slide without an id', ...list, '', '- First point', '- Second point', '',
    '### {id=e1}', '{list}', '', '',
    '### A code nobody knows {id=u1}', '{sparkle}', '', '- One', '- Two', ''
  ].join('\n')
}

async function run(kind, body) {
  using fixture = scratchVault('tw-look-469-')
  const vault = join(fixture.root, 'vault')
  const profile = join(fixture.root, 'profile')
  const talk = join(vault, 'garden')
  const outline = join(talk, 'garden-outline.md')
  const source = talkSource(kind)
  mkdirSync(join(talk, 'assets'), { recursive: true })
  mkdirSync(profile)
  writeFileSync(outline, source)
  copyFileSync(join(root, 'demo-vault/layout-sampler/assets/sample-image.png'), join(talk, 'assets/garden-beds.png'))
  writeFileSync(join(profile, 'config.json'), JSON.stringify({ vaultRoot: vault }))
  const env = { TW_E2E: '1' }
  for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'SHELL', 'DISPLAY']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  const disk = () => readFileSync(outline, 'utf8')
  const trigger = id => { const lines = disk().split('\n'); const at = lines.findIndex(line => line.includes(`{id=${id}}`)); return at < 0 ? null : lines.slice(at, at + 2) }
  const app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: root, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', error => { log.page.push(error.message); console.error('PAGEERROR', error.message) })
    page.setDefaultTimeout(8000)
    const setSize = async (w, h) => {
      await app.evaluate(({ BrowserWindow }, size) => {
        for (const win of BrowserWindow.getAllWindows()) win.setContentSize(size.w, size.h)
      }, { w, h })
      await page.waitForFunction(({ w, h }) => innerWidth === w && innerHeight === h, { w, h })
    }
    const setTheme = async theme => {
      await app.evaluate(({ nativeTheme }, value) => { nativeTheme.themeSource = value }, theme)
      await page.emulateMedia({ colorScheme: theme })
      await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme)
    }
    const comeBack = () => app.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) win.emit('focus') })
    await app.evaluate(({ session }) => {
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, reply) => reply({ cancel: true }))
    })
    assert.ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(win => !win.isVisible())))
    await setSize(1440, 900)
    const ctx = { tag: kind === 'new' ? 'N-L1440' : 'O' }
    const shot = async name => { await sleep(350); await page.screenshot({ path: join(out, `${ctx.tag}-${name}.png`) }); log.steps.push(`${ctx.tag}-${name}`) }
    const inspector = page.locator('.tw-inspector')
    const who = inspector.locator('.tw-right-who strong')
    const sheet = page.locator('[data-testid="outline-merge-sheet"]')
    const clear = async () => {
      for (let i = 0; i < 4; i++) {
        if (await page.locator('[data-plain-icon-picker]').count()) await page.keyboard.press('Escape')
        const dialog = page.locator('dialog[open]')
        if (await dialog.count()) {
          const close = dialog.getByRole('button', { name: /^(Close|Put it back)$/ }).first()
          if (await close.count()) await close.click().catch(() => {}); else await page.keyboard.press('Escape')
        } else if (await sheet.count()) await sheet.getByRole('button', { name: /Keep the changes|Stay here/ }).last().click().catch(() => {})
        else break
        await sleep(900)
      }
    }
    const step = async (name, work) => {
      try { await clear(); await work(); console.log('ok  ', ctx.tag, name) } catch (error) {
        log.errors.push({ tag: ctx.tag, name, message: String(error.message) })
        console.error('FAIL', ctx.tag, name, String(error.message).slice(0, 260))
        await page.screenshot({ path: join(out, `${ctx.tag}-ERR-${name}.png`) }).catch(() => {})
      }
      save()
    }
    const away = async () => { await page.mouse.move(640, 300); await sleep(450) }
    const slideTab = async () => { await page.getByRole('tab', { name: 'Slide', exact: true }).click().catch(() => {}); await sleep(200) }
    const home = async () => {
      await away(); await slideTab()
      const back = inspector.getByRole('button', { name: 'Back', exact: true })
      if (await back.count() && await back.first().isVisible()) await back.first().click()
    }
    const goto = async title => {
      await home()
      const at = async () => ((await who.textContent()) ?? '').startsWith(title)
      const prev = inspector.getByRole('button', { name: 'Previous slide', exact: true })
      for (let i = 0; i < 30 && !await at() && await prev.isEnabled(); i++) { await prev.click(); await sleep(80) }
      for (let i = 0; i < 30 && !await at(); i++) { await inspector.getByRole('button', { name: 'Next slide', exact: true }).click(); await sleep(120) }
      if (!await at()) throw new Error('slide not reached: ' + title)
      await sleep(500)
    }
    const pictures = async (min = 1, ms = 12000) => until(async () => await inspector.locator('.tw-right-picture-frame img').count() >= min, ms)
    const openPage = async label => {
      await home()
      await inspector.locator('.tw-right-adjust').getByRole('button', { name: new RegExp('^' + label) }).click()
      await sleep(300)
    }
    const pic = (label, within = inspector) => within.locator('.tw-right-picture').filter({ has: page.locator('strong', { hasText: new RegExp('^' + label + '$') }) }).first()
    const marks = async key => fact(key, await inspector.locator('.tw-right-picture').evaluateAll(nodes => nodes.map(node =>
      `${node.querySelector('strong')?.textContent}${node.getAttribute('aria-pressed') === 'true' ? ' [current]' : ''}${node.disabled ? ' [off]' : ''}${node.querySelector('img') ? '' : ' [no picture]'}`)))
    const text = async key => { fact(key, (await inspector.innerText()).replace(/\n+/g, ' | ').slice(0, 1400)) }
    const scrollPane = top => page.evaluate(value => { const pane = document.querySelector('.tw-inspector-pane'); if (pane) pane.scrollTop = value }, top)
    const keep = async label => { const before = disk(); await pic(label).click(); const saved = await until(() => disk() !== before, 5000); await sleep(900); await away(); return saved }
    const outside = async (name, next) => {
      writeFileSync(outline, next); await sleep(400); await comeBack(); await sleep(1300)
      await shot(name + '-noticed')
      const shown = await until(async () => await page.locator('dialog[open]').count() + await sheet.count() > 0, 9000)
      fact(`${ctx.tag}-${name}-shown`, shown); await sleep(2200); await shot(name + '-review')
      return shown
    }

    await page.locator('[data-talk-slug="garden"]').first().dblclick()
    await inspector.waitFor({ timeout: 30000 })
    await who.first().waitFor()
    await sleep(1200)
    await page.getByRole('tab', { name: 'Slides', exact: true }).click().catch(async () => { await page.getByRole('button', { name: 'Slides', exact: true }).first().click().catch(() => {}) })
    await sleep(1200)
    await body({ page, app, ctx, shot, inspector, who, sheet, step, away, home, goto, pictures, openPage, pic, marks, text, scrollPane, keep, outside, disk, trigger, source, setSize, setTheme, slideTab, outline })
  } finally {
    save()
    // A talk left with a pending outside change holds its close for a person's answer: never wait on it.
    const child = app.process()
    await Promise.race([app.close().catch(() => {}), sleep(8000)])
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
}

await ensureFreshBuild(root)

await run('new', async t => {
  const { page, ctx, shot, inspector, who, sheet, step, away, home, goto, pictures, openPage, pic, marks, text, scrollPane, keep, outside, disk, trigger, source } = t
  async function tour(full) {
    await step('home', async () => {
      await goto('Three priorities'); fact(`${ctx.tag}-home-pictures`, await pictures(4)); await sleep(700); await shot('02-home'); await marks(`${ctx.tag}-home-marks`); await text(`${ctx.tag}-home`)
      await assertDesignHeadingFits(inspector)
    })
    await step('title', async () => { await openPage('Title'); await pictures(8); await sleep(1200); await shot('03-title'); await marks(`${ctx.tag}-title-marks`); await scrollPane(9999); await shot('03-title-foot') })
    await step('points', async () => { await openPage('Points'); await pictures(4); await sleep(900); await shot('04-points'); await marks(`${ctx.tag}-points-marks`) })
    await step('icons', async () => { await openPage('Icons'); await pictures(2); await sleep(900); await shot('05-icons'); await marks(`${ctx.tag}-icons-marks`) })
    await step('picture', async () => { await openPage('Picture'); await pictures(2); await sleep(900); await shot('06-picture'); await marks(`${ctx.tag}-picture-marks`) })
    await step('copy', async () => {
      await openPage('Title')
      await clickCopyWithFrameLog(page, inspector.getByRole('button', { name: 'Copy for agent', exact: true }).first(), ctx.tag)
      const field = page.getByRole('textbox', { name: 'Request for agent', exact: true })
      await until(async () => (await field.inputValue()).length > 40)
      await shot('08-copy-title'); fact(`${ctx.tag}-copy-title`, await field.inputValue())
      fact(`${ctx.tag}-copy-box`, await page.locator('dialog[open]').evaluate(node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, w: box.width, h: box.height, font: getComputedStyle(node.querySelector('p')).fontSize } }))
      await assertCentred(page.locator('dialog[open]'))
    })
    await step('list', async () => {
      await home()
      await page.getByRole('button', { name: 'Panel options', exact: true }).click(); await shot('09-panel-menu')
      await page.getByRole('button', { name: 'One long list', exact: true }).click()
      await inspector.getByRole('navigation', { name: 'Jump to' }).waitFor(); await pictures(6); await sleep(1500)
      await shot('10-list-top')
      await inspector.getByRole('navigation', { name: 'Jump to' }).getByRole('button', { name: 'Points', exact: true }).click(); await sleep(900); await shot('10-list-jump-points')
      await page.getByRole('button', { name: 'Panel options', exact: true }).click()
      await page.getByRole('button', { name: 'Pages', exact: true }).click(); await sleep(300)
    })
    await step('talk', async () => {
      await page.getByRole('tab', { name: 'Talk', exact: true }).click(); await sleep(400)
      await page.locator('.tw-talk-switch').getByRole('button', { name: 'Design', exact: true }).click()
      await until(async () => await page.locator('.pane--talk .tw-right-picture-frame img').count() >= 8, 15000); await sleep(800)
      await shot('11-talk-design')
      await page.locator('.tw-talk-switch').getByRole('button', { name: 'Details', exact: true }).click(); await sleep(500); await shot('12-talk-details')
    })
    await step('review', async () => {
      await goto('Three priorities')
      const before = disk()
      const shown = await outside('13-outside', before.replace('- Share the tools', '- Share the tools and the seed trays'))
      const dialog = page.locator('dialog[open]')
      if (shown && await dialog.count()) {
        await assertCentred(dialog)
        fact(`${ctx.tag}-review-box`, await dialog.evaluate(node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, w: box.width, h: box.height } }))
        fact(`${ctx.tag}-review-text`, (await dialog.innerText()).replace(/\n+/g, ' | ').slice(0, 700))
        await dialog.getByRole('button', { name: 'Put it back', exact: true }).click()
        fact(`${ctx.tag}-putback-restores`, await until(() => disk() === before, 8000)); await sleep(700); await shot('13-outside-after-putback')
      }
    })
    if (!full) return
    await step('more', async () => { await openPage('More'); await shot('07-more'); await text(`${ctx.tag}-more`) })
  }
  for (const [name, w, h, theme] of [['N-L1440', 1440, 900, 'light'], ['N-D1440', 1440, 900, 'dark'], ['N-L1000', 1000, 631, 'light'], ['N-D1000', 1000, 631, 'dark']]) {
    ctx.tag = name; await t.setSize(w, h); await t.setTheme(theme); await sleep(900)
    await tour(name === 'N-L1440')
  }
  if (matrixOnly) return

  ctx.tag = 'N-J'; await t.setSize(1440, 900); await t.setTheme('light'); await sleep(900)
  fact('N-J-disk-is-source', disk() === source)
  await step('titleslide', async () => {
    await goto('Community garden update'); await sleep(800); await shot('01-titleslide'); await text('N-J-titleslide')
    await inspector.getByText(/Made from the talk’s details/).waitFor()
    await inspector.getByRole('button', { name: 'Edit talk details', exact: true }).waitFor()
    await inspector.getByRole('button', { name: 'Talk design', exact: true }).waitFor()
    assert.equal(await inspector.locator('.tw-right-adjust').count(), 0)
  })
  await step('try', async () => {
    await goto('Three priorities'); await pictures(4)
    const start = disk()
    const textTop = () => page.locator('.workspace-slide-text').evaluate(node => Math.round(node.getBoundingClientRect().top))
    const stage = page.locator('.workspace-slide-stage iframe'); const before = await stage.getAttribute('src'); const top = await textTop()
    await pic('Icon list').hover()
    fact('N-J-try-bar', await until(async () => await page.locator('.tw-right-bar.is-trying').count() > 0, 5000))
    fact('N-J-try-stage-changed', await until(async () => await stage.getAttribute('src') !== before, 6000))
    await sleep(1200); await shot('20-trying'); fact('N-J-try-writes-nothing', disk() === start)
    const movement = await textTop() - top
    fact('N-J-try-moves-slide-text-by', movement)
    assert.equal(movement, 0, 'Try keeps the text at the same height')
    fact('N-J-try-bar-font', await page.locator('.tw-right-bar.is-trying').evaluate(node => getComputedStyle(node).fontSize))
    await away(); fact('N-J-try-ends-on-leave', await until(async () => await page.locator('.tw-right-bar.is-trying').count() === 0, 4000))
    fact('N-J-keep-saved', await keep('Icon list')); await shot('22-applied'); fact('N-J-keep-trigger', trigger('p4k2m')); await marks('N-J-applied-marks')
    await page.locator('.tw-right-bar').getByRole('button', { name: 'Undo', exact: true }).first().click()
    fact('N-J-undo-restores-bytes', await until(() => disk() === start, 6000)); await sleep(700); await shot('23-undone')
    await inspector.getByRole('button', { name: /^Show all/ }).click(); await pictures(7); await sleep(1500); await shot('24-all-designs'); await scrollPane(9999); await shot('24-all-designs-foot'); await text('N-J-all-designs')
  })
  await step('title', async () => {
    await goto('Three priorities'); await openPage('Title'); await pictures(8)
    const start = disk()
    await pic('At the side').hover(); await until(async () => await page.locator('.tw-right-bar.is-trying').count() > 0, 5000); await sleep(1000); await shot('30-title-try-side'); await away()
    await keep('At the side'); await shot('31-title-side'); fact('N-J-title-side-trigger', trigger('p4k2m')); await marks('N-J-title-side-marks')
    await inspector.getByRole('button', { name: '40%', exact: true }).click().catch(() => {}); await sleep(1200); await shot('31-title-side-40'); fact('N-J-title-side40-trigger', trigger('p4k2m'))
    await keep('Not shown'); await shot('32-title-hidden'); fact('N-J-title-hidden-trigger', trigger('p4k2m'))
    await inspector.getByRole('button', { name: 'Reset to talk setting', exact: true }).click()
    fact('N-J-title-reset-restores-bytes', await until(() => disk() === start, 5000)); fact('N-J-title-reset-trigger', trigger('p4k2m')); await sleep(900); await shot('33-title-reset')
    await keep('Kicker'); await shot('34-title-kicker'); await marks('N-J-title-kicker-marks'); fact('N-J-title-kicker-trigger', trigger('p4k2m'))
    await keep('Section strip'); await shot('35-title-strip')
    await keep('Intro only'); await sleep(1500); await shot('36-title-intro'); await scrollPane(9999); await sleep(500); await shot('36-title-intro-foot'); await scrollPane(0)
    await keep('Tab'); fact('N-J-title-click-talk-style-restores-bytes', disk() === start); fact('N-J-title-after-tab-trigger', trigger('p4k2m'))
    if (disk() !== start) { await inspector.getByRole('button', { name: 'Reset to talk setting', exact: true }).click(); await until(() => disk() === start, 4000) }
    await scrollPane(9999); await inspector.getByRole('button', { name: 'L', exact: true }).first().click(); await sleep(1300); await shot('37-title-size-l'); fact('N-J-title-size-trigger', trigger('p4k2m'))
    await inspector.getByRole('button', { name: 'Choose an icon', exact: true }).click(); await sleep(900); await shot('38-title-icon-picker')
    const cell = page.locator('[data-plain-icon-picker] .pv-icon-cell').nth(3)
    if (await cell.count()) { await cell.click(); await sleep(1300) } else await page.keyboard.press('Escape')
    await shot('39-title-icon-chosen'); fact('N-J-title-icon-heading', trigger('p4k2m'))
    await scrollPane(0); await inspector.getByRole('button', { name: 'Reset to talk setting', exact: true }).click()
    fact('N-J-title-reset-all-restores-bytes', await until(() => disk() === start, 5000)); fact('N-J-title-reset-all-trigger', trigger('p4k2m'))
  })
  await step('points', async () => {
    await goto('Three priorities'); await openPage('Points'); await pictures(4)
    const start = disk()
    fact('N-J-points-numbers-saved', await keep('Numbers')); await shot('40-points-numbers'); await marks('N-J-points-numbers-marks'); fact('N-J-points-numbers-trigger', trigger('p4k2m'))
    await inspector.getByRole('button', { name: 'Large', exact: true }).click().catch(() => {}); await sleep(1200); await shot('40-points-numbers-large')
    await keep('Boxes'); await shot('41-points-boxes'); fact('N-J-points-boxes-trigger', trigger('p4k2m'))
    await keep('Row'); await shot('42-points-row'); await marks('N-J-points-row-marks'); fact('N-J-points-row-trigger', trigger('p4k2m')); await text('N-J-points-row')
    const reset = inspector.getByRole('button', { name: 'Reset to talk setting', exact: true })
    fact('N-J-points-row-has-reset', await reset.count() > 0)
    await reset.click()
    assert.ok(await until(() => !/icon-?row/.test(trigger('p4k2m').join(' ')), 8000), 'Reset removes the Row layout from the saved file')
    fact('N-J-points-reset-restores-bytes', disk() === start); fact('N-J-points-after-reset-trigger', trigger('p4k2m')); await shot('43-points-after-reset'); await text('N-J-points-after-reset')
    if (disk() !== start) { await keep('Bullets'); fact('N-J-points-bullets-after-row-trigger', trigger('p4k2m')); await shot('44-points-bullets-after-row') }
  })
  await step('icons', async () => {
    await goto('Where we organise'); await openPage('Icons'); await pictures(2); await sleep(600); await shot('50-icons-start'); await marks('N-J-icons-start-marks')
    fact('N-J-icons-on-saved', await keep('Icons')); await shot('51-icons-on'); await text('N-J-icons-on'); fact('N-J-icons-on-trigger', trigger('o1'))
    const choose = inspector.getByRole('button', { name: /^Choose an icon for Zoom/ })
    if (await choose.count()) {
      await choose.click(); await sleep(900); await shot('52-icons-picker')
      const cell = page.locator('[data-plain-icon-picker] .pv-icon-cell').nth(4)
      if (await cell.count()) { await cell.click(); await sleep(1300) }
      await shot('53-icons-chosen'); await text('N-J-icons-chosen'); fact('N-J-icons-chosen-lines', disk().split('\n').filter(line => line.includes('Zoom')))
      const back = inspector.getByRole('button', { name: 'Back to automatic', exact: true })
      if (await back.count()) { await back.first().click(); await sleep(1000); fact('N-J-icons-back-to-auto-lines', disk().split('\n').filter(line => line.includes('Zoom'))) }
    }
    const logos = pic('Logos'); fact('N-J-logos-offered', await logos.isEnabled())
    if (await logos.isEnabled()) { await keep('Logos'); await shot('54-icons-logos'); await text('N-J-icons-logos') }
    await keep('None'); await shot('55-icons-none'); fact('N-J-icons-none-trigger', trigger('o1')); await marks('N-J-icons-none-marks')
    await home(); await pictures(4); await sleep(1200); await shot('56-logos-home'); await marks('N-J-logos-home-marks'); await text('N-J-logos-home')
  })
  await step('picture', async () => {
    await goto('Three priorities'); await openPage('Picture'); await pictures(2); await marks('N-J-picture-marks-before')
    const current = await inspector.locator('.tw-right-picture[aria-pressed="true"] strong').first().textContent().catch(() => null)
    const other = current === 'On the right' ? 'On the left' : 'On the right'
    fact('N-J-picture-other-saved', await keep(other)); await shot('57-picture-other'); fact('N-J-picture-other-trigger', trigger('p4k2m')); await marks('N-J-picture-marks-after')
    fact('N-J-picture-back-saved', await keep(current ?? 'On the right')); await shot('58-picture-back'); fact('N-J-picture-back-trigger', trigger('p4k2m'))
  })
  await step('table', async () => {
    await goto('Watering rota'); await pictures(4); await sleep(900); await shot('60-table-home'); await marks('N-J-table-home-marks'); await text('N-J-table-home')
    const all = inspector.getByRole('button', { name: /^Show all/ }); if (await all.count()) { await all.click(); await sleep(1500); await shot('60-table-all') }
    await pic('Rows only').hover(); await sleep(1500); await shot('61-table-try'); await away()
    fact('N-J-table-first-column-saved', await keep('First column leads')); await shot('62-table-first-column'); fact('N-J-table-trigger', trigger('t1'))
    await openPage('Table'); await pictures(4); await sleep(900); await shot('63-table-page'); await marks('N-J-table-page-marks'); await text('N-J-table-page')
    fact('N-J-table-side-saved', await (async () => { await home(); const side = pic('Title at the side'); if (!await side.count()) return 'not shown'; return keep('Title at the side') })()); await shot('64-table-title-side'); fact('N-J-table-side-trigger', trigger('t1'))
  })
  await step('long-title', async () => {
    await goto('Jobs for Saturday'); await pictures(4); await sleep(900); await shot('67-long-title-home'); await marks('N-J-long-title-marks')
    await openPage('Points'); await pictures(4); await sleep(900); await shot('67-long-title-points'); await marks('N-J-long-title-points-marks')
    await openPage('Icons'); await sleep(900); await shot('67-long-title-icons')
  })
  await step('subslides', async () => {
    await goto('Dates for the diary'); await sleep(1500); await shot('68-subslides-home'); await text('N-J-subslides-home'); await marks('N-J-subslides-marks')
    await openPage('Subslides'); await sleep(700); await shot('68-subslides-page'); await text('N-J-subslides-page')
  })
  await step('quote', async () => {
    await goto('What a member said'); await sleep(1500); await shot('69-quote-home'); await text('N-J-quote-home')
    await openPage('Quote'); await sleep(2200); await shot('69-quote-page'); await marks('N-J-quote-marks')
  })
  await step('timeline', async () => {
    await goto('How the year runs'); await sleep(1500); await shot('70-timeline-home'); await text('N-J-timeline-home')
    await openPage('Timeline'); await sleep(2000); await shot('70-timeline-page'); await text('N-J-timeline-page')
  })
  await step('statement', async () => {
    await goto('Come on Saturday'); await sleep(1500); await shot('71-statement-home'); await text('N-J-statement-home')
    await openPage('Title'); await sleep(1800); await shot('71-statement-title'); await marks('N-J-statement-title-marks')
  })
  await step('noid', async () => {
    await goto('A slide without an id'); await pictures(4); await sleep(800)
    const before = disk()
    await inspector.locator('[data-section="designs"]').getByRole('button', { name: 'Copy for agent', exact: true }).click()
    const field = page.getByRole('textbox', { name: 'Request for agent', exact: true })
    await until(async () => (await field.inputValue()).length > 40); await shot('72-noid-copy'); fact('N-J-noid-copy', await field.inputValue())
    fact('N-J-noid-copy-leaves-file', disk() === before)
  })
  await step('empty', async () => { await goto('New slide'); await sleep(1200); await shot('73-empty-home'); await text('N-J-empty-home') })
  await step('unknown', async () => { await goto('A code nobody knows'); await sleep(1200); await shot('74-unknown-home'); await text('N-J-unknown-home') })
  await step('section', async () => {
    await goto('Next season'); await sleep(1800); await shot('75-section-home'); await text('N-J-section-home'); await marks('N-J-section-marks')
    await openPage('Colour'); await pictures(3); await sleep(1200); await shot('75-section-colour'); await marks('N-J-section-colour-marks')
    await openPage('Title'); await sleep(700); await shot('75-section-title')
  })
  await step('copy', async () => {
    await goto('Where we organise'); await openPage('Icons')
    await inspector.getByRole('button', { name: 'Copy for agent', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: /Copy for agent/ })
    const field = dialog.getByRole('textbox', { name: 'Request for agent', exact: true })
    await until(async () => (await field.inputValue()).length > 40)
    await dialog.getByRole('textbox', { name: 'What should be better?', exact: true }).fill('Use the real logos and make them larger.')
    await shot('80-copy-icons-wish'); fact('N-J-copy-icons', await field.inputValue())
    await page.evaluate(() => { window.copied = []; Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async value => { window.copied.push(value) } }) })
    await dialog.getByRole('button', { name: 'Copy', exact: true }).click(); await sleep(500); await shot('81-copy-copied')
    await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async () => { throw new Error('no') } }) })
    await dialog.getByRole('button', { name: 'Copy again', exact: true }).click(); await sleep(500); await shot('82-copy-blocked')
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('tab', { name: 'Talk', exact: true }).click(); await sleep(300)
    await page.locator('.tw-talk-switch').getByRole('button', { name: 'Design', exact: true }).click(); await sleep(500)
    await page.locator('.pane--talk').getByRole('button', { name: 'Copy for agent', exact: true }).first().click()
    await until(async () => (await page.getByRole('textbox', { name: 'Request for agent', exact: true }).inputValue()).length > 40)
    await shot('83-copy-talkdesign'); fact('N-J-copy-talkdesign', await page.getByRole('textbox', { name: 'Request for agent', exact: true }).inputValue())
  })
  await step('talk-try', async () => {
    await goto('What we grew')
    await page.getByRole('tab', { name: 'Talk', exact: true }).click(); await sleep(300)
    await page.locator('.tw-talk-switch').getByRole('button', { name: 'Design', exact: true }).click()
    const pane = page.locator('.pane--talk')
    await until(async () => await pane.locator('.tw-right-picture-frame img').count() >= 8, 15000)
    const before = disk()
    await pic('Classic', pane).hover(); await sleep(1600); await shot('85-talk-try-classic'); fact('N-J-talk-try-writes-nothing', disk() === before)
    fact('N-J-talk-try-bar', await page.locator('.tw-right-bar.is-trying').count()); await away()
    await pic('Classic', pane).click(); fact('N-J-talk-theme-saved', await until(() => disk() !== before, 5000)); await sleep(2000); await away(); await shot('86-talk-classic-kept')
    fact('N-J-talk-theme-head', disk().split('\n').slice(0, 9)); fact('N-J-talk-undo-offered', await page.getByRole('button', { name: 'Undo', exact: true }).count())
    await pic('Kicker', pane).click(); await sleep(2200); await away(); await shot('87-talk-titles-kicker'); fact('N-J-talk-titles-head', disk().split('\n').slice(0, 10))
    await page.keyboard.press('Meta+z'); await sleep(1500); fact('N-J-talk-after-cmd-z-head', disk().split('\n').slice(0, 10))
    await pic('Kicker', pane).click(); await sleep(2000)
    await t.slideTab(); await goto('What we grew'); await shot('88-slide-after-talk-kicker')
    await openPage('Title'); await pictures(8); await sleep(1200); await shot('89-title-follows-kicker'); await marks('N-J-title-follows-kicker-marks'); await text('N-J-title-follows-kicker')
    await inspector.getByRole('button', { name: 'Change for the talk', exact: true }).click(); await sleep(900); await shot('90-change-for-talk')
  })
  await step('views', async () => {
    await goto('Three priorities')
    for (const view of ['Outline', 'Markdown', 'Grid']) {
      await page.getByRole('button', { name: view, exact: true }).first().click().catch(async () => { await page.getByRole('tab', { name: view, exact: true }).first().click() })
      await sleep(1800); await pictures(2, 5000); await shot('92-view-' + view.toLowerCase())
      if (view === 'Outline') {
        const start = disk(); await pic('Icon list').hover().catch(() => {}); await sleep(1500); await shot('92-view-outline-trying'); fact('N-J-outline-try-writes-nothing', disk() === start); await away()
      }
    }
    await page.getByRole('button', { name: 'Slide', exact: true }).first().click().catch(() => {}); await sleep(900)
  })
  await step('keys', async () => {
    await goto('Three priorities'); await openPage('Title')
    await page.keyboard.press('Meta+l'); await sleep(1000); await shot('93-cmd-l'); await text('N-J-cmd-l')
    await page.keyboard.press('Escape'); await sleep(300)
  })
  await step('outside-two', async () => {
    await goto('Three priorities')
    const before = disk()
    await outside('95-outside-two', before.replace('- Repair the beds', '- Repair the raised beds').replace('- Tomatoes and beans did well', '- Tomatoes, beans and squash did well'))
    assert.match(await sheet.locator('.tw-review-diff').innerText(), /raised beds/)
    assert.match(await sheet.locator('.tw-review-diff ins').allTextContents().then(lines => lines.join('')), /squash/)
    fact('N-J-outside-two-text', (await sheet.innerText().catch(() => 'no sheet')).replace(/\n+/g, ' | ').slice(0, 500))
    await sheet.getByRole('button', { name: 'Keep the changes', exact: true }).click(); await sleep(1800); await shot('96-outside-two-kept')
    fact('N-J-outside-two-kept', disk().includes('raised beds') && disk().includes('squash'))
  })
  await step('outside-other-slide', async () => {
    await goto('Where we organise')
    const before = disk()
    const shown = await outside('97-outside-other-slide', before.replace('- Share the tools', '- Share the tools and the wheelbarrow'))
    fact('N-J-outside-other-who', await who.textContent())
    if (shown) { await page.locator('dialog[open]').getByRole('button', { name: 'Keep the change', exact: true }).click(); await sleep(2000); await shot('98-outside-kept') }
    fact('N-J-outside-kept-who', await who.textContent()); fact('N-J-undo-after-keep', await page.getByRole('button', { name: 'Undo', exact: true }).count())
  })
  await step('outside-dismiss', async () => {
    await goto('Three priorities')
    const before = disk()
    const shown = await outside('99-outside-dismiss', before.replace('- Welcome new growers', '- Welcome new growers and their children'))
    if (shown) {
      await page.keyboard.press('Escape'); await sleep(1600); await shot('99-outside-dismissed')
      const gone = await page.locator('dialog[open]').count() === 0
      fact('N-J-dismiss-dialog-gone', gone)
      assert.ok(gone, 'Escape left the one-slide review open')
      const chip = page.getByRole('button', { name: /Changed on disk|Review merge|Review/ }).first()
      fact('N-J-dismiss-reopen-control', await chip.count() ? await chip.innerText() : 'none found')
      if (await chip.count()) { await chip.click(); await sleep(1800); await shot('99-outside-reopened') }
    }
  })
})

await run('old', async t => {
  const { page, ctx, shot, inspector, step, away, home, goto, pictures, openPage, pic, marks, text, keep, disk, trigger } = t
  for (const [tag, w, h, theme] of [['O-L1440', 1440, 900, 'light'], ['O-D1440', 1440, 900, 'dark'], ['O-L1000', 1000, 631, 'light'], ['O-D1000', 1000, 631, 'dark']]) {
    ctx.tag = tag
    await t.setSize(w, h); await t.setTheme(theme); await sleep(900)
    await step('picture-and-points', async () => {
      await goto('Three priorities')
      await assertDesignHeadingFits(inspector)
      assert.match(await inspector.locator('.tw-right-who small').innerText(), /Next season/)
      assert.equal(await pic('Title and points').getAttribute('aria-pressed'), 'false')
      await pictures(4); await shot('02-picture-home')
      await openPage('Picture'); await pictures(2); await shot('03-picture')
      assert.equal(await pic('On the left').getAttribute('aria-pressed'), 'true')
      assert.equal(await pic('On the right').getAttribute('aria-pressed'), 'false')
      await openPage('Points'); await pictures(4); await shot('04-points')
      assert.equal(await pic('Bullets').getAttribute('aria-pressed'), 'true')
      await openPage('Icons'); await pictures(2); await shot('05-icons')
      assert.equal(await pic('Icons').isEnabled(), true)
      await pic('Icons').locator('img').waitFor()
      await away()
      const copy = inspector.getByRole('button', { name: 'Copy for agent', exact: true })
      try {
        await clickCopyWithFrameLog(page, copy, ctx.tag)
      } catch (error) {
        fact(`${ctx.tag}-copy-pointer`, await pointerTarget(copy).catch(() => null))
        throw error
      }
      await assertCentred(page.locator('dialog[open]')); await shot('06-copy')
    })
  }
  if (matrixOnly) return
  ctx.tag = 'O'
  await t.setSize(1440, 900); await t.setTheme('light')
  await step('titleslide', async () => { await goto('Community garden update'); await sleep(800); await shot('01-titleslide'); await text('O-titleslide') })
  await step('plain', async () => {
    await goto('What we grew'); await pictures(4); await sleep(900); await shot('02-plain-home'); await marks('O-plain-home-marks'); await text('O-plain-home')
    await openPage('Title'); await pictures(3); await sleep(1200); await shot('03-plain-title'); await marks('O-plain-title-marks'); await text('O-plain-title')
    await openPage('Points'); await pictures(4); await sleep(900); await shot('04-plain-points'); await marks('O-plain-points-marks')
    await openPage('Icons'); await pictures(2); await sleep(900); await shot('05-plain-icons'); await marks('O-plain-icons-marks')
  })
  await step('picture-slide', async () => {
    await goto('Three priorities'); await pictures(4); await sleep(900); await shot('06-picture-home'); await marks('O-picture-home-marks')
    await openPage('Icons'); await sleep(1500); await shot('07-picture-icons'); await marks('O-picture-icons-marks')
    await openPage('Points'); await pictures(3); await sleep(1200); await shot('08-picture-points'); await marks('O-picture-points-marks')
    await openPage('Picture'); await pictures(2); await sleep(900); await shot('09-picture-page'); await marks('O-picture-page-marks')
    const before = disk(); await pic('On the right').click().catch(() => {}); await sleep(1500)
    fact('O-picture-click-on-the-right-changes-file', disk() !== before); fact('O-picture-trigger', trigger('p4k2m'))
    await home(); const start = disk()
    fact('O-keep-title-and-points-possible', await (async () => { const tile = pic('Title and points'); return await tile.getAttribute('aria-pressed') })())
    await keep('Icon list'); await shot('10-picture-icon-list'); fact('O-icon-list-trigger', trigger('p4k2m'))
    await page.locator('.tw-right-bar').getByRole('button', { name: 'Undo', exact: true }).first().click(); fact('O-undo-restores-bytes', await (async () => { await page.waitForTimeout(1500); return disk() === start })())
  })
  await step('icons-default', async () => {
    await goto('What we grew')
    const before = disk()
    await t.outside('11-header-change', before.replace('author: Maya Green', 'author: Maya Green\ndefaults: { icons: on }'))
    await t.sheet.getByRole('button', { name: 'Keep the changes', exact: true }).click(); await sleep(2500)
    await goto('What we grew'); await pictures(4); await sleep(1500); await shot('12-icons-default-home'); await marks('O-icons-default-home-marks')
    await openPage('Icons'); await pictures(2); await sleep(1000); await shot('13-icons-default-icons'); await marks('O-icons-default-icons-marks'); await text('O-icons-default-icons')
    await openPage('Points'); await pictures(4); await sleep(1000); await shot('14-icons-default-points'); await marks('O-icons-default-points-marks'); await text('O-icons-default-points')
  })
})
save()
console.log('Look walk finished.', log.errors.length, 'step errors;', log.steps.length, 'pictures in', out)

async function assertCentred(dialog) {
  await dialog.waitFor()
  const box = await dialog.evaluate(element => {
    const { x, y, height, width } = element.getBoundingClientRect()
    return { dx: x + width / 2 - innerWidth / 2, dy: y + height / 2 - innerHeight / 2, font: getComputedStyle(element.querySelector('p')).fontSize }
  })
  assert.ok(Math.abs(box.dx) < 2 && Math.abs(box.dy) < 2, `Centred dialog: ${JSON.stringify(box)}`)
  assert.equal(box.font, '13px')
}

async function pointerTarget(button) {
  return button.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    const x = bounds.left + bounds.width / 2, y = bounds.top + bounds.height / 2
    const pane = element.closest('.tw-inspector-pane')
    return {
      viewport: [innerWidth, innerHeight],
      visibility: document.visibilityState,
      bounds: bounds.toJSON(),
      paneScroll: pane?.scrollTop,
      hit: document.elementsFromPoint(x, y).slice(0, 4).map(node => node.tagName + '.' + node.getAttribute('class')),
      active: document.activeElement?.getAttribute('class'),
      animations: element.getAnimations().map(animation => animation.playState)
    }
  })
}

async function clickCopyWithFrameLog(page, button, tag) {
  const recording = await button.evaluate(element => {
    if (innerWidth !== 1000 || innerHeight !== 631) return false
    const pane = element.closest('.tw-inspector-pane')
    const inspector = element.closest('.tw-inspector')
    const samples = []
    const start = performance.now()
    let frame
    const sample = now => {
      const { x, y, width, height } = element.getBoundingClientRect()
      samples.push({ ms: now - start, x, y, width, height, paneScrollTop: pane?.scrollTop,
        inspectorScrollTop: inspector?.scrollTop, panelWidth: inspector?.getBoundingClientRect().width })
      frame = requestAnimationFrame(sample)
    }
    frame = requestAnimationFrame(sample)
    window.stopCopyFrameLog = () => {
      cancelAnimationFrame(frame)
      return samples
    }
    return true
  })
  try {
    await button.click()
  } finally {
    if (recording) {
      const samples = await page.evaluate(() => window.stopCopyFrameLog()).catch(() => [])
      writeFileSync(join(out, `${tag}-copy-frames.json`), JSON.stringify(samples))
      fact(`${tag}-copy-frames`, samples.length)
    }
  }
}

async function assertDesignHeadingFits(inspector) {
  const header = inspector.locator('.tw-right-designs .tw-right-page-head')
  const measured = await header.evaluate(element => {
    const copy = element.querySelector('.tw-right-copy')
    const title = element.querySelector('h3')
    return {
      buttonOverflow: copy.getBoundingClientRect().right - element.getBoundingClientRect().right,
      titleOverflow: title.scrollWidth - title.clientWidth
    }
  })
  assert.ok(measured.buttonOverflow <= 1 && measured.titleOverflow <= 1,
    `Design heading and Copy for agent fit on one line: ${JSON.stringify(measured)}`)
}
