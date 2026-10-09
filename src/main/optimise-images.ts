// "Optimise images" converts a talk's PNG/JPG pictures to WebP, rewrites the references and moves the
// originals to the Trash. It reads, writes and trashes files a talk names, so it is under the vault
// rule (ADR-0036) and a narrower one of its own: a talk's Optimise acts only on pictures in that
// talk's OWN folder. This module decides what may be touched and writes the new file; the handler in
// index.ts converts and trashes with the paths this returns. No Electron here.

import { randomBytes } from 'crypto'
import { constants } from 'fs'
import { copyFile, link, lstat, open, realpath, unlink } from 'fs/promises'
import { basename, dirname, extname, join, sep } from 'path'

/** The compiler's containment for one talk (compiler/scripts/lib/asset-containment.mjs). */
export interface AssetContainment {
  reference(baseDir: string, written: string): Promise<{ ok: true; path: string; lexical: string } | { ok: false; reason: 'missing' | 'outside' }>
}

const IMAGE_LINK_RE = /!\[[^\]]*\]\(([^)]+)\)/g
const CONVERTIBLE_RE = /\.(png|jpe?g)$/i
/** A link target as written, without an optional "title". */
const targetOf = (inner: string): string => inner.trim().replace(/\s+"[^"]*"$/, '')

/**
 * The references "Optimise images" considers: image links ending .png/.jpg/.jpeg. Web and data:
 * addresses and pooled ids (`img-…`, already WebP in the vault's `_assets`) are left alone, as before.
 */
export function convertibleImageRefs(content: string): string[] {
  const refs = new Set<string>()
  for (const match of content.matchAll(IMAGE_LINK_RE)) {
    const raw = targetOf(match[1])
    if (/^(https?:|data:|img-)/.test(raw)) continue
    if (!CONVERTIBLE_RE.test(raw)) continue
    refs.add(raw)
  }
  return [...refs]
}

/**
 * Why a reference is left alone:
 *   missing    no such picture inside the talk's allowed folders
 *   outside    the reference lands outside them (`..`, an absolute path, a link out of the vault)
 *   linked     the reference is itself a link (or not a plain file): converting would act on its target
 *   elsewhere  the picture is in the vault but not in THIS talk's folder: another talk's picture, the
 *              shared `_assets` pool, a vault-level folder. Another talk may name it, and this talk's
 *              Optimise would trash it from under that talk
 *   clash      a file already has the .webp's name, or two pictures in this run would share one
 *              .webp (`a.png` and `a.jpg`): nothing is overwritten and neither is converted
 */
export type OptimiseRefusal = 'missing' | 'outside' | 'linked' | 'elsewhere' | 'clash'
export type OptimiseDecision =
  /** Convert `source` (the picture's real path) into a new file `output`, point the reference at `webpRef`, trash `source`. */
  | { ok: true; source: string; output: string; webpRef: string }
  | { ok: false; reason: OptimiseRefusal }

const below = (root: string, path: string): boolean => path.startsWith(root.endsWith(sep) ? root : root + sep)

/**
 * May this one reference be converted, and with which paths? `talkDir` is the folder holding the
 * talk's outline.
 *
 * - The picture is resolved exactly as the compiler resolves it: the reference as written, then
 *   percent-decoded, a regular file whose REAL path is inside the allowed roots.
 * - The reference itself must not be a link.
 * - The picture's real path must be under the talk's own real folder.
 * - The .webp goes beside the real picture, under the same name, and must not exist yet in any form
 *   (a file, a link, a hard link to something else): Optimise only ever creates a new file.
 */
export async function optimiseDecision(ref: string, talkDir: string, containment: AssetContainment): Promise<OptimiseDecision> {
  if (typeof ref !== 'string' || !CONVERTIBLE_RE.test(ref)) return { ok: false, reason: 'missing' }
  const found = await containment.reference(talkDir, ref)
  if (!found.ok) return { ok: false, reason: found.reason }
  try {
    if (!(await lstat(found.lexical)).isFile()) return { ok: false, reason: 'linked' }
  } catch { return { ok: false, reason: 'missing' } }
  const source = found.path
  let ownFolder: string
  try { ownFolder = await realpath(talkDir) } catch { return { ok: false, reason: 'missing' } }
  if (!below(ownFolder, source)) return { ok: false, reason: 'elsewhere' }
  if (!CONVERTIBLE_RE.test(source)) return { ok: false, reason: 'linked' }
  const output = join(dirname(source), basename(source, extname(source)) + '.webp')
  try { await lstat(output); return { ok: false, reason: 'clash' } } catch { /* nothing has that name: the only case that converts */ }
  return { ok: true, source, output, webpRef: ref.replace(CONVERTIBLE_RE, '.webp') }
}

export interface OptimisePlan {
  /** One entry per PICTURE (real path), with every reference that names it and what each becomes. */
  conversions: Array<{ source: string; output: string; refs: Array<[ref: string, webpRef: string]> }>
  /** Every reference that is left alone, and why. */
  skipped: Array<{ ref: string; reason: OptimiseRefusal }>
}

// One file can be written several ways (`pic.png`, `./pic.png`, `Pic.png` on a case-insensitive
// volume, `%70ic.png`). Each resolves to the same real path, so the plan is by real path: the
// picture is converted once and EVERY reference to it is rewritten, each in its own spelling.
// Two different pictures that would produce the same .webp (also when their names differ only by
// case) clash: neither is converted.
const sameNameKey = (path: string): string => path.normalize('NFC').toLowerCase()

/** Decide every reference first; nothing is converted until the whole plan is known. */
export async function planOptimisation(refs: Iterable<string>, talkDir: string, containment: AssetContainment): Promise<OptimisePlan> {
  const skipped: OptimisePlan['skipped'] = []
  const bySource = new Map<string, OptimisePlan['conversions'][number]>()
  for (const ref of new Set(refs)) {
    const decision = await optimiseDecision(ref, talkDir, containment)
    if (!decision.ok) { skipped.push({ ref, reason: decision.reason }); continue }
    const entry = bySource.get(decision.source) ?? { source: decision.source, output: decision.output, refs: [] }
    entry.refs.push([ref, decision.webpRef])
    bySource.set(decision.source, entry)
  }
  const perOutput = new Map<string, number>()
  for (const entry of bySource.values()) perOutput.set(sameNameKey(entry.output), (perOutput.get(sameNameKey(entry.output)) ?? 0) + 1)
  const conversions: OptimisePlan['conversions'] = []
  for (const entry of bySource.values()) {
    if ((perOutput.get(sameNameKey(entry.output)) ?? 0) > 1) for (const [ref] of entry.refs) skipped.push({ ref, reason: 'clash' })
    else conversions.push(entry)
  }
  return { conversions, skipped }
}

/**
 * Write `bytes` as a NEW file at `output`; never onto anything that is already there.
 *
 * 1. The bytes go into a temporary file in the same folder, with an unpredictable name, created
 *    exclusively (`wx`: the create fails if anything has that name, and does not follow a link) and
 *    written through that one open descriptor.
 * 2. The temporary file is given the output's name with a hard link, which fails if the name exists in
 *    any form (file, link, dangling link) and never replaces it. Where the volume has no hard links,
 *    an exclusive copy (`COPYFILE_EXCL`) does the same.
 * 3. The temporary name is removed, also on every failure.
 *
 * Throws (code EEXIST) when the output appeared after the decision. What remains: the FOLDER's path
 * is walked again for each step, so a folder swapped for a link between the decision and the write
 * would redirect the new file (it would still never overwrite one).
 */
export async function writeNewFile(output: string, bytes: Uint8Array): Promise<void> {
  const temp = join(dirname(output), `.${basename(output)}.${randomBytes(9).toString('hex')}.tmp`)
  let created = false
  try {
    const handle = await open(temp, 'wx', 0o644)
    created = true
    try { await handle.writeFile(bytes) } finally { await handle.close() }
    try {
      await link(temp, output)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === 'EEXIST') throw error
      await copyFile(temp, output, constants.COPYFILE_EXCL)
    }
  } finally {
    if (created) { try { await unlink(temp) } catch { /* already gone */ } }
  }
}

/**
 * Point the converted references at their .webp files. Only an image link whose WHOLE target is a
 * converted reference changes: the same characters inside another reference (a refused
 * `../elsewhere/pic.png` beside a converted `pic.png`), in prose or in a link are left as they are.
 */
export function rewriteConvertedRefs(text: string, converted: ReadonlyMap<string, string>): string {
  if (!converted.size) return text
  return text.replace(IMAGE_LINK_RE, (whole: string, inner: string) => {
    const raw = targetOf(inner)
    const next = converted.get(raw)
    if (next === undefined) return whole
    const at = whole.lastIndexOf(inner)
    return whole.slice(0, at) + inner.replace(raw, next) + whole.slice(at + inner.length)
  })
}
