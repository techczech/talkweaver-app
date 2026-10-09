// The twthumb:// address of one rendered picture. Pictures live in per-vault cache folders, so a
// row from a vault names it (`?vault=<id>`): without it the lookup tries the open vaults in order and
// can show another vault's render of a talk with the same slug (several-vaults ticket 02 review).
// The address itself (slug and key percent-encoded in the path) is shared/thumb-url.ts, which the
// main-process handler reads back.
import { thumbAddress } from '../../../shared/thumb-url.ts'

export function thumbUrl(slug: string, key: string, vaultId?: string | null): string {
  const base = thumbAddress(slug, key)
  return vaultId ? `${base}?vault=${encodeURIComponent(vaultId)}` : base
}
