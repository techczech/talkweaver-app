// The twthumb:// address of one rendered picture. Pictures live in per-vault cache folders, so a
// row from a vault names it (`?vault=<id>`): without it the lookup tries the open vaults in order and
// can show another vault's render of a talk with the same slug (several-vaults ticket 02 review).
export function thumbUrl(slug: string, key: string, vaultId?: string | null): string {
  const base = `twthumb://${slug}/${key}`
  return vaultId ? `${base}?vault=${encodeURIComponent(vaultId)}` : base
}
