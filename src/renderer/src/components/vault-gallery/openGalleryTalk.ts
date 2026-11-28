import type { TalkInfo } from '../../../../preload'
import type { GalleryTalk } from '../../../../shared/vault-gallery'
import type { GalleryOpenGuard } from '../../lib/talkSelection'

export const VAULT_CHANGED = 'The vault changed while opening this talk. Choose it again from the current catalogue.'

export async function openGalleryTalk(
  talk: GalleryTalk,
  rootGeneration: number,
  isCurrent: () => boolean,
  open: (talk: TalkInfo, guard: GalleryOpenGuard<TalkInfo>) => Promise<boolean>
): Promise<boolean> {
  let lost = false
  const resolve = async () => {
    const found = await window.tw.vault.galleryTalk(talk.vaultId, talk.relativeOutline, rootGeneration).catch(error => {
      lost = true
      throw error
    })
    const same = !!found && (found.vaultId ?? talk.vaultId) === talk.vaultId
    if (!same) lost = true
    return same ? found : null
  }
  const target = await resolve()
  if (!isCurrent()) throw new Error(VAULT_CHANGED)
  if (!target) throw new Error('This talk is no longer available in the known catalogue.')
  const opened = await open(target, {
    settle: async commit => {
      const result = await window.tw.vault.gallerySettle(commit)
      if (commit && !result.ok) lost = true
      return result
    },
    isCurrent,
    revalidate: resolve,
    claim: async path => {
      if (path !== target.outlinePath) return await window.tw.windows.claimTalk(path)
      const result = await window.tw.vault.galleryClaim(talk.vaultId, talk.relativeOutline, rootGeneration)
      if (!result.ok && result.reason === 'stale') throw new Error(VAULT_CHANGED)
      return result
    }
  })
  if (!opened && (lost || !isCurrent())) throw new Error(VAULT_CHANGED)
  return opened && isCurrent()
}
