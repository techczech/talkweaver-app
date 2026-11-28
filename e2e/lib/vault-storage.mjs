// Exercise the storage browser through the same Explorer entry point as the app.
export async function openVaultStorage(page) {
  const storage = page.getByRole('dialog', { name: 'Vault Gallery', exact: true })
  if (await storage.isVisible()) return storage
  const explorer = page.getByRole('dialog', { name: 'Vault Explorer', exact: true })
    .or(page.getByRole('region', { name: 'Vault Explorer', exact: true }))
  if (!await explorer.isVisible()) {
    await page.getByRole('button', { name: 'Vault Explorer', exact: true }).click()
  }
  await explorer.getByRole('button', { name: 'Tools', exact: true }).click()
  await explorer.getByRole('button', { name: 'Details and storage', exact: true }).click()
  await storage.waitFor()
  return storage
}
