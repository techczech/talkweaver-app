// Batch 4 evidence (consistency review: R7, R8, R11, R16). Opens the main window on a throwaway copy of demo-vault/ with a
// throwaway user-data folder, hidden and off-screen (e2e/lib/consistency-world.mjs), and saves one screenshot per state to
// --out=<dir> at --size=WxH. The same script makes the "before" and the "after" folders: a state the build does not have (the
// Talk tab before, the two dialogs after) is reached through the same commands and noted, not faked.
//   node e2e/diagnose-consistency-evidence.mjs --size=1280x800 --out=hill-climbs/.../evidence/after/1280x800
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { launchWorld } from './lib/consistency-world.mjs'

const argv = process.argv.slice(2)
const opt = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const [W, H] = (opt('size') ?? '1280x800').split('x').map(Number)
const OUT = resolve(opt('out') ?? 'evidence-out')
mkdirSync(OUT, { recursive: true })
const world = await launchWorld({ width: W, height: H, viewMode: 'markdown' })
const { page, command, sleep, rcTab, sideTab } = world
const log = []
const note = (state, text) => { log.push(`${state}: ${text}`); console.log(`[evidence] ${state}: ${text}`) }
const shot = async (state, target = page) => { await target.screenshot({ path: join(OUT, `${state}.png`) }); note(state, 'saved') }
const settleTop = async () => { for (let i = 0; i < 3; i += 1) { await page.keyboard.press('Escape'); await sleep(200) } }
const inspector = async () => { if (await rcTab('inspector').count()) await rcTab('inspector').click().catch(() => {}); await sleep(500) }

await world.openTalk('TalkWeaver Layout Showcase'); await sleep(500)
await inspector()
await sideTab(/^Talks$/).click().catch(() => {}); await sleep(500)
await shot('main-inspector')   // the main window, Slides view, right sidebar on the Inspector
await shot('talks-tab')
await sideTab(/Slide outline/).click(); await sleep(900)
await shot('slide-outline')
await sideTab(/^Talks$/).click().catch(() => {}); await sleep(400)
// The two dialogs before; the Talk tab after (Metadata… also opens its Advanced part): reached through the same two commands.
for (const [state, id] of [['deck-design', 'deck-design'], ['metadata', 'metadata']]) {
  await command(id); await sleep(1200)
  if (id === 'metadata' && await page.locator('[data-talk-section="advanced"] > summary').count()) {
    await page.locator('[data-talk-section="advanced"] > summary').click(); await sleep(1200)
    await page.locator('[data-talk-section="advanced"]').scrollIntoViewIfNeeded().catch(() => {})
  }
  await shot(state)
  note(state, (await page.locator('[role=dialog][aria-modal=true]').count()) ? 'opened a modal dialog' : (await rcTab('talk').count()) ? 'opened the Talk tab' : 'nothing opened')
  await settleTop()
}
await inspector()
await command('view-plain'); await sleep(1200)
await page.locator('.cm-content').first().click({ position: { x: 20, y: 6 } }).catch(() => {})
await page.keyboard.press('Meta+ArrowUp').catch(() => {}); await sleep(500)
await shot('plain-talk-details')
await command('view-markdown'); await sleep(700)
// the three modes with their exit control showing (Esc is tried after the shot)
await command('vault-gallery'); await sleep(1500)
await shot('vault-gallery')
await page.keyboard.press('Escape'); await sleep(700)
note('vault-gallery', (await page.locator('.vault-gallery').count()) ? 'Esc did NOT leave the gallery' : 'Esc left the gallery')
if (await page.locator('.vault-gallery').count()) { await page.getByRole('button', { name: /Return to talk|Back to/ }).first().click().catch(() => {}); await sleep(600) }
await sideTab(/Slide outline/).click(); await sleep(500)
await page.locator('button.so-slide').nth(2).click().catch(() => {}); await sleep(700)
await command('focus-slide'); await sleep(1500)
await shot('slide-focus')
await page.keyboard.press('Escape'); await sleep(700)
note('slide-focus', (await page.locator('.lt-focus').count()) ? 'Esc did NOT leave focus' : 'Esc left focus')
await settleTop()
await sideTab(/^Talks$/).click().catch(() => {}); await sleep(300)
await command('pathways'); await sleep(1500)
await shot('pathways')
await settleTop(); await sleep(500)
await command('present-presenter')
const pres = await world.presenter()
if (pres) {
  note('presenter', `counter reads "${await pres.locator('#presenterCount').innerText().catch(() => '?')}"`)
  await shot('presenter', pres)
} else note('presenter', 'no presenter window appeared')
writeFileSync(join(OUT, 'notes.txt'), log.join('\n') + '\n')
await world.close()
process.exit(0)
