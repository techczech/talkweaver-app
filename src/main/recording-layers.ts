import { randomUUID, createHash } from 'node:crypto'
// ADR-0043: append-only video layers. All media and recovery state live in this Run's folder.
import { closeSync, existsSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, readdirSync, unlinkSync, writeSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isSafeRunId } from './runs.ts'
type VideoSegment = { file: string; bytes: number; startMs?: number; endMs?: number; lostAtMs?: number }
export type Layer = 'slides' | 'camera'
export interface LayerManifest {
  version: 1
  runId: string
  state: 'recording' | 'saved' | 'interrupted'
  durationMs: number
  refreshes?: Array<{ startMs: number; endMs?: number }>
  voiceGaps?: Array<{ startMs: number; endMs: number; reason: string }>
  layers: Partial<Record<Layer, { outcome?: 'complete' | 'interrupted' | 'none'; file: string; bytes: number; startMs?: number; endMs?: number; lostAtMs?: number; segments?: VideoSegment[] }>>
}
export function createLayerStore(root: string, io: { write?: (fd: number, bytes: Uint8Array, offset: number, length: number) => number } = {}) {
  const write = io.write ?? ((fd, bytes, offset, length) => writeSync(fd, bytes, offset, length))
  type OpenFile = { fd: number; sequence: number; offset: number; hash?: string; lastHash?: string }
  type Entry = { owner: number; dir: string; directory: { dev: number; ino: number }; parent: { dev: number; ino: number }; manifest: LayerManifest; pending?: Map<Layer, string>; lazyCamera?: string; files: Map<Layer, OpenFile> }
  const entries = new Map<string, Entry>()
  const retired = new Map<string, Entry>()
  function sweep(dir: string) {
    for (const name of readdirSync(dir)) if (/^\.capture-[a-f0-9-]+\.json$/.test(name)) unlinkSync(join(dir, name))
  }
  function checkDirectory(e: Entry) {
    const dir = lstatSync(e.dir), parent = lstatSync(root)
    if (dir.isSymbolicLink() || parent.isSymbolicLink() || dir.dev !== e.directory.dev || dir.ino !== e.directory.ino || parent.dev !== e.parent.dev || parent.ino !== e.parent.ino) throw Error('Recording folder was replaced')
  }
  function folder(path: string) {
    mkdirSync(path, { recursive: true })
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw Error('Unsafe recording folder')
  }
  function persist(e: Entry) {
    checkDirectory(e)
    const staging = join(e.dir, `.capture-${randomUUID()}.json`)
    const fd = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(fd, JSON.stringify(e.manifest)); fsyncSync(fd) } catch (error) { try { unlinkSync(staging) } catch {} ; throw error } finally { closeSync(fd) }
    try { renameSync(staging, join(e.dir, 'capture.json')) } finally { try { unlinkSync(staging) } catch { /* renamed */ } }
    const directory = openSync(e.dir, constants.O_RDONLY); try { fsyncSync(directory) } finally { closeSync(directory) }
  }
  function owned(owner: number, id: string) {
    const e = entries.get(id)
    if (!e || e.owner !== owner) throw Error('Recording belongs to another window')
    checkDirectory(e)
    return e
  }
  function current(e: Entry, layer: Layer): VideoSegment | undefined {
    const meta = e.manifest.layers[layer]
    return meta?.segments?.at(-1) ?? meta
  }
  function describe(manifest: LayerManifest): LayerManifest {
    for (const meta of Object.values(manifest.layers)) {
      const parts = meta.segments ?? [meta]
      if (manifest.state === 'interrupted') { const last = parts.at(-1); if (last) last.lostAtMs ??= Math.max(manifest.durationMs, last.startMs ?? 0) }
      meta.outcome = meta.bytes === 0 ? 'none' : manifest.state !== 'saved' || parts.some(part => part.lostAtMs !== undefined) ? 'interrupted' : 'complete'
    }
    return manifest
  }
  function closePendingRefresh(e: Entry) {
    const gap = e.manifest.refreshes?.at(-1)
    if (!gap || gap.endMs !== undefined) return
    gap.endMs = Math.max(gap.startMs, e.manifest.durationMs)
    for (const layer of Object.keys(e.manifest.layers) as Layer[]) {
      const part = current(e, layer)
      if (part) part.lostAtMs ??= part.endMs ?? gap.startMs
    }
  }
  function dropPendingSegments(e: Entry) {
    for (const layer of e.pending?.keys() ?? []) {
      const previous = current(e, layer)
      if (previous) previous.lostAtMs ??= previous.endMs ?? e.manifest.durationMs
    }
    e.pending?.clear()
  }
  function dropUnstartedCamera(e: Entry) {
    if (!e.lazyCamera) return
    const parts = e.manifest.layers.camera?.segments
    if (parts?.at(-1)?.file === e.lazyCamera) parts.pop()
    const previous = parts?.at(-1)
    if (previous) previous.lostAtMs ??= previous.endMs ?? e.manifest.durationMs
    delete e.lazyCamera
  }
  function interruptEntry(id: string, e: Entry) {
    dropUnstartedCamera(e)
    dropPendingSegments(e)
    for (const f of e.files.values()) { try { fsyncSync(f.fd) } catch { /* recovery reads the written prefix */ } try { closeSync(f.fd) } catch { /* already closed */ } }
    e.manifest.state = 'interrupted'
    try { persist(e) } catch { /* keep the previous atomic manifest and every media file */ }
    entries.delete(id); retired.set(id, e)
  }
  return {
    interrupt(owner: number, id: string) {
      const e = entries.get(id)
      if (!e) return
      if (e.owner !== owner) throw Error('Recording belongs to another window')
      interruptEntry(id, e)
    },
    open(owner: number, id: string, camera: boolean) {
      if (!isSafeRunId(id) || entries.has(id)) throw Error('Invalid or active Run')
      folder(root)
      const dir = join(root, id)
      // Exclusive folder reservation: never overwrite an older recording.
      mkdirSync(dir)
      const e: Entry = { owner, dir, directory: lstatSync(dir), parent: lstatSync(root), manifest: { version: 1, runId: id, state: 'recording', durationMs: 0, layers: {} } as LayerManifest, files: new Map<Layer, OpenFile>() }
      try {
        for (const layer of (camera ? ['slides', 'camera'] : ['slides']) as Layer[]) {
          const file = `${layer}.webm`
          const fd = openSync(join(dir, file), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
          e.files.set(layer, { fd, sequence: 0, offset: 0 }); e.manifest.layers[layer] = { file, bytes: 0 }
        }
        persist(e); entries.set(id, e)
      } catch (error) { interruptEntry(id, e); throw error }
    },
    append(owner: number, id: string, layer: Layer, sequence: number, bytes: Uint8Array) {
      if (layer !== 'slides' && layer !== 'camera') throw Error('Unknown layer')
      const e = owned(owner, id), meta = current(e, layer)
      let f = e.files.get(layer)
      if (!f && layer === 'camera' && e.lazyCamera && meta && bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= 32 * 1024 * 1024 && sequence === 0) {
        const fd = openSync(join(e.dir, e.lazyCamera), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        f = { fd, sequence: 0, offset: 0 }; e.files.set(layer, f); delete e.lazyCamera
      }
      if (!f || !meta || !(bytes instanceof Uint8Array) || bytes.length > 32 * 1024 * 1024) throw Error('Invalid capture chunk')
      const hash = createHash('sha256').update(bytes).digest('hex')
      if (sequence === f.sequence - 1 && hash === f.lastHash) { persist(e); return }
      if (sequence !== f.sequence) throw Error('Invalid capture sequence')
      const fileIdentity = lstatSync(join(e.dir, meta.file)), handleIdentity = fstatSync(f.fd)
      if (fileIdentity.isSymbolicLink() || fileIdentity.dev !== handleIdentity.dev || fileIdentity.ino !== handleIdentity.ino) throw Error('Recording file was replaced')
      if (f.hash && f.hash !== hash) throw Error('Retry changed a capture chunk')
      f.hash = hash
      // A retry continues the refused chunk, including a short write before ENOSPC.
      while (f.offset < bytes.length) {
        const wrote = write(f.fd, bytes, f.offset, bytes.length - f.offset)
        if (!wrote) throw Error('Recording disk stopped accepting data')
        f.offset += wrote; meta.bytes += wrote
      }
      if (e.manifest.layers[layer]?.segments) e.manifest.layers[layer]!.bytes = e.manifest.layers[layer]!.segments!.reduce((sum, part) => sum + part.bytes, 0)
      fsyncSync(f.fd); f.sequence++; f.offset = 0; f.hash = undefined; f.lastHash = hash
      persist(e)
    },
    started(owner: number, id: string, layer: Layer, startMs: number) {
      if (layer !== 'slides' && layer !== 'camera') throw Error('Unknown layer')
      const e = owned(owner, id), pending = e.pending?.get(layer)
      if (!Number.isFinite(startMs) || startMs < 0 || (pending && Math.round(startMs) < (e.manifest.refreshes?.at(-1)?.startMs ?? 0))) throw Error('Invalid layer origin')
      if (pending) {
        if (layer === 'camera') e.lazyCamera = pending
        else {
          const fd = openSync(join(e.dir, pending), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
          e.files.set(layer, { fd, sequence: 0, offset: 0 })
        }
        e.manifest.layers[layer]!.segments!.push({ file: pending, bytes: 0 })
        e.pending!.delete(layer)
      }
      const meta = current(e, layer)
      if (!meta) throw Error('Invalid layer origin')
      meta.startMs ??= Math.round(startMs)
      if (layer === 'slides') { const gap = e.manifest.refreshes?.at(-1); if (gap) gap.endMs = meta.startMs }
      persist(e)
    },
    checkpoint(owner: number, id: string, durationMs: number, lost?: Layer) {
      if (lost !== undefined && lost !== 'slides' && lost !== 'camera') throw Error('Unknown layer')
      const e = owned(owner, id)
      if (!Number.isFinite(durationMs) || durationMs < 0) throw Error('Invalid recording clock')
      e.manifest.durationMs = Math.max(e.manifest.durationMs, Math.round(durationMs))
      if (lost && current(e, lost)) { const part = current(e, lost)!; part.lostAtMs ??= Math.max(part.startMs ?? 0, Math.min(part.endMs ?? Infinity, Math.round(durationMs))) }
      persist(e)
    },
    finish(owner: number, id: string) {
      const e = owned(owner, id)
      dropUnstartedCamera(e)
      dropPendingSegments(e)
      closePendingRefresh(e)
      for (const [layer, f] of e.files) {
        const file = lstatSync(join(e.dir, current(e, layer)!.file)), handle = fstatSync(f.fd)
        if (file.isSymbolicLink() || file.ino !== handle.ino || file.dev !== handle.dev) throw Error('Recording file was replaced')
        fsyncSync(f.fd)
        const segment = e.manifest.layers[layer]?.segments?.at(-1)
        if (segment) segment.endMs ??= e.manifest.durationMs
      }
      e.manifest.state = 'saved'; persist(e)
      for (const f of e.files.values()) closeSync(f.fd)
      entries.delete(id); retired.set(id, e)
      return e.manifest
    },
    handover(owner: number, id: string, at: number) {
      const e = owned(owner, id)
      if (!Number.isFinite(at) || at < 0) throw Error('Invalid handover clock')
      at = Math.round(at)
      dropUnstartedCamera(e); dropPendingSegments(e)
      for (const [layer, f] of e.files) {
        fsyncSync(f.fd)
        const meta = e.manifest.layers[layer]!
        meta.segments ??= [{ file: meta.file, bytes: meta.bytes, startMs: meta.startMs, lostAtMs: meta.lostAtMs }]
        delete meta.lostAtMs
        meta.segments.at(-1)!.endMs = at
      }
      if (e.manifest.refreshes?.at(-1)?.endMs !== undefined || !e.manifest.refreshes?.length) (e.manifest.refreshes ??= []).push({ startMs: at })
      e.manifest.durationMs = Math.max(e.manifest.durationMs, at)
      persist(e)
    },
    resume(owner: number, id: string, at: number, camera = true) {
      const e = owned(owner, id)
      const gap = e.manifest.refreshes?.at(-1)
      if (!gap || gap.endMs !== undefined || !Number.isFinite(at) || Math.round(at) < gap.startMs) throw Error('No handover pending')
      at = Math.round(at)
      dropUnstartedCamera(e); dropPendingSegments(e)
      e.pending ??= new Map()
      for (const layer of Object.keys(e.manifest.layers) as Layer[]) {
        const f = e.files.get(layer)
        const meta = e.manifest.layers[layer]!
        if (f) closeSync(f.fd)
        e.files.delete(layer)
        if (layer === 'camera' && !camera) {
          current(e, layer)!.lostAtMs ??= gap.startMs
          continue
        }
        delete meta.lostAtMs
        e.pending.set(layer, `${layer}.seg-${meta.segments!.length}.webm`)
      }
      persist(e)
    },
    snapshot(owner: number, id: string): LayerManifest | null {
      const e = entries.get(id) ?? retired.get(id)
      if (!e) return null
      if (e.owner !== owner) throw Error('Recording belongs to another window')
      return describe(structuredClone(e.manifest))
    },
    complete(id: string) { retired.delete(id) },
    discard(owner: number, id: string) {
      const e = entries.get(id) ?? retired.get(id)
      if (!e) return null
      if (e.owner !== owner) throw Error('Recording belongs to another window')
      checkDirectory(e)
      if (entries.has(id)) for (const f of e.files.values()) {
        try { fsyncSync(f.fd) } catch { /* Discard still closes and trashes this owned take. */ }
        try { closeSync(f.fd) } catch { /* Already closed by a failed finalisation. */ }
      }
      entries.delete(id); retired.delete(id)
      return e.dir
    },
    closeOwner(owner: number) {
      for (const [id, e] of entries) if (e.owner === owner) interruptEntry(id, e)
    },
    read(id: string): LayerManifest | null {
      if (!isSafeRunId(id)) return null
      try {
        if (lstatSync(root).isSymbolicLink()) return null
        const dir = join(root, id), path = join(dir, 'capture.json')
        if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) return null
        if (!entries.has(id)) sweep(dir)
        if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) return null
        const manifest = JSON.parse(readFileSync(path, 'utf8')) as LayerManifest
        if (manifest.version !== 1 || manifest.runId !== id) return null
        for (const layer of ['slides', 'camera'] as Layer[]) {
          const meta = manifest.layers[layer]
          if (!meta) continue
          if (meta.file !== `${layer}.webm`) return null
          const parts = meta.segments ?? [meta]
          for (const [index, part] of parts.entries()) {
            if (part.file !== (index === 0 ? `${layer}.webm` : `${layer}.seg-${index}.webm`)) return null
            if (layer === 'camera' && part.bytes === 0 && index === parts.length - 1 && !existsSync(join(dir, part.file))) { parts.pop(); break }
            const fd = openSync(join(dir, part.file), constants.O_RDONLY | constants.O_NOFOLLOW)
            try { const st = fstatSync(fd); if (!st.isFile()) return null; part.bytes = st.size } finally { closeSync(fd) }
          }
          if (meta.segments) meta.bytes = parts.reduce((sum, part) => sum + part.bytes, 0)
        }
        return describe(manifest)
      } catch { return null }
    }
  }
}

/** A lost microphone must not hide an interrupted Run that still holds video. */
export function hasCapturedVideo(capture: LayerManifest | null): boolean { return (capture?.layers.slides?.bytes ?? 0) > 0 || (capture?.layers.camera?.bytes ?? 0) > 0 }
