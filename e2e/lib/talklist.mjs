const DEFAULT_TIMEOUT = 8000
const TALKS_PANEL = 'aside.talk-list.tl-panel'
const TALKS_TREE = `${TALKS_PANEL} .tl-tree`
const TALK_ROWS = `${TALKS_TREE} [data-talk-title]`

function errorDetail(error) {
  return error instanceof Error ? error.message : String(error)
}

export function talkRows(page) {
  return page.locator(TALK_ROWS)
}

export function talkSearchInput(page) {
  return page.locator(`${TALKS_PANEL} .tl-search input[aria-label="Filter talks"]`).first()
}

export function activeTalkRow(page) {
  return page.locator(`${TALK_ROWS}[aria-selected="true"]`).first()
}

export async function ensureTalksMode(page, { timeout = DEFAULT_TIMEOUT } = {}) {
  const panel = page.locator(TALKS_PANEL).first()
  if (await panel.isVisible().catch(() => false)) return panel

  const expandSidebar = page.locator('[data-sidebar-expand]').first()
  if (await expandSidebar.isVisible().catch(() => false)) {
    await expandSidebar.click()
  }

  const talksTab = page.locator('.sidebar-mode-btn').filter({ hasText: /^Talks$/ }).first()
  try {
    await talksTab.waitFor({ state: 'visible', timeout })
    await talksTab.click()
    await panel.waitFor({ state: 'visible', timeout })
  } catch (error) {
    throw new Error(
      `Talks mode did not become available within ${timeout}ms: ${errorDetail(error)}`,
      { cause: error }
    )
  }
  return panel
}

export async function waitForTalkList(page, { timeout = DEFAULT_TIMEOUT } = {}) {
  const panel = await ensureTalksMode(page, { timeout })
  try {
    await page.locator(TALKS_TREE).first().waitFor({ state: 'visible', timeout })
  } catch (error) {
    throw new Error(
      `Talks list did not become visible within ${timeout}ms: ${errorDetail(error)}`,
      { cause: error }
    )
  }
  return panel
}

async function returnToVaultRoot(page) {
  const vaultCrumb = page.locator(`${TALKS_PANEL} .tl-crumbs button`).filter({ hasText: /^Vault$/ }).first()
  if (await vaultCrumb.isVisible().catch(() => false)) {
    await vaultCrumb.click()
  }
}

async function mountedRowMatching(page, predicate) {
  const rows = talkRows(page)
  const count = await rows.count()
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index)
    const title = await row.getAttribute('data-talk-title')
    const slug = await row.getAttribute('data-talk-slug')
    if (predicate({ title, slug })) return row
  }
  return null
}

async function scrollForTalkRow(page, predicate, timeout) {
  const tree = page.locator(TALKS_TREE).first()
  await tree.evaluate((element) => { element.scrollTop = 0 })

  const deadline = Date.now() + timeout
  let previousTop = -1
  while (Date.now() < deadline) {
    const match = await mountedRowMatching(page, predicate)
    if (match) return match

    const position = await tree.evaluate((element) => {
      const maximum = Math.max(0, element.scrollHeight - element.clientHeight)
      const next = Math.min(maximum, element.scrollTop + Math.max(120, Math.floor(element.clientHeight * 0.8)))
      return { top: element.scrollTop, next, maximum }
    })
    const canAdvance = position.top < position.maximum
      && position.top !== previousTop
      && position.next !== position.top
    if (canAdvance) {
      previousTop = position.top
      await tree.evaluate((element, next) => { element.scrollTop = next }, position.next)
    }
    await page.waitForTimeout(60)
  }
  return null
}

function normaliseTalkTitle(title) {
  return String(title ?? '').trim().toLowerCase()
}

export async function talkRowByTitle(page, title, { timeout = DEFAULT_TIMEOUT } = {}) {
  await waitForTalkList(page, { timeout })
  await returnToVaultRoot(page)

  const requestedTitle = String(title).trim()
  const normalisedTitle = normaliseTalkTitle(requestedTitle)
  const search = talkSearchInput(page)
  await search.fill(requestedTitle)

  const row = await scrollForTalkRow(
    page,
    ({ title: candidate }) => normaliseTalkTitle(candidate) === normalisedTitle,
    timeout
  )
  if (row) return row

  await search.fill('').catch(() => {})
  throw new Error(`Talk row "${requestedTitle}" did not appear in the Talks list within ${timeout}ms`)
}

async function otherTalkRow(page, title, timeout) {
  await returnToVaultRoot(page)
  await talkSearchInput(page).fill('')
  const normalisedTitle = normaliseTalkTitle(title)
  return scrollForTalkRow(
    page,
    ({ title: candidate }) => candidate != null && normaliseTalkTitle(candidate) !== normalisedTitle,
    timeout
  )
}

export async function openTalkByTitle(
  page,
  title,
  { timeout = DEFAULT_TIMEOUT, forceReload = false } = {}
) {
  await waitForTalkList(page, { timeout })

  if (forceReload) {
    const other = await otherTalkRow(page, title, timeout)
    if (!other) {
      throw new Error(`Cannot force-reload talk "${title}": no different talk row appeared in the Talks list`)
    }
    await other.click()
    await page.waitForTimeout(300)
  }

  const row = await talkRowByTitle(page, title, { timeout })
  await row.click()
  await talkSearchInput(page).fill('')
  await page.locator('.cm-content').first().waitFor({ state: 'visible', timeout })
  return true
}

export async function openFirstTalk(page, { timeout = DEFAULT_TIMEOUT } = {}) {
  await waitForTalkList(page, { timeout })
  await returnToVaultRoot(page)
  await talkSearchInput(page).fill('')

  const row = await scrollForTalkRow(page, () => true, timeout)
  if (!row) {
    throw new Error(`No talk row appeared in the Talks list within ${timeout}ms`)
  }

  await row.click()
  await page.locator('.cm-content').first().waitFor({ state: 'visible', timeout })
  return true
}
