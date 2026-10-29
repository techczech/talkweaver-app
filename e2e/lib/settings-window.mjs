// Driving the shared Settings window (0.42) from an e2e spec. Settings is its own window: the editor
// window opens it (⌘, or the gear/App menu command), and a page of it is picked with the nav button
// `button.bsw-nav[data-section=…]`. A spec holds the Playwright Page of that window and works on it
// as it worked on the old in-window panel.

/** The Settings window if one is open. */
export function findSettingsWindow(app) {
  return app.windows().find((w) => !w.isClosed() && w.url().includes('settings.html')) ?? null
}

/**
 * Open the Settings window from the editor window `page` with ⌘, (the command the gear and the
 * App menu run), at `section` when one is named. Returns the Settings window's Page.
 */
export async function openSettingsWindow(app, page, section) {
  let sw = findSettingsWindow(app)
  if (!sw) {
    ;[sw] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.keyboard.press('ControlOrMeta+,')])
  } else {
    await page.keyboard.press('ControlOrMeta+,')
  }
  await sw.waitForLoadState('domcontentloaded')
  await sw.locator('button.bsw-nav').first().waitFor({ state: 'attached', timeout: 15_000 })
  if (section) await gotoSection(sw, section)
  return sw
}

/**
 * Open the Settings window the way a publish sheet, the Guide or a notice does: the editor window's
 * `window.tw.cloudflare.openSettings()` asks main for the window at its Cloudflare page. Any window
 * already open is closed first, so a new one (at that page) is made. Returns the new Page.
 */
export async function openSettingsAtCloudflare(app, page) {
  await closeSettingsWindow(app)
  const [sw] = await Promise.all([app.waitForEvent('window', { timeout: 15_000 }), page.evaluate(() => window.tw.cloudflare.openSettings())])
  await sw.waitForLoadState('domcontentloaded')
  await sw.locator('button.bsw-nav').first().waitFor({ state: 'attached', timeout: 15_000 })
  return sw
}

/** Pick a page of the Settings window. */
export async function gotoSection(sw, section) {
  await sw.locator(`button.bsw-nav[data-section="${section}"]:visible`).click()
  await sw.waitForTimeout(150)
}

/** Close the Settings window and wait until it is gone. */
export async function closeSettingsWindow(app) {
  const sw = findSettingsWindow(app)
  if (!sw) return
  await sw.close().catch(() => {})
  for (let i = 0; i < 40 && findSettingsWindow(app); i++) await new Promise((r) => setTimeout(r, 50))
}

/** Quit the app under test: close it, and kill its process if it has not gone in `ms`. */
export async function shutdownApp(app, ms = 8000) {
  if (!app) return
  const pid = app.process().pid
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, ms))])
  if (pid) { try { process.kill(pid) } catch { /* gone, as it should be */ } }
}
