// A throwaway TalkWeaver for the consistency checks (batch 4): Electron hidden and off-screen at a fixed size, on a copy of
// demo-vault/ with its own user-data folder, native dialogs declined, nothing leaves this computer. Shared by
// diagnose-consistency-evidence.mjs (screenshots) and diagnose-consistency-batch4.mjs (assertions).
import { _electron as electron } from 'playwright'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureFreshBuild } from './ensure-fresh-build.mjs'
import { openTalkByTitle } from './talklist.mjs'

export async function launchWorld({ width = 1280, height = 800, viewMode = 'markdown' } = {}) {
  const root = process.cwd()
  await ensureFreshBuild(root)
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tw-consistency-')))
  const userData = join(scratch, 'userData'); const vault = join(scratch, 'vault')
  mkdirSync(userData, { recursive: true })
  cpSync(join(root, 'demo-vault'), vault, { recursive: true })
  writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, editorViewMode: viewMode }))
  const env = { TW_E2E: '1', TW_REC_TEST: '1' }
  for (const n of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'SHELL']) if (process.env[n] !== undefined) env[n] = process.env[n]
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: root, env, timeout: 60_000 })
  await app.evaluate(({ shell, app: electronApp, BrowserWindow, dialog, session }, size) => {
    shell.openExternal = async () => {}; shell.showItemInFolder = () => {}; shell.openPath = async () => ''
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); dialog.showSaveDialog = async () => ({ canceled: true })
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    const refuse = (ses) => ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !(/^(file|devtools|chrome-extension|data|blob|about|app|tw|twmedia|talkweaver)[a-z-]*:/i.test(d.url) || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(d.url)) }))
    refuse(session.defaultSession); electronApp.on('session-created', refuse)
    const place = (win) => { win.setMinimumSize(0, 0); win.setBounds({ x: -20000, y: -20000, width: size.w, height: size.h }); win.setContentSize(size.w, size.h); win.hide() }
    BrowserWindow.getAllWindows().forEach(place)
    electronApp.on('browser-window-created', (_e, win) => { place(win); win.once('ready-to-show', () => place(win)) })
  }, { w: width, h: height })
  const page = await app.firstWindow()
  await page.setViewportSize({ width, height }).catch(() => {})
  page.setDefaultTimeout(5000)
  await page.waitForLoadState('domcontentloaded'); await page.waitForTimeout(2500)
  const world = {
    app, page, vault, userData, width, height,
    sleep: (ms) => page.waitForTimeout(ms),
    /** Send a registry command the way the menu bar does. */
    async command(id, target = page) {
      const url = target.url()
      await app.evaluate(({ BrowserWindow }, { id: c, url: u }) => { BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL() === u)?.webContents.send('app:run-command', c) }, { id, url })
    },
    async openTalk(title = 'TalkWeaver Layout Showcase') { await openTalkByTitle(page, title); await page.waitForTimeout(1500) },
    rcTab: (tab) => page.locator(`[data-rc-tab="${tab}"] button`).first(),
    sideTab: (re) => page.locator('.sidebar-mode-btn').filter({ hasText: re }).first(),
    /** The presenter's window once it has appeared. */
    async presenter() {
      for (let i = 0; i < 80; i += 1) {
        const p = app.windows().find((w) => !w.isClosed() && /^file:.*\/vault\//.test(w.url()))
        if (p) { await p.setViewportSize({ width, height }).catch(() => {}); await p.waitForTimeout(2500); return p }
        await page.waitForTimeout(150)
      }
      return null
    },
    /** Close every window but the main one (the presenter, the audience window). */
    async closeExtraWindows() {
      await app.evaluate(({ BrowserWindow }, mainUrl) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && w.webContents.getURL() !== mainUrl) w.destroy() }, page.url())
      await page.waitForTimeout(300)
    },
    async close() { await app.close().catch(() => {}); rmSync(scratch, { recursive: true, force: true }) }
  }
  return world
}
