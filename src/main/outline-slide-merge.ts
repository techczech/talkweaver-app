import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { ID_TOKEN_RE } from '../../compiler/scripts/lib/slide-id.mjs'
import type { EditorDocumentReply, EditorDocumentRequestBody } from '../shared/editor-document.ts'
import { applySlideMerge, normalizeOutlineMergeText, planSlideMerge, type SlideMergeChoices } from '../shared/outline-merge.ts'
import { summarizeSlideMerge, type SlideMergeApplyReply, type SlideMergeFailure, type SlideMergeReviewReply } from '../shared/outline-slide-merge.ts'
import { structureOf } from '../shared/talk-structure.ts'
import { hashOutlineText, type OutlineDiskGuard } from './outline-disk-guard.ts'
import { outlineIdentity } from './outline-identity.ts'
import type { OutlineRecovery } from './outline-recovery.ts'
import type { ObservedOutlineDisk, TalkWriteResult } from './talk-writer.ts'

interface SlideMergeDeps {
  guard: OutlineDiskGuard
  recovery: Pick<OutlineRecovery, 'preserveMerge'>
  vaultFor(owner: string, path: string): string | null
  readWindow(owner: string, path: string): Promise<string>
  reservedIds(vault: string): Promise<Iterable<string>>
  stageInWindow(owner: string, request: Extract<EditorDocumentRequestBody, { kind: 'slide-merge' }>): Promise<EditorDocumentReply | null>
}

type Refusal = Extract<SlideMergeFailure, { error: string }>['reason']
const refuse = (reason: Refusal, error: string): SlideMergeFailure => ({ ok: false, reason, error })
const ownership = () => refuse('ownership', 'This window no longer has that talk open in its vault.')
const stalePlan = () => refuse('stale-plan', 'This merge review expired. Review the changes again.')
const staleDisk = () => refuse('stale-disk', 'The talk changed on disk after this review. Review it again.')
const detail = (error: unknown) => error instanceof Error ? error.message : String(error)

interface PendingWrite {
  text?: string
  result?: Promise<TalkWriteResult>
}

interface Review {
  view: Extract<SlideMergeReviewReply, { ok: true }>
  plan: ReturnType<typeof planSlideMerge>
  disk: ObservedOutlineDisk
  current(): boolean
  writing?: PendingWrite
}

const sectionTitles = (source: string) => {
  const { nodes } = structureOf(normalizeOutlineMergeText(source))
  return new Map(nodes.map(node => [node.line + 1,
    node.ancestors.map(i => nodes[i]).reverse().find(parent => parent.section)?.title ?? null]))
}

const comparable = (text: string | undefined) =>
  text === undefined ? undefined : normalizeOutlineMergeText(text).replace(/\n+$/, '')

const idsIn = (text: string) => Array.from(text.matchAll(new RegExp(ID_TOKEN_RE.source, 'g')), match => match[1])

/** Only main keeps the trusted snapshots. The renderer can choose rows, never submit its own plan. */
export function createOutlineSlideMerge(deps: SlideMergeDeps) {
  const reviews = new WeakMap<object, Review>()
  const latest = new WeakMap<object, string>()
  const reservedByVault = new Map<string, Set<string>>()

  return {
    async plan(owner: string, path: string): Promise<SlideMergeReviewReply> {
      const session = deps.guard.session(owner, path)
      const base = deps.guard.acknowledged(owner, path)
      const vault = deps.vaultFor(owner, path)
      if (!session || !base || !vault) return ownership()
      const generation = randomUUID()
      latest.set(session, generation)
      const current = () => latest.get(session) === generation && deps.guard.session(owner, path) === session &&
        deps.guard.acknowledged(owner, path) === base && deps.vaultFor(owner, path) === vault &&
        deps.guard.pending(path)?.kind !== 'partial'
      try {
        const key = outlineIdentity(path).key
        const disk = await deps.guard.diskVersion(path, true)
        if (!current()) return stalePlan()
        if (!disk || disk.mtime == null || outlineIdentity(path).key !== key) return staleDisk()
        const mine = await deps.readWindow(owner, path)
        if (!current()) return stalePlan()
        if (disk.text === base.text || normalizeOutlineMergeText(mine) === normalizeOutlineMergeText(base.text)) {
          return refuse('no-conflict', 'A slide merge requires both unsaved window edits and a changed file.')
        }
        const sources = { base: base.text, mine, disk: disk.text }
        const plan = planSlideMerge(sources.base, sources.mine, sources.disk)
        let recovery: { path: string; savedAt: number }
        try {
          const file = await deps.recovery.preserveMerge(outlineIdentity(path).realPath, sources)
          recovery = { path: file, savedAt: statSync(file).mtimeMs }
        } catch (error) {
          return refuse('recovery-failed', `Could not save the three versions in recovery. ${detail(error)}`)
        }
        if (!current()) return stalePlan()
        const { rows, details, order, orders, duplicateIds, versions } = plan
        const sections = { base: sectionTitles(sources.base), mine: sectionTitles(mine), disk: sectionTitles(disk.text) }
        const view: Extract<SlideMergeReviewReply, { ok: true }> = {
          ok: true, generation, fileName: basename(path), lastSavedAt: base.savedAt, diskChangedAt: disk.mtime,
          sources, details, order, orders, duplicateIds, recovery,
          rows: rows.map(row => ({
            ...row, mineDiscardsDiskEdits: comparable(row.disk?.text) !== comparable(row.base?.text),
            sections: {
              base: sections.base.get(row.base?.line ?? 0) ?? null,
              mine: sections.mine.get(row.mine?.line ?? 0) ?? null,
              disk: sections.disk.get(row.disk?.line ?? 0) ?? null,
            },
          })),
          unchanged: [...versions.mine.slides.keys()].filter(key => versions.disk.slides.has(key)).length -
            rows.filter(row => row.mine && row.disk).length,
        }
        reviews.set(session, { view, plan, disk: { key, hash: disk.hash, mtime: disk.mtime }, current })
        return view
      } catch (error) {
        return refuse('stale-plan', detail(error))
      }
    },

    async apply(owner: string, path: string, generation: string, choices: SlideMergeChoices): Promise<SlideMergeApplyReply> {
      const session = deps.guard.session(owner, path)
      const vault = deps.vaultFor(owner, path)
      if (!session || !vault) return ownership()
      const review = reviews.get(session)
      if (!review || review.view.generation !== generation || !review.current() || review.writing) return stalePlan()
      const writing: PendingWrite = {}
      review.writing = writing
      let reserved: Set<string> | undefined
      let freshIds: string[] = []
      try {
        // Resolve invalid choices before invoking the editor or risking a write. The second pass
        // allocates copy IDs against the destination vault and merges already in flight.
        let merged = applySlideMerge(review.plan, choices)
        if (!merged.ok) return merged
        if (Object.values(choices).includes('both')) {
          const taken = await deps.reservedIds(vault)
          if (!review.current()) return stalePlan()
          reserved = reservedByVault.get(vault) ?? new Set<string>()
          const used = new Set([...taken, ...reserved])
          merged = applySlideMerge(review.plan, choices, used)
          if (!merged.ok) return merged
          const sources = new Set(Object.values(review.view.sources).flatMap(idsIn))
          freshIds = idsIn(merged.text).filter(id => !sources.has(id))
          for (const id of freshIds) reserved.add(id)
          reservedByVault.set(vault, reserved)
        }
        const existing = statSync(path, { throwIfNoEntry: false })
        if (!existing || outlineIdentity(path).key !== review.disk.key || existing.mtimeMs !== review.disk.mtime ||
            hashOutlineText(readFileSync(path, 'utf8')) !== review.disk.hash) return staleDisk()
        if (!statSync(review.view.recovery.path, { throwIfNoEntry: false })) {
          return refuse('recovery-failed', 'The recovery copy is missing. Open a new merge review to save a fresh copy.')
        }
        writing.text = merged.text
        const reply = await deps.stageInWindow(owner, {
          kind: 'slide-merge', outlinePath: path, base: review.view.sources.mine, next: merged.text, generation,
        })
        const result = await writing.result
        if (result?.ok) {
          return { ok: true, savedAt: Date.now(), summary: summarizeSlideMerge(review.view, choices) }
        }
        if (result?.staleDisk) return staleDisk()
        if (reply && !reply.ok && reply.moved) return refuse('window-changed', reply.error)
        if (!review.current()) return stalePlan()
        return refuse('save-failed', result?.error ?? (reply && !reply.ok ? reply.error : 'The editor did not confirm the merge save.'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return staleDisk()
        return refuse('save-failed', detail(error))
      } finally {
        // An attempt sent to the editor is single-use, including a late or missing reply.
        if (writing.text !== undefined) {
          if (reviews.get(session) === review) reviews.delete(session)
        } else {
          review.writing = undefined
        }
        if (reserved) {
          for (const id of freshIds) reserved.delete(id)
          if (!reserved.size) reservedByVault.delete(vault)
        }
      }
    },

    takeWrite(owner: string, path: string, generation: string, staged: string) {
      const session = deps.guard.session(owner, path)
      const review = session && reviews.get(session)
      const write = review && review.writing
      if (!session || !review || !write || write.text === undefined || write.result ||
          review.view.generation !== generation || !review.current() || staged !== normalizeOutlineMergeText(write.text)) return null
      let finish!: (result: TalkWriteResult) => void
      write.result = new Promise(resolve => { finish = resolve })
      return {
        text: write.text, disk: review.disk,
        authorize() {
          if (!review.current() || review.writing !== write || reviews.get(session) !== review) {
            throw new Error('This merge review expired. Nothing was saved.')
          }
        },
        finish,
      }
    },
  }
}
