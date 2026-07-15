// Real-Electron regression harness for the CONFIRMED data-loss bug (2026-07-05):
// TalkWeaver emptied a user's outline (58 slides → 0 bytes) during Slide Focus testing.
//
// Root cause (see .superpowers/sdd/task-dataloss-fix-report.md):
//   The single reused editor is remounted whenever `editorKey = `${outlinePath}#${reorderNonce}``
//   changes (talk switch / any reorderNonce bump). On remount the EditorView is created with
//   `doc: ''` and the load effect asynchronously reads the file back in. In that transient the
//   renderer's autosave / flushSave could write the empty doc, and the main handler wrote '' over
//   a full file unconditionally. reposync then auto-committed the 0-byte file.
//
// Three scenarios, ALL of which FAIL on the unfixed code and PASS once fixed. Every assertion is
// disk-based (authoritative): the renderer's `window.tw` is a frozen contextBridge object, so an
// in-page write spy is a no-op — we measure the real files instead.
//   (D) DIRECT backstop — writeOutline(fullFile, '') / whitespace / structurally-empty over a
//       non-empty file must be REFUSED ({ok:false, refused:'empty-over-nonempty'}) and the file
//       byte-identical. (A legitimate non-empty write must still succeed.)
//   (R) RENDERER autosave — ⌘A + Delete empties the editor doc; the debounced autosave must NEVER
//       persist that empty doc. On unfixed code the file goes to 0 bytes.
//   (T) TRANSIENT churn — rapid talk switch + Focus + cross-talk Focus while an autosave is pending
//       (the exact remount window) must never shrink/empty either outline file.
//
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && node e2e/diagnose-dataloss.mjs
import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, statSync } from 'fs'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// A substantial outline (mirrors the real 58-slide file: YAML frontmatter + many `### ` slides).
function bigOutline(title, n) {
  const head = ['---', `title: ${title}`, 'theme: paper', '---', '', '## Section One', '']
  const body = []
  for (let i = 1; i <= n; i++) {
    body.push(`### ${title} slide ${i}`, `{statement}{id=${title.toLowerCase().replace(/\s+/g, '')}s${i}}`, '',
      `Body text for slide ${i} of ${title}. This carries real content that must never be lost.`, '',
      `- point ${i}a`, `- point ${i}b`, '')
  }
  return head.concat(body).join('\n')
}

const A_TITLE = 'Alpha Talk'
const B_TITLE = 'Beta Talk'
const A = bigOutline(A_TITLE, 24)
const B = bigOutline(B_TITLE, 24)

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-dataloss-' + String(Date.now()) + '-'))
const tempVault = join(tempRoot, 'vault')
const userDataDir = join(tempRoot, 'userData')
const aDir = join(tempVault, 'alpha-talk')
const bDir = join(tempVault, 'beta-talk')
mkdirSync(aDir, { recursive: true })
mkdirSync(bDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
const A_PATH = join(aDir, 'alpha-talk-outline.md')
const B_PATH = join(bDir, 'beta-talk-outline.md')
writeFileSync(A_PATH, A)
writeFileSync(B_PATH, B)
writeFileSync(join(userDataDir, 'config.json'), JSON.stringify({ vaultRoot: tempVault }, null, 2))

const A_LEN0 = statSync(A_PATH).size
const B_LEN0 = statSync(B_PATH).size
const nonEmpty = (s) => typeof s === 'string' && s.replace(/\s+/g, '').length > 0
const sizeOf = (p) => { try { return statSync(p).size } catch { return -1 } }
const contentOf = (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }

const app = await electron.launch({ args: ['.', '--user-data-dir=' + userDataDir], cwd: REPO })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

// Leave any Focus view / open overlay so the talk list is clickable (the Focus rail intercepts clicks).
async function toWorkspace() {
  for (let i = 0; i < 4; i++) {
    if ((await page.locator('.lt-focus, .lt-browser-root, .command-menu').count()) === 0) break
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(200)
  }
}
async function selectTalk(name) {
  await toWorkspace()
  await page.locator('.talk-item', { hasText: name }).first().click()
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  await page.waitForTimeout(1700) // let the debounced compile land
}
const headingsOf = (t) => (t || '').split('\n').filter((l) => /^### /.test(l)).map((l) => l.replace(/^###\s+/, '').trim())
// Drive the REAL SlideStrip drag-reorder via the DnD event sequence (synthetic mouse moves don't drive
// HTML5 DnD in Electron) — mirrors e2e/diagnose-reorder.mjs. beginDrag starts it; finishDrag drops.
async function beginDrag(fromTitle, toTitle) {
  return page.evaluate(({ fromTitle, toTitle }) => {
    const cards = Array.from(document.querySelectorAll('.tw-slide-card'))
    const byTitle = (t) => cards.find((c) => (c.textContent || '').includes(t))
    const src = byTitle(fromTitle); const dst = byTitle(toTitle)
    if (!src || !dst) return { ok: false, reason: `card(s) missing from=${!!src} to=${!!dst}` }
    window.__twDrag = { dt: new DataTransfer(), src, dst }
    const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: window.__twDrag.dt }))
    fire(src, 'dragstart'); fire(dst, 'dragenter'); fire(dst, 'dragover')
    return { ok: true }
  }, { fromTitle, toTitle })
}
async function finishDrag() {
  return page.evaluate(() => {
    const { dt, src, dst } = window.__twDrag || {}
    if (!dst) return false
    const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
    fire(dst, 'drop'); fire(src, 'dragend'); delete window.__twDrag
    return true
  })
}

try {
  // ── (D) DIRECT backstop: empty / whitespace / structural-empty over a non-empty file → refused ────
  await selectTalk(A_TITLE)

  const directEmpty = await page.evaluate((p) => window.tw.talk.writeOutline(p, ''), A_PATH)
  record('DIRECT: writeOutline(fullFile, "") is refused and the file is byte-intact',
    sizeOf(A_PATH) === A_LEN0 && directEmpty && directEmpty.ok === false && directEmpty.refused === 'empty-over-nonempty',
    `size ${A_LEN0}→${sizeOf(A_PATH)}, ret=${JSON.stringify(directEmpty)}`)

  const directWs = await page.evaluate((p) => window.tw.talk.writeOutline(p, '   \n\n  \t '), A_PATH)
  record('DIRECT: writeOutline(fullFile, whitespace-only) is refused and the file is byte-intact',
    sizeOf(A_PATH) === A_LEN0 && directWs && directWs.ok === false,
    `size now ${sizeOf(A_PATH)}, ret=${JSON.stringify(directWs)}`)

  const directStruct = await page.evaluate((p) => window.tw.talk.writeOutline(p, '- orphan bullet\n'), A_PATH)
  record('DIRECT: writeOutline(fullFile, structurally-empty) is refused and the file is byte-intact',
    sizeOf(A_PATH) === A_LEN0 && directStruct && directStruct.ok === false,
    `size now ${sizeOf(A_PATH)}, ret=${JSON.stringify(directStruct)}`)

  const good = contentOf(A_PATH) + '\n\n### Alpha Talk slide 25\n{plain}{id=alphatalks25}\n\nAppended.\n'
  const directGood = await page.evaluate((args) => window.tw.talk.writeOutline(args.p, args.c), { p: A_PATH, c: good })
  record('DIRECT: a legitimate non-empty write still succeeds (backstop does not block real saves)',
    directGood && directGood.ok === true && sizeOf(A_PATH) > A_LEN0,
    `size now ${sizeOf(A_PATH)}, ret=${JSON.stringify(directGood)}`)
  writeFileSync(A_PATH, A) // restore for the next scenarios

  // ── (R) RENDERER autosave: emptying the editor doc must NOT persist an empty file ─────────────────
  // Select-all + Delete makes the editor doc '' → docChanged → the renderer's autosave fires. On the
  // unfixed code this debounced autosave writes '' to disk (the file the user was editing is lost).
  // Fixed: the renderer skips the empty autosave AND the main backstop refuses, so the file is intact.
  await selectTalk(A_TITLE)
  writeFileSync(A_PATH, A); const A_LEN_R0 = statSync(A_PATH).size
  await page.locator('.cm-content .cm-line').first().click()
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Delete')
  await page.waitForTimeout(2200) // > 1500ms autosave debounce — let any empty write land
  record('RENDERER: emptying the editor (⌘A, Delete) never autosaves an empty file to disk',
    nonEmpty(contentOf(A_PATH)) && sizeOf(A_PATH) > 0,
    `size ${A_LEN_R0}→${sizeOf(A_PATH)}`)
  writeFileSync(A_PATH, A)

  // ── (F) FLUSH: an edit made just before a fast talk switch is PERSISTED to the outgoing file (F1) ──
  // App flushes the OUTGOING editor at the talk-switch boundary. Before F1 (drop-timer, no boundary
  // flush) this sub-1.5s edit was silently dropped — so this case FAILS on the pre-F1 build.
  await selectTalk(B_TITLE); await selectTalk(A_TITLE) // reload A (prior RENDERER left the doc empty)
  writeFileSync(A_PATH, A); const A_LEN_F = statSync(A_PATH).size
  await page.locator('.cm-content .cm-line', { hasText: `${A_TITLE} slide 2` }).first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' FLUSHMARK')
  await toWorkspace()
  await page.locator('.talk-item', { hasText: B_TITLE }).first().click() // switch < 1.5s → boundary flush
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  await page.waitForTimeout(700) // let the fire-and-forget flush IPC land
  {
    const persisted = (contentOf(A_PATH) || '').includes(' FLUSHMARK')
    record('FLUSH: an edit made just before a fast talk switch is persisted to the outgoing file',
      persisted && sizeOf(A_PATH) > A_LEN_F, `A ${A_LEN_F}→${sizeOf(A_PATH)}, hasMark=${persisted}`)
  }
  writeFileSync(A_PATH, A)

  // ── (RE) REORDER: a same-talk reorderNonce bump applies and keeps every slide (no loss/dup/clobber) ─
  // The talk-switch flush must NEVER fire on a reorder (reorderNonce is not an activeTalk change). If it
  // did, the editor's pre-reorder doc would be written AFTER the reorder → the order reverts (clobber).
  await selectTalk(A_TITLE)
  writeFileSync(A_PATH, A)
  await page.waitForTimeout(4500) // compile + thumbnails so the strip renders draggable cards
  const beforeHeads = headingsOf(contentOf(A_PATH))
  const drag = await beginDrag(`${A_TITLE} slide 2`, `${A_TITLE} slide 6`)
  await page.waitForTimeout(150)
  await finishDrag()
  await page.waitForTimeout(2800) // reorder write + remount + reload settle
  {
    const doc = contentOf(A_PATH) || ''
    const afterHeads = headingsOf(doc)
    const sameSet = JSON.stringify([...beforeHeads].sort()) === JSON.stringify([...afterHeads].sort())
    const orderChanged = JSON.stringify(beforeHeads) !== JSON.stringify(afterHeads)
    record('REORDER: a same-talk reorder applies and keeps every slide exactly once (no loss/dup/clobber)',
      drag.ok && nonEmpty(doc) && sameSet && orderChanged && afterHeads.length === beforeHeads.length,
      `heads ${beforeHeads.length}→${afterHeads.length}, sameSet=${sameSet}, orderChanged=${orderChanged}, drag=${JSON.stringify(drag)}`)
  }
  writeFileSync(A_PATH, A)

  // ── (T) TRANSIENT churn guard: rapid switch / Focus / cross-talk Focus must never shrink a file ───
  // (Route B→A so the editor reloads A's on-disk content — the prior RENDERER step left the doc empty.)
  await selectTalk(B_TITLE)
  await selectTalk(A_TITLE)
  writeFileSync(A_PATH, A); writeFileSync(B_PATH, B)
  const A_LEN_T = statSync(A_PATH).size
  let minSeen = Infinity
  const snapMins = () => { minSeen = Math.min(minSeen, sizeOf(A_PATH), sizeOf(B_PATH)) }

  for (let round = 0; round < 3; round++) {
    try {
      await selectTalk(A_TITLE)
      await page.locator('.cm-content .cm-line', { hasText: `${A_TITLE} slide 2` }).first().click()
      await page.keyboard.press('End')
      await page.keyboard.type(' EDIT' + round)
      // do NOT wait for the 1500ms autosave — switch talks mid-flight to force a remount over a pending save
      await toWorkspace()
      await page.locator('.talk-item', { hasText: B_TITLE }).first().click()
      await page.waitForTimeout(160)
      await toWorkspace()
      await page.locator('.talk-item', { hasText: A_TITLE }).first().click()
      await page.waitForTimeout(160)
      // enter Focus, then cross-talk Focus into B from the Browser (switch + remount + pendingFocus)
      await page.locator('.cm-content .cm-line', { hasText: `${A_TITLE} slide 3` }).first().click().catch(() => {})
      await page.keyboard.press('Meta+Shift+f').catch(() => {})
      await page.waitForTimeout(200)
      await toWorkspace()
      await page.keyboard.press('Meta+k').catch(() => {})
      await page.waitForSelector('.lt-browser-root', { timeout: 3000 }).catch(() => {})
      await page.locator('.lt-searchfield input').fill(`${B_TITLE} slide 5`).catch(() => {})
      await page.waitForTimeout(500)
      await page.keyboard.press('ArrowDown').catch(() => {})
      await page.keyboard.press('Enter').catch(() => {})
      await page.waitForTimeout(300)
      await toWorkspace()
    } catch { /* an interaction hiccup in one round must not mask the disk invariant below */ }
    snapMins()
  }
  await page.waitForTimeout(2500) // let every debounced autosave/flush settle
  snapMins()

  const aFinal = sizeOf(A_PATH)
  const bFinal = sizeOf(B_PATH)
  const aIntact = nonEmpty(contentOf(A_PATH)) && aFinal >= A_LEN_T * 0.5
  const bIntact = nonEmpty(contentOf(B_PATH)) && bFinal >= B_LEN0 * 0.5
  record('TRANSIENT: neither outline file ever emptied or shrank during rapid switch/Focus/reorder',
    aIntact && bIntact && minSeen > 0,
    `A ${A_LEN_T}→${aFinal}, B ${B_LEN0}→${bFinal}, minSeen=${minSeen}`)
} catch (e) {
  record('dataloss harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== DATALOSS SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
