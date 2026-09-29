// The slide picker's Files tree starts with every folder closed (one default and one folder memory
// with the file list; Dominik, 0.34.0-preview.2 check). Tests that reach a talk or a nested folder
// in it open the folders on the way, as a person does, with each folder's disclosure triangle (a
// click on the row itself scopes the folder).
const TREE = '.lt-browser-root .lt-ftree'
const ARCHIVE = 'z-old-powerpoint-imports'

/** Opens every closed folder in the picker's Files tree, nested ones too; the Archive only when
 *  `archive` is true. */
export async function openPickerFolders(page, { archive = false } = {}) {
  for (let i = 0; i < 200; i += 1) {
    const closed = await page.locator(`${TREE} [data-folder-path][aria-expanded="false"]`).evaluateAll(
      (els) => els.map((e) => e.getAttribute('data-folder-path')))
    const next = closed.find((p) => archive || (p !== ARCHIVE && !p.startsWith(`${ARCHIVE}/`)))
    if (next == null) return
    await page.locator(`${TREE} [data-folder-path="${next}"] .lt-disc`).first().click()
    await page.locator(`${TREE} [data-folder-path="${next}"][aria-expanded="true"]`).first().waitFor()
  }
}

/** The picker's Files-tree row of a talk, its folders opened first. */
export async function pickerTalkRow(page, slug) {
  const row = page.locator(`${TREE} [data-talk-slug="${slug}"]`)
  if (!await row.count()) await openPickerFolders(page, { archive: true })
  return row.first()
}
