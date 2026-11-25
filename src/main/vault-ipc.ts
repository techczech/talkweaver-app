import { collectGalleryHandouts } from './gallery-handouts'
import { inventoryFilesystem as handoutInventoryFilesystem } from './vault-gallery-inventory-fs'
import { readGallerySource } from './vault-gallery-read'
import { join, basename, dirname } from 'path'
import { canonicalOutlinePath } from './outline-identity'
import { writeTalkOutline } from './talk-writer'
import { linkSync, existsSync, lstatSync, readdirSync, statSync, mkdirSync, realpathSync, cpSync, rmSync, renameSync, mkdtempSync } from 'fs'
import { randomBytes } from 'crypto'
import { resolve as resolvePath, sep as pathSep } from 'path'
import { createFolderTarget, deleteFolderTarget, folderSlugFor, inspectOnlyFolderName, moveTalkTargets, newTalkFolder, renameFolderTargets, setRootRefusal, siblingTalkFolder, talkFolderOfOutline, talkPlace } from './vault-paths'
import { pathStaysInside } from './path-containment'
import { refusalMessage, type AddVaultOutcome } from './vault-view'
import { SERVICE_APPS, writableRoot } from './vault-availability'
import { refusalOutcome, talkFolderRelOf } from './vault-settings-ipc'
import { resolveNewTalkDefaults } from '../shared/vault-defaults'
import { readdir as readdirAsync } from 'fs/promises'
import { METADATA_REGISTRY } from '../shared/metadata-registry'
import { applyMetadataDefaults, normaliseMetadataDefaults } from '../shared/metadata-surfaces'
import { newTalkSource } from '../shared/redesign-window-source'
import { editFrontmatterText, parseFrontmatterPairs } from '../shared/frontmatter-editor'
import { readPathwaySummary } from './pathways'
import type { VaultIpcHost, ProjectionRowMain, TalkInfo } from './index'

/** Registers vault channels on the app's already guarded IPC object. */
export function registerVaultIpc(host: VaultIpcHost): void {
  const {
    ipcMain, BrowserWindow, E2E, afterExampleVaultChange, app, availableVaults, checkVaultAvailability,
    claimGalleryTalk, claimTalkForWindow, currentVaultRoot, dialog, editorWindows,
    establishedGalleryClaims, exampleVault, findOutlineIn, galleryAdmission, galleryCatalogue,
    galleryClaimEpochs, galleryFacts, galleryHandoutSites, galleryReservations, invalidateTalkCache,
    invalidateVaultCaches, metadataDefaults, mkdirInVault, movedEditorReceipts, mutationBlocks,
    otherEditorHolding, otherEditorUnder, outlineDiskGuard, outlineRecovery, primaryVault,
    publishSiteDir, readHandoutRegistry, renameSlugFiles, reserveManagementMutation, resolveGalleryTalk,
    retitleOutline, revokeGalleryReads, rootFs, rootOfVault, scheduleVaultWarm, searchCache, shell,
    slugifyTalk, stripPublishedFields, surfacedWarningCount, talkCache, talkInfoFor, transferMovedEditor,
    vaultAvailability, vaultIndex, vaultOfRoot, vaultRegistry, vaultRel, vaultRootFor, vaultViews,
    watchGallerySender, writableRootFor, writableRootOfVault, writableVaultRoot,
  } = host

  // vault:get-root / set-root / choose-root are single-vault shims over the registry (several vaults,
  // ticket 01): get answers the first open vault; set and choose make the folder the first open vault
  // (reusing its id when it is already a vault) and close the previous one — today's "change vault".
  ipcMain.handle('vault:get-root', () => currentVaultRoot() ?? null)

  // Test-only (TW_E2E=1): the vault root bounds every containment guard, so a renderer-supplied
  // root is refused in the app itself (no config write); Settings and first-run setup use
  // vault:choose-root, a dialog in the main process. In test mode the folder must be an existing
  // absolute directory, and it is adopted through the vault registry.
  ipcMain.handle('vault:set-root', (_event, path: string) => {
    const refusal = setRootRefusal(E2E, path)
    if (refusal) {
      console.warn('[vault:set-root] refused:', refusal)
      return { success: false, error: refusal }
    }
    vaultRegistry.adoptRoot(path)
    searchCache.clear()
    invalidateTalkCache()
    scheduleVaultWarm()
    return { success: true }
  })

  ipcMain.handle('vault:use-default-root', () => {
    const configured = vaultRegistry.primary()
    if (configured) return writableVaultRoot() ?? null
    try {
      const documents = realpathSync(app.getPath('documents'))
      const candidate = join(documents, 'TalkWeaver')
      if (!pathStaysInside(documents, candidate)) return null
      mkdirInVault(documents, candidate)
      const root = writableRoot(candidate, rootFs)
      if (!root) return null
      vaultRegistry.adoptRoot(root)
      invalidateTalkCache()
      scheduleVaultWarm()
      return root
    } catch { return null }
  })

  ipcMain.handle('vault:choose-root', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose Vault Root',
      message: 'Select the folder containing your Talk folders',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths.length) return null
    const chosen = result.filePaths[0]
    vaultRegistry.adoptRoot(chosen)
    searchCache.clear()
    invalidateTalkCache()
    scheduleVaultWarm()
    return chosen
  })

  // vault:list waits for the (asynchronous, time-limited) folder check; it never stats a folder itself.
  ipcMain.handle('vault:list', async () => {
    await checkVaultAvailability().catch(() => false)
    return vaultViews({ fresh: true })
  })

  // The unavailable section's "Check again": look at every open vault's folder now.
  ipcMain.handle('vault:recheck', () => checkVaultAvailability(true).catch(() => false))

  // ⋯ › Reveal in Finder (ticket 07): the folder comes from the registry by vault id, never from the
  // renderer. An unknown id, or a folder that is not there, is refused.
  ipcMain.handle('vault:reveal', (_event, vaultId: unknown): { ok: boolean; reason?: 'unknown-vault' | 'unavailable' } => {
    const vault = typeof vaultId === 'string' ? vaultRegistry.get(vaultId) : null
    if (!vault) return { ok: false, reason: 'unknown-vault' }
    if (vaultAvailability.isUnavailable(vault.id)) return { ok: false, reason: 'unavailable' }
    shell.showItemInFolder(vault.root)
    return { ok: true }
  })

  // The unavailable section's one action when the cloud service is not signed in: open that service's
  // app (a fixed list of apps, never a renderer-supplied path).
  ipcMain.handle('vault:open-service', async (_event, vaultId: unknown): Promise<boolean> => {
    const vault = typeof vaultId === 'string' ? vaultRegistry.get(vaultId) : null
    if (!vault) return false
    const service = vaultAvailability.lastGood(vault.id)?.service ?? vaultAvailability.service(vault)
    const app = SERVICE_APPS[service]
    if (!app || !existsSync(app)) return false
    return (await shell.openPath(app)) === ''
  })

  ipcMain.handle('vault:open-example', async () => {
    const result = await exampleVault.open()
    if (result.ok) await afterExampleVaultChange()
    return result
  })

  ipcMain.handle('vault:add', async (event, path?: unknown): Promise<AddVaultOutcome | null> => {
    let chosen: string
    if (E2E && typeof path === 'string' && path) chosen = path
    else {
      const win = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.OpenDialogOptions = {
        title: 'Add a vault',
        message: 'Choose the folder that holds the talks',
        properties: ['openDirectory', 'createDirectory']
      }
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths.length) return null
      chosen = result.filePaths[0]
    }
    try {
      if (!statSync(chosen).isDirectory()) return { ok: false, reason: 'not-a-folder', message: refusalMessage('not-a-folder', null) }
    } catch {
      return { ok: false, reason: 'not-a-folder', message: refusalMessage('not-a-folder', null) }
    }
    try {
      const added = vaultRegistry.add(chosen)
      const view = vaultViews().find((v) => v.id === added.id)
      return view ? { ok: true, vault: view } : null
    } catch (error) {
      return refusalOutcome(error, vaultViews)
    }
  })

  // Open or close one vault. Closing hides its talks everywhere; nothing in the folder changes. The
  // last open vault stays open (the app needs a vault to work in).
  ipcMain.handle('vault:set-open', (_event, vaultId: unknown, open: unknown): AddVaultOutcome => {
    if (typeof vaultId !== 'string') return { ok: false, reason: 'unknown-vault', message: refusalMessage('unknown-vault', null) }
    try {
      if (open !== true && vaultRegistry.list().filter((v) => v.open && v.id !== vaultId).length === 0 && vaultRegistry.get(vaultId)?.open) {
        return { ok: false, reason: 'last-open', message: refusalMessage('last-open', null) }
      }
      vaultRegistry.setOpen(vaultId, open === true)
      const view = vaultViews().find((v) => v.id === vaultId)
      return view ? { ok: true, vault: view } : { ok: false, reason: 'unknown-vault', message: refusalMessage('unknown-vault', null) }
    } catch (error) {
      return refusalOutcome(error, vaultViews)
    }
  })

  // The talks of one vault: vaultId names it; without one, the first open vault (today's single list).
  // A closed or unknown vault lists nothing and is not scanned. Batches carry the vault id.
  ipcMain.handle('vault:list-talks', async (event, vaultId?: unknown) => {
    const vault = typeof vaultId === 'string' ? vaultRegistry.get(vaultId) : primaryVault()
    if (!vault || !vault.open) return []
    if (vaultAvailability.isUnavailable(vault.id)) return [] // unmounted: not listed, not scanned (ticket 07)
    const cached = await vaultIndex.handle(vault, (batch, reset, done) => {
      if (!event.sender.isDestroyed()) event.sender.send('vault:talks-batch', { vaultId: vault.id, batch, reset, done })
    })
    void vaultIndex.refreshDone(vault.id).then((talks) => {
      talkCache.set(vault.root, { at: Date.now(), talks })
    }).catch((error) => console.error('[vault-index]', error))
    return cached
  })

  ipcMain.handle('vault:gallery-catalogue', (event, generation: unknown) => {
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) throw new Error('Main frame required')
    watchGallerySender(event.sender)
    galleryAdmission.cancel(event.sender.id)
    return galleryCatalogue(generation)
  })

  ipcMain.handle('vault:gallery-talk', (event, id:unknown, path:unknown, epoch:unknown) => {
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) throw new Error('Main frame required')
    return resolveGalleryTalk(id,path,epoch)
  })

  ipcMain.handle('vault:gallery-claim', (event, id:unknown, path:unknown, epoch:unknown) => {
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) throw new Error('Main frame required')
    watchGallerySender(event.sender)
    return claimGalleryTalk(event.sender.id,id,path,epoch)
  })

  ipcMain.handle('vault:gallery-cancel-facts', event => {
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) throw new Error('Main frame required')
    galleryHandoutSites.cancel(event.sender.id); galleryAdmission.cancel(event.sender.id); revokeGalleryReads()
  })

  ipcMain.handle('vault:gallery-handouts', (event, id:unknown, path:unknown) => {
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) throw new Error('Main frame required')
    if (typeof id !== 'string' || typeof path !== 'string') return null
    watchGallerySender(event.sender)
    return galleryAdmission.run(event.sender.id, async live => {
      const epoch=host.galleryEpoch, vault=vaultRegistry.get(id)
      if(!vault?.open || vaultAvailability.isUnavailable(id))return null
      const root=vault.root
      const current=()=>live() && epoch===host.galleryEpoch && vaultRegistry.get(id)?.root===root && !!vaultRegistry.get(id)?.open && !vaultAvailability.isUnavailable(id)
      const known=await galleryCatalogue(0)
      const talk=known.vaults.find(v=>v.id===id)?.talks.find(t=>t.relativeOutline===path)
      if(!talk || !current())return null
      const identity=statSync(root), executable=app.isPackaged ? join(process.resourcesPath,'vault-gallery') : join(app.getAppPath(),'native/vault-gallery')
      const deadline=Date.now()+10000
      const active=()=>current() && Date.now()<deadline
      return collectGalleryHandouts(talk,root,{
        current:active,
        read:p=>readGallerySource(root,join(root,p),active,identity,executable),
        list:async p=>{
          if(!active())throw Error('Cancelled')
          const fs=handoutInventoryFilesystem(root,executable,`${identity.dev}:${identity.ino}`,{deadline})
          const names:string[]=[]
          const cancelled=setInterval(()=>{if(!active())void fs.close()},25)
          try {for await(const name of await fs.children(p)){if(!active() || names.length>=128)throw Error('Run index limit');names.push(name)}}finally{clearInterval(cancelled);await fs.close()}
          if(!active())throw Error('Cancelled')
          return names
        }
      },{siteDir:()=>publishSiteDir(),readRegistry:readHandoutRegistry,acquireSite:folders=>galleryHandoutSites.read(event.sender.id,`${epoch}:${root}:${publishSiteDir()}`,publishSiteDir(),folders,active,executable)}).catch(()=>null)
    })
  })

  ipcMain.handle('vault:gallery-facts', (event, id:unknown, path:unknown, preview:unknown) => {
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) throw new Error('Main frame required')
    if (typeof id !== 'string' || typeof path !== 'string') return null
    watchGallerySender(event.sender)
    return galleryAdmission.run(event.sender.id, live => galleryFacts(id,path,preview === true,live))
  })

  // Outline paths distinguish talks with the same slug in different vaults. Existing slug readers
  // retain the first-open-vault entry.
  ipcMain.handle('vault:talk-meta', async () => {
    try {
      type Meta = {
        slideCount: number | null
        createdMs: number
        editedMs: number
        // First slide's thumb-cache key → the talk's cover (twthumb://slug/coverKey); null until indexed.
        coverKey: string | null
        // Slides with actionable compiler warnings (0 until indexed).
        warningCount: number
        // Frontmatter context lines (mtime-cached parse shared with scanTalks); null when absent.
        subtitle: string | null
        event: string | null
        pathwayCount: number
        pathwayNames: string[]
      }
      const out: Record<string, Meta> = Object.create(null)
      for (const vault of availableVaults()) {
        const root = vault.root
        const persisted = await vaultIndex.metadata(vault)
        for (const talk of await vaultIndex.cached(vault)) {
          const cached = searchCache.get(talk.outlinePath)
          const first = cached?.rows?.[0] as (ProjectionRowMain & { render_hash?: string }) | undefined
          const meta = persisted[talk.slug]
          const pathwaySummary = readPathwaySummary(root, talk.slug)
          const facts: Meta = {
            slideCount: cached ? cached.rows.length : null,
            createdMs: meta?.createdMs ?? 0,
            editedMs: meta?.editedMs ?? 0,
            coverKey: first ? (first.render_hash || first.content_hash || first.slide_id || null) : null,
            warningCount: cached ? surfacedWarningCount(cached.rows) : 0,
            subtitle: meta?.subtitle ?? null,
            event: meta?.event ?? null,
            pathwayCount: pathwaySummary.count,
            pathwayNames: pathwaySummary.names
          }
          out[talk.outlinePath] = facts
          out[talk.slug] ??= facts
        }
      }
      return out
    } catch {
      return {}
    }
  })

  ipcMain.handle('vault:gallery-settle', (event, commit:boolean) => {
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || typeof commit !== 'boolean') throw new Error('Main frame and settlement required')
    const id = event.sender.id
    const previous = galleryReservations.get(id)
    const valid = galleryClaimEpochs.get(id) === host.galleryEpoch
    const rollback = () => {
      if (previous !== undefined) {
        const result = claimTalkForWindow(id, previous)
        if (!result.ok) throw new Error('Reserved outgoing claim could not be restored')
      }
      galleryReservations.delete(id); galleryClaimEpochs.delete(id)
    }
    if (!commit || !valid) {
      rollback()
      return {ok: !commit}
    }
    const entry = editorWindows.get(id)
    const owned = entry?.outlinePath && vaultRegistry.resolve(entry.outlinePath)
    if (!entry || !owned || !owned.vault.open || vaultAvailability.isUnavailable(owned.vault.id)) {
      rollback()
      return {ok:false}
    }
    try {
      const root = statSync(owned.vault.root)
      establishedGalleryClaims.set(id,{vaultId:owned.vault.id,root:owned.vault.root,path:entry.outlinePath!,dev:root.dev,ino:root.ino,revoked:false})
    } catch {
      rollback()
      return {ok:false}
    }
    galleryReservations.delete(id)
    return {ok:true}
  })

  // Create a talk in the chosen open vault.
  ipcMain.handle('vault:create-talk', async (event, opts: { title: string; slug: string; topicFolder?: string; vaultId?: string; startWithSketch?: boolean }) => {
    // An unavailable vault (or one whose folder has just gone) gets no new talk: its folder is never
    // re-created (ticket 07).
    const vaultRoot = writableRootOfVault(opts?.vaultId)
    if (!vaultRoot) return null
    try {
      const { title, slug, topicFolder } = opts
      if (typeof title !== 'string' || !title.trim() || /[\r\n]/.test(title)) return null
      // slug / topicFolder come from the renderer: the new talk folder must land inside the vault.
      const target = newTalkFolder(vaultRoot, slug, topicFolder)
      if (!target.ok) { console.error('[vault:create-talk] refused', target.error); return null }
      const talkDir = target.path
      const releaseMutation = reserveManagementMutation(event.sender.id, [talkDir])
      if (!releaseMutation) return null
      try {
      const outlinePath = join(talkDir, slug + '-outline.md')
      if (existsSync(talkDir) || !pathStaysInside(vaultRoot, talkDir)) return null
      mkdirInVault(vaultRoot, dirname(talkDir))
      mkdirSync(talkDir)
      {
        const initialContent = newTalkSource(title, opts.startWithSketch === true ? null : randomBytes(5).toString('hex'))
        // Pre-fill the presenter's identity and house style: the vault file's affiliation, style and
        // logo, then this person's author for the vault, then Settings → Presenter identity and deck
        // defaults (several-vaults ticket 04). fill-missing only: nothing already in the template is
        // touched, and a blank default writes nothing at all.
        const vault = vaultOfRoot(vaultRoot)
        const vaultFile = vault ? vaultRegistry.readFile(vault.id) : null
        const { defaults } = resolveNewTalkDefaults({
          vaultFile: vaultFile?.state === 'ok' ? vaultFile.file : null,
          personal: vault ? vaultRegistry.personal(vault.id) : null,
          app: metadataDefaults(),
          talkFolderRel: talkFolderRelOf(vaultRoot, talkDir)
        })
        const { edits } = applyMetadataDefaults(parseFrontmatterPairs(initialContent), normaliseMetadataDefaults(METADATA_REGISTRY, defaults), { mode: 'fill-missing' })
        const seeded = edits.length > 0 ? editFrontmatterText(initialContent, edits) : initialContent
        const created = await writeTalkOutline(outlinePath, seeded, 'create-talk')
        if (!created.ok) throw new Error(created.error)
      }
      invalidateTalkCache(vaultRoot)
      return { name: slug, path: talkDir, outlinePath, title, slug } satisfies TalkInfo
      } finally { releaseMutation() }
    } catch (e) {
      console.error('[vault:create-talk]', e)
      return null
    }
  })

  // Clone a talk: copy its whole folder (skip bundle/ + logs), rename slug files, retitle, strip the
  // published handout_url. Lands as a sibling (same parent folder), exactly like Raycast's Duplicate.
  ipcMain.handle('vault:clone-talk', async (event, outlinePath: string, newTitle: string) => {
    if (galleryReservations.has(event.sender.id) || (movedEditorReceipts.has(event.sender.id) && !movedEditorReceipts.get(event.sender.id)!.settled)) return null
    if (mutationBlocks(outlinePath)) return null
    if (otherEditorHolding(outlinePath, editorWindows.get(event.sender.id)?.win)) return null
    // outlinePath comes from the renderer: clone only a talk folder inside the vault, to a sibling
    // folder that is still inside it.
    const vaultRoot = writableRootFor(outlinePath)
    if (!vaultRoot) return null // the talk's vault is unavailable: nothing is copied into it
    const src = talkFolderOfOutline(vaultRoot, outlinePath)
    if (!src.ok) { console.error('[vault:clone-talk] refused', src.error); return null }
    try {
      const srcDir = src.path
      const oldSlug = basename(outlinePath).replace('-outline.md', '')
      const siblingFor = (slug: string): string => {
        const sibling = siblingTalkFolder(vaultRoot, srcDir, slug)
        if (!sibling.ok) throw new Error(sibling.error)
        return sibling.path
      }
      const titleSlug = folderSlugFor(slugifyTalk(newTitle))
      let newSlug = titleSlug || `${oldSlug}-copy`
      let target = siblingFor(newSlug)
      // Never clobber: suffix -2, -3, … until the folder name is free.
      let n = 2
      while (existsSync(target)) { newSlug = `${titleSlug || oldSlug}-${n}`; target = siblingFor(newSlug); n += 1 }
      if (otherEditorUnder(target, editorWindows.get(event.sender.id)?.win)) return null
      const releaseMutation = reserveManagementMutation(event.sender.id, [srcDir, target])
      if (!releaseMutation) return null
      try {
      const place = talkPlace(srcDir)
      // Hidden, operation-owned preparation. No catalogue can discover a partially sanitised talk.
      const stage = mkdtempSync(join(vaultRoot, '.tw-clone-'))
      const stageIdentity = lstatSync(stage)
      const prepared = join(stage, newSlug)
      try {
        const skip = new Set(['bundle', 'dist', '.deck-server.log', '_PRESENTATIONS'])
        cpSync(srcDir, prepared, {
          recursive: true,
          filter: (source) => !source.slice(srcDir.length + 1).split(pathSep).some(part => skip.has(part))
        })
        renameSlugFiles(prepared, oldSlug, newSlug)
        const newOutline = findOutlineIn(prepared)
        if (!newOutline || !lstatSync(newOutline).isFile() || lstatSync(newOutline).isSymbolicLink()) throw new Error('Duplicate outline must be a regular copied file')
        // The writer checks this after its awaits, where the bytes would go in: a link in the stage would take them out of it.
        const made = [stage, prepared, newOutline].map((path) => ({ path, was: lstatSync(path) }))
        const stillStage = () => {
          for (const { path, was } of made) {
            const now = lstatSync(path)
            if (now.dev !== was.dev || now.ino !== was.ino || now.isSymbolicLink()) throw new Error('Duplicate stage changed')
          }
        }
        await retitleOutline(newOutline, newTitle, stillStage)
        await stripPublishedFields(newOutline, stillStage)
        // The writer yielded and another process may have acted: the copy already read stands, the place it lands is judged again.
        stillStage()
        const stillSource = talkFolderOfOutline(vaultRoot, outlinePath)
        const stillTarget = siblingTalkFolder(vaultRoot, srcDir, newSlug)
        if (!stillSource.ok || stillSource.path !== srcDir || !stillTarget.ok || stillTarget.path !== target || talkPlace(srcDir) !== place) throw new Error('Talk folder changed during duplicate')
        // mkdir is the exclusive destination claim: rename alone would replace an empty racer.
        mkdirSync(target)
        const targetIdentity = lstatSync(target)
        try {
          const sameTarget = () => {
            const current = lstatSync(target)
            if (current.dev !== targetIdentity.dev || current.ino !== targetIdentity.ino || current.isSymbolicLink()) throw new Error('Duplicate destination replaced')
          }
          // Publish the fully prepared outline last. Never overwrite a concurrent entry.
          const outlineName = basename(newOutline)
          for (const name of readdirSync(prepared).filter(name => name !== outlineName)) {
            sameTarget()
            cpSync(join(prepared, name), join(target, name), {recursive:true, errorOnExist:true, force:false})
          }
          sameTarget()
          linkSync(newOutline, join(target, outlineName))
        } catch (error) {
          // Preserve partial output for recovery; never recursively delete a publicly reachable name.
          console.error('[vault:clone-talk] unpublished preparation retained', target)
          throw error
        }
      } finally {
        const current = lstatSync(stage)
        if (current.dev === stageIdentity.dev && current.ino === stageIdentity.ino && !current.isSymbolicLink()) rmSync(stage, {recursive:true})
      }
      invalidateVaultCaches(outlinePath)
      return talkInfoFor(target)
      } finally { releaseMutation() }
    } catch (e) {
      console.error('[vault:clone-talk]', e)
      return null
    }
  })

  // Rename a talk IN PLACE: retitle the frontmatter and, when the new title yields a new slug,
  // rename the talk folder + every slug-prefixed file in it (same mechanics as clone). The
  // published handout_url is kept — renaming a talk does not unpublish it. Refuses (returns
  // null) if the target folder name is already taken, rather than guessing a suffix: unlike a
  // clone, a rename must land exactly where the author pointed it.
  ipcMain.handle('vault:rename-talk', async (event, outlinePath: string, newTitle: string) => {
    if (galleryReservations.has(event.sender.id) || (movedEditorReceipts.has(event.sender.id) && !movedEditorReceipts.get(event.sender.id)!.settled)) return null
    if (mutationBlocks(outlinePath)) return null
    let movedIdentity: {path:string;dev:number;ino:number} | null = null
    try {
      const title = String(newTitle || '').trim()
      if (!title) return null
      // Refuse while ANOTHER window holds this talk open: its autosave would recreate the old
      // path after the move and the two files would drift apart (same hazard class as the
      // 2026-07-05 empty-write incident). The requesting window is expected to flush + re-select.
      if (otherEditorHolding(outlinePath, editorWindows.get(event.sender.id)?.win)) return { error: 'open-elsewhere' }
      // outlinePath comes from the renderer: rename only a talk folder inside the vault, to a sibling
      // folder that is still inside it.
      const vaultRoot = vaultRootFor(outlinePath)
      const src = talkFolderOfOutline(vaultRoot, outlinePath)
      if (!src.ok) { console.error('[vault:rename-talk] refused', src.error); return null }
      const srcDir = src.path
      const place = talkPlace(srcDir)
      // The writer checks this after its awaits, where the bytes would go in: the same talk, standing where it was judged.
      const stillThisTalk = () => {
        const now = talkFolderOfOutline(vaultRoot, outlinePath)
        if (!now.ok || now.path !== srcDir || talkPlace(srcDir) !== place) throw new Error('Talk folder changed during rename')
      }
      const oldSlug = basename(outlinePath).replace('-outline.md', '')
      const titleSlug = slugifyTalk(title) || oldSlug
      const newSlug = titleSlug === oldSlug ? oldSlug : folderSlugFor(titleSlug)
      let dir = srcDir
      let releaseMutation: (() => void) | null = null
      try {
      if (newSlug !== oldSlug) {
        const sibling = siblingTalkFolder(vaultRoot, srcDir, newSlug)
        if (!sibling.ok) { console.error('[vault:rename-talk] refused', sibling.error); return null }
        const target = sibling.path
        if (otherEditorUnder(target, editorWindows.get(event.sender.id)?.win)) return {error:"open-elsewhere"}
        if (existsSync(target)) return { error: 'target-exists' }
        releaseMutation = reserveManagementMutation(event.sender.id, [srcDir, target])
        if (!releaseMutation) return null
        await retitleOutline(outlinePath, title, stillThisTalk)
        // The writer yielded and another process may have acted: nothing moves until the folder and its destination are judged again.
        const stillSource = talkFolderOfOutline(vaultRoot, outlinePath)
        const stillTarget = siblingTalkFolder(vaultRoot, srcDir, newSlug)
        if (!stillSource.ok || stillSource.path !== srcDir || !stillTarget.ok || stillTarget.path !== target || existsSync(target) || talkPlace(srcDir) !== place) throw new Error('Talk folder changed during rename')
        const oldReal = canonicalOutlinePath(outlinePath)
        outlineDiskGuard.forget(srcDir) // the app's own move or delete: never reported as a removal on disk
        const sourceIdentity = lstatSync(srcDir)
        renameSync(srcDir, target)
        movedIdentity = {path:target,dev:sourceIdentity.dev,ino:sourceIdentity.ino}
        renameSlugFiles(target, oldSlug, newSlug)
        dir = target
        const movedOutline = findOutlineIn(target)
        if (!movedOutline) throw new Error("Moved outline missing")
        transferMovedEditor(event.sender.id, outlinePath, movedOutline)
        // The talk's recovery copy (if any) moves with it, so its next open still offers it.
        const moved = findOutlineIn(target)
        if (moved) await outlineRecovery.rekey(oldReal, canonicalOutlinePath(moved)).catch((e) => console.error('[outline-recovery] rekey', e))
      }
      if (!releaseMutation) { releaseMutation = reserveManagementMutation(event.sender.id, [dir]); if (!releaseMutation) return null }
      const newOutline = findOutlineIn(dir)
      if (newOutline && newSlug === oldSlug) { await retitleOutline(newOutline, title, stillThisTalk); transferMovedEditor(event.sender.id, outlinePath, newOutline) }
      invalidateVaultCaches(outlinePath)
      return talkInfoFor(dir)
      } finally { releaseMutation?.() }
    } catch (e) {
      console.error('[vault:rename-talk]', e)
      if (movedIdentity) {
        const current = lstatSync(movedIdentity.path)
        if (current.dev === movedIdentity.dev && current.ino === movedIdentity.ino && !current.isSymbolicLink()) {
          const actual = talkInfoFor(movedIdentity.path)
          if (actual) { transferMovedEditor(event.sender.id, outlinePath, actual.outlinePath); return actual }
        }
      }
      return null
    }
  })

  // Create a folder under the vault (optionally nested under parentRel). Returns its vault-rel path.
  ipcMain.handle('vault:create-folder', (event, name: string, parentRel?: string, vaultId?: string) => {
    const vaultRoot = writableRootOfVault(vaultId)
    if (!vaultRoot) return null
    try {
      // name / parentRel come from the renderer: the new folder must land inside the vault.
      const target = createFolderTarget(vaultRoot, name, parentRel)
      if (!target.ok) { console.error('[vault:create-folder] refused', target.error); return null }
      const dir = target.path
      const releaseMutation = reserveManagementMutation(event.sender.id, [dir])
      if (!releaseMutation) return null
      try {
      if (existsSync(dir)) return vaultRel(dir) // already there — idempotent
      mkdirInVault(vaultRoot, dir)
      invalidateTalkCache(vaultRoot)
      return vaultRel(dir)
      } finally { releaseMutation() }
    } catch (e) {
      console.error('[vault:create-folder]', e)
      return null
    }
  })

  // Rename a folder (by its vault-rel path). Returns the new vault-rel path.
  ipcMain.handle('vault:rename-folder', async (event, folderRel: string, newName: string, vaultId?: string) => {
    if (galleryReservations.has(event.sender.id) || (movedEditorReceipts.has(event.sender.id) && !movedEditorReceipts.get(event.sender.id)!.settled)) return null
    const vaultRoot = writableRootOfVault(vaultId)
    if (!vaultRoot || !folderRel) return null
    try {
      // folderRel / newName come from the renderer: a folder inside the vault (never the vault root)
      // renamed to a sibling that is still inside the vault.
      const target = renameFolderTargets(vaultRoot, folderRel, newName)
      if (!target.ok) { console.error('[vault:rename-folder] refused', target.error); return null }
      const { src, dest } = target
      if (otherEditorUnder(src, editorWindows.get(event.sender.id)?.win)) return null
      if (otherEditorUnder(dest, editorWindows.get(event.sender.id)?.win)) return null
      if (!existsSync(src) || existsSync(dest)) return null
      const releaseMutation = reserveManagementMutation(event.sender.id, [src, dest])
      if (!releaseMutation) return null
      try {
      const oldReal = canonicalOutlinePath(src)
      outlineDiskGuard.forget(src) // the app's own move or delete: never reported as a removal on disk
      renameSync(src, dest)
      transferMovedEditor(event.sender.id, src, dest)
      try { await outlineRecovery.rekey(oldReal, canonicalOutlinePath(dest), { under: true }).catch((e) => console.error('[outline-recovery] rekey', e)) } catch (error) { console.error('[move recovery refresh]',error) }
      try { invalidateVaultCaches(vaultRoot) } catch (error) { console.error('[move refresh]', error) }
      return vaultRel(dest)
      } finally { releaseMutation() }
    } catch (e) {
      console.error('[vault:rename-folder]', e)
      return null
    }
  })

  // Move a talk's whole folder into destFolderRel ('' = vault root). Returns the moved TalkInfo.
  ipcMain.handle('vault:move-talk', async (event, outlinePath: string, destFolderRel: string) => {
    if (galleryReservations.has(event.sender.id) || (movedEditorReceipts.has(event.sender.id) && !movedEditorReceipts.get(event.sender.id)!.settled)) return null
    if (mutationBlocks(outlinePath)) return null
    if (otherEditorHolding(outlinePath, editorWindows.get(event.sender.id)?.win)) return null
    const vaultRoot = writableRootFor(outlinePath)
    if (!vaultRoot) return null
    try {
      // outlinePath / destFolderRel come from the renderer: move a talk folder inside the vault to a
      // folder inside the vault ('' = the vault root).
      const target = moveTalkTargets(vaultRoot, outlinePath, destFolderRel)
      if (!target.ok) { console.error('[vault:move-talk] refused', target.error); return null }
      const { srcDir, destParent, dest } = target
      if (resolvePath(dest) === resolvePath(srcDir)) return talkInfoFor(srcDir) // no-op (same folder)
      if (otherEditorUnder(dest, editorWindows.get(event.sender.id)?.win)) return null
      if (existsSync(dest)) return null // a talk of that name already lives there
      const releaseMutation = reserveManagementMutation(event.sender.id, [srcDir, dest])
      if (!releaseMutation) return null
      try {
      mkdirInVault(vaultRoot, destParent)
      const oldReal = canonicalOutlinePath(srcDir)
      outlineDiskGuard.forget(srcDir) // the app's own move or delete: never reported as a removal on disk
      renameSync(srcDir, dest)
      transferMovedEditor(event.sender.id, srcDir, dest)
      try { await outlineRecovery.rekey(oldReal, canonicalOutlinePath(dest), { under: true }).catch((e) => console.error('[outline-recovery] rekey', e)) } catch (error) { console.error('[move recovery refresh]',error) }
      try { invalidateVaultCaches(vaultRoot) } catch (error) { console.error('[move refresh]', error) }
      return talkInfoFor(dest)
      } finally { releaseMutation() }
    } catch (e) {
      console.error('[vault:move-talk]', e)
      return null
    }
  })

  // List CATEGORY folders under the vault (vault-rel paths), INCLUDING empty ones — so a folder you
  // just created is visible in the sidebar even before any talk lives in it. A "category folder" is a
  // directory that is NOT itself a talk folder (a talk folder directly contains a *-outline.md).
  ipcMain.handle('vault:list-folders', async (_event, vaultId?: string) => {
    const vaultRoot = rootOfVault(vaultId)
    if (!vaultRoot) return []
    const isTalkDir = async (dir: string): Promise<boolean> => {
      try { return (await readdirAsync(dir)).some((f) => f.endsWith('-outline.md')) } catch { return false }
    }
    const out: string[] = []
    const vaults = vaultRegistry.list() // one config read for every folder's relative path
    const scan = async (dir: string, depth: number): Promise<void> => {
      if (depth > 3) return
      let entries
      try { entries = await readdirAsync(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        const name = entry.name
        // Assets, research and system folders are never categories. The browser's disk listing still shows them, inspect-only.
        if (inspectOnlyFolderName(name)) continue
        if (!entry.isDirectory()) continue
        const full = join(dir, name)
        if (await isTalkDir(full)) continue // a talk, not a category folder
        out.push(vaultRel(full, vaults))
        await scan(full, depth + 1)
      }
    }
    await scan(vaultRoot, 0)
    return out
  })

  // Delete a talk — moved to the OS Trash (recoverable), not hard-deleted, so an accidental
  // create/clone can be undone from Finder.
  ipcMain.handle('vault:delete-talk', async (event, outlinePath: string) => {
    if (galleryReservations.has(event.sender.id) || (movedEditorReceipts.has(event.sender.id) && !movedEditorReceipts.get(event.sender.id)!.settled)) return false
    if (mutationBlocks(outlinePath)) return false
    if (otherEditorHolding(outlinePath, editorWindows.get(event.sender.id)?.win)) return false
    // outlinePath comes from the renderer: trash only a talk folder inside the vault, never the vault
    // root or anything outside it.
    const target = talkFolderOfOutline(vaultRootFor(outlinePath), outlinePath)
    if (!target.ok) { console.error('[vault:delete-talk] refused', target.error); return false }
    const releaseMutation = reserveManagementMutation(event.sender.id, [target.path])
    if (!releaseMutation) return false
    let tracked: string[] = []
    try {
      tracked = outlineDiskGuard.openUnder(target.path)
      await shell.trashItem(target.path)
      for (const path of tracked) await outlineDiskGuard.check(path).catch(e => console.error('[vault:delete-talk] check',e))
      invalidateVaultCaches(outlinePath)
      return true
    } catch (e) {
      console.error('[vault:delete-talk]', e)
      for (const path of tracked) await outlineDiskGuard.check(path).catch(error => console.error('[vault:delete-talk] recovery check', error))
      return false
    } finally { releaseMutation() }
  })

  // Delete a category folder (and anything inside it) — also to the OS Trash (recoverable).
  ipcMain.handle('vault:delete-folder', async (event, folderRel: string, vaultId?: string) => {
    if (galleryReservations.has(event.sender.id) || (movedEditorReceipts.has(event.sender.id) && !movedEditorReceipts.get(event.sender.id)!.settled)) return false
    const vaultRoot = writableRootOfVault(vaultId)
    if (!vaultRoot || !folderRel) return false
    // folderRel comes from the renderer: a folder inside the vault, never the vault root.
    const target = deleteFolderTarget(vaultRoot, folderRel)
    if (!target.ok) { console.error('[vault:delete-folder] refused', target.error); return false }
    if (otherEditorUnder(target.path, editorWindows.get(event.sender.id)?.win)) return false
    const releaseMutation = reserveManagementMutation(event.sender.id, [target.path])
    if (!releaseMutation) return false
    let tracked: string[] = []
    try {
      tracked = outlineDiskGuard.openUnder(target.path)
      // A talk open in a window inside the folder is NOT forgotten: once the folder is in the Bin its
      // window shows the removed-file bar (shared-talk ticket 08), its saves are refused (a recovery copy
      // keeps the typing) and nothing is recreated unless the person chooses Save it again.
      await shell.trashItem(target.path)
      for (const realPath of tracked) await outlineDiskGuard.check(realPath).catch((e) => console.error('[vault:delete-folder] check', e))
      invalidateVaultCaches(vaultRoot)
      return true
    } catch (e) {
      console.error('[vault:delete-folder]', e)
      for (const path of tracked) await outlineDiskGuard.check(path).catch(error => console.error('[vault:delete-folder] recovery check', error))
      return false
    } finally { releaseMutation() }
  })
}
