/// <reference lib="dom" />
import { ipcRenderer } from 'electron'
import type { CaptureChoice } from '../shared/recording-devices'

export function createPresenterVideo(clock: () => number, changed: () => void, testMode = false) {
  let abandonedId = ''
  let id = '', cameraLost = false, diskError = false
  let canvas: HTMLCanvasElement | null = null
  let camera: MediaStream | null = null
  let recorders: MediaRecorder[] = []
  let stopped: Promise<void>[] = []
  let chains: Promise<void>[] = []
  let pending: Array<Array<{ sequence: number; bytes: Uint8Array }>> = []
  let cameraLossTimer: ReturnType<typeof setTimeout> | null = null
  let frameTimer: ReturnType<typeof setInterval> | null = null
  let canvasTrack: CanvasCaptureMediaStreamTrack | null = null
  let finishing = false, paused = false
  let completed: unknown = null
  let startError: { at: number; layer: 'slides' | 'camera' } | null = null
  let suppressStopEvent = false
  const testLoss = (_event?: unknown, fault?: string) => { if (fault === 'stop-event') { suppressStopEvent = true; return } const track = camera?.getVideoTracks()[0]; track?.stop(); track?.dispatchEvent(new Event('ended')) }
  const sourceLost = (_event?: unknown, sourceId = id) => { if (sourceId !== id) return; diskError = true; changed(); void ipcRenderer.invoke('recording:layers-checkpoint', id, clock(), 'slides').catch(() => {}) }
  const frame = async (_e: unknown, bytes: Uint8Array, frameSource: number, sourceId: string, size: { width: number; height: number }) => {
    const target = canvas
    try {
      if (target && sourceId === id) {
        // NativeImage bitmap is BGRA on our little-endian desktop targets. Convert in this
        // capture renderer, keeping image encoding and pixel conversion off the voice writer.
        const rgba = new Uint8ClampedArray(bytes)
        for (let i = 0; i < rgba.length; i += 4) { const b = rgba[i]; rgba[i] = rgba[i + 2]; rgba[i + 2] = b }
        const bitmap = await createImageBitmap(new ImageData(rgba, size.width, size.height))
        try {
          if (canvas === target && sourceId === id) {
            target.getContext('2d')?.drawImage(bitmap, 0, 0, 1920, 1080)
            canvasTrack?.requestFrame()
          }
        } finally { bitmap.close() }
      }
    } catch { if (canvas === target && !finishing) sourceLost() }
    finally { ipcRenderer.send(`recording:frame-ready-${frameSource}-${sourceId}`) }
  }
  async function flush(index: number, layer: 'slides' | 'camera') {
    const sourceId = id, queue = pending[index]
    while (queue.length && sourceId === id) {
      const chunk = queue[0]
      await ipcRenderer.invoke('recording:layers-append', sourceId, layer, chunk.sequence, chunk.bytes)
      queue.shift()
    }
  }
  function reportCameraLoss() {
    if (finishing || cameraLost) return
    cameraLost = true; changed()
    camera?.getTracks().forEach(track => track.stop())
    void ipcRenderer.invoke('recording:device-preview', false, false).catch(() => {})
    void ipcRenderer.invoke('recording:layers-checkpoint', id, clock(), 'camera').catch(() => { diskError = true; changed() })
  }
  return {
    previewStream: () => camera,
    status: () => ({ cameraLost, diskError }),
    unavailable() {
      const abandoned = id || abandonedId
      abandonedId = abandoned
      id = ''; finishing = true; diskError = true
      if (frameTimer) clearInterval(frameTimer); frameTimer = null; canvasTrack = null
      if (cameraLossTimer) clearTimeout(cameraLossTimer); cameraLossTimer = null
      for (const stream of [...recorders.map(rec => rec.stream), ...(camera ? [camera] : [])]) for (const track of stream.getTracks()) { try { track.stop() } catch {} }
      camera = null; canvas = null
      ipcRenderer.removeListener('recording:layer-frame', frame); ipcRenderer.removeListener('recording:layer-source-lost', sourceLost); ipcRenderer.removeListener('recording:layer-test-loss', testLoss)
      void ipcRenderer.invoke('recording:layers-stop-source', abandoned).catch(() => {})
      void ipcRenderer.invoke('recording:device-preview', false, false).catch(() => {})
      changed()
    },
    async start(runId: string, choice: CaptureChoice, cameraName: string, cameraDeviceId = '', restoring = false) {
      suppressStopEvent = false; abandonedId = ''
      startError = null; completed = null; id = runId; paused = false; cameraLost = false; diskError = false; finishing = false; pending = []; chains = []; recorders = []; stopped = []
      const cancelled = () => finishing || id !== runId
      let startingLayer: 'slides' | 'camera' = choice === 'camera' ? 'camera' : 'slides'
      try {
      if (choice === 'camera') await ipcRenderer.invoke('recording:device-preview', true, false)
      if (cancelled()) return
      if (choice === 'camera') {
        try {
        const cameras = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput' && d.label === cameraName)
        if (cancelled()) return
        const device = cameras.find(d => d.deviceId === cameraDeviceId) ?? (cameras.length === 1 ? cameras[0] : null)
        if (!device) throw Error('The checked camera is missing or ambiguous; check the devices again')
        const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: { exact: device.deviceId } } })
        if (cancelled()) { stream.getTracks().forEach(track => track.stop()); return }
        camera = stream
        const track = camera.getVideoTracks()[0]
        track?.addEventListener('ended', () => { if (camera?.getVideoTracks()[0] === track) reportCameraLoss() })
        track?.addEventListener('mute', () => { if (camera?.getVideoTracks()[0] === track) cameraLossTimer = setTimeout(() => { if (camera?.getVideoTracks()[0] === track) reportCameraLoss() }, 2000) })
        track?.addEventListener('unmute', () => { if (camera?.getVideoTracks()[0] === track && cameraLossTimer) clearTimeout(cameraLossTimer) })
      } catch (error) { if (cancelled()) return; if (!restoring) throw error; cameraLost = true; changed() }
      }
      startingLayer = 'slides'
      canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080
      canvas.getContext('2d')?.fillRect(0, 0, 1920, 1080)
      ipcRenderer.on('recording:layer-frame', frame)
      ipcRenderer.on('recording:layer-source-lost', sourceLost)
      if (testMode) ipcRenderer.on('recording:layer-test-loss', testLoss)
      await ipcRenderer.invoke('recording:layers-open', id, choice === 'camera' && !cameraLost, restoring, clock())
      if (cancelled()) return
      // PR 316's explicit frame requests keep hidden windows recording, including a still slide.
      const slides = canvas.captureStream(0)
      canvasTrack = slides.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack
      frameTimer = setInterval(() => {
        // A static audience may paint before captureStream exists. Dirty the capture canvas
        // without changing its pixels so hidden Chromium emits the first and subsequent frames.
        if (canvas) canvas.getContext('2d')?.drawImage(canvas, 0, 0)
        canvasTrack?.requestFrame()
      }, 1000 / 30)
      if (cameraLost) await ipcRenderer.invoke('recording:layers-checkpoint', id, clock(), 'camera')
      const streams = [slides, ...(camera ? [camera] : [])]
      for (const [index, stream] of streams.entries()) {
        const layer = index ? 'camera' : 'slides'
        startingLayer = layer
        const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' })
        pending[index] = []; chains[index] = Promise.resolve()
        let sequence = 0, failed = false
        const stopFailedLayer = () => {
          if (failed) return
          failed = true
          try { if (rec.state !== 'inactive') rec.stop() } catch { /* End its tracks even if the encoder refuses Stop. */ }
          stream.getTracks().forEach(track => track.stop())
          if (layer === 'slides') {
            if (frameTimer) clearInterval(frameTimer); frameTimer = null; canvasTrack = null
            void ipcRenderer.invoke('recording:layers-stop-source', runId).catch(() => {})
          } else {
            cameraLost = true; if (camera === stream) camera = null
            void ipcRenderer.invoke('recording:device-preview', false, false).catch(() => {})
          }
        }
        rec.ondataavailable = event => {
          if (!event.data.size || id !== runId) return
          const seq = sequence++
          chains[index] = chains[index].then(async () => {
            const bytes = new Uint8Array(await event.data.arrayBuffer())
            if (id !== runId) return
            pending[index].push({ sequence: seq, bytes })
            try { await flush(index, layer); if (id === runId) await ipcRenderer.invoke('recording:layers-checkpoint', runId, clock()) } catch {
              if (id !== runId) return
              diskError = true; stopFailedLayer(); changed(); await ipcRenderer.invoke('recording:layers-checkpoint', runId, clock(), layer).catch(() => {})
            }
          })
        }
        rec.onerror = () => { if (!recorders.includes(rec)) return; if (index) reportCameraLoss(); else { diskError = true; changed(); void ipcRenderer.invoke('recording:layers-checkpoint', id, clock(), 'slides').catch(() => {}) } }
        const ended = new Promise<void>(resolve => rec.addEventListener('stop', () => { if (!suppressStopEvent) resolve() }, { once: true }))
        rec.start(1000); if (paused) rec.pause(); recorders.push(rec); stopped.push(ended)
        await ipcRenderer.invoke('recording:layers-started', id, layer, clock())
        if (cancelled()) return
      }
      } catch (error) {
        if (cancelled()) return
        startError = { at: clock(), layer: startingLayer }; diskError = true; changed()
        void ipcRenderer.invoke('recording:layers-checkpoint', runId, startError.at, startError.layer).catch(() => {})
        camera?.getTracks().forEach(t => t.stop()); throw error
      }
    },
    pause() { paused = true; for (const rec of recorders) if (rec.state === 'recording') rec.pause() },
    resume() { paused = false; for (const rec of recorders) if (rec.state === 'paused') rec.resume() },
    async stop() {
      const runId = id
      finishing = true
      let failure: unknown = null
      if (cameraLossTimer) clearTimeout(cameraLossTimer); cameraLossTimer = null
      try { canvasTrack?.requestFrame() } catch (error) { failure ??= error }
      const ending: Promise<void>[] = []
      try {
        for (const [index, rec] of recorders.entries()) {
          try { if (rec.state !== 'inactive') rec.stop(); ending.push(stopped[index]) }
          catch (error) {
            failure ??= error; diskError = true
            void ipcRenderer.invoke('recording:layers-checkpoint', id, clock(), index ? 'camera' : 'slides').catch(() => {})
          }
        }
        await Promise.all(ending)
      } finally {
        if (id !== runId) return
        if (frameTimer) clearInterval(frameTimer); frameTimer = null; canvasTrack = null
        for (const stream of [...recorders.map(rec => rec.stream), ...(camera ? [camera] : [])]) for (const track of stream.getTracks()) {
          try { track.stop() } catch (error) { failure ??= error }
        }
        camera = null
        ipcRenderer.removeListener('recording:layer-frame', frame); ipcRenderer.removeListener('recording:layer-source-lost', sourceLost); ipcRenderer.removeListener('recording:layer-test-loss', testLoss); canvas = null
      }
      try { await Promise.all(chains) } catch (error) { failure ??= error }
      if (id !== runId) return
      try { await ipcRenderer.invoke('recording:layers-stop-source', id) } catch (error) { failure ??= error }
      if (id !== runId) return
      try { await ipcRenderer.invoke('recording:device-preview', false, false) } catch (error) { failure ??= error }
      if (failure) throw failure
    },
    async handover(at: number) {
      const runId = id
      for (let index = 0; index < pending.length && id === runId; index++) await flush(index, index ? 'camera' : 'slides')
      if (id !== runId || !id) return
      await ipcRenderer.invoke('recording:layers-handover', id, at)
    },
    async discard() { await ipcRenderer.invoke('recording:layers-discard', id || abandonedId) },
    async finish() {
      const runId = id
      if (completed) return completed
      for (let index = 0; index < pending.length && id === runId; index++) {
        const layer = index ? 'camera' : 'slides'
        try { await flush(index, layer) } catch {
          if (id !== runId) return
          diskError = true
          await ipcRenderer.invoke('recording:layers-checkpoint', runId, clock(), layer).catch(() => {})
        }
      }
      if (id !== runId || !id) return
      if (startError) await ipcRenderer.invoke('recording:layers-checkpoint', runId, startError.at, startError.layer).catch(() => {})
      if (id !== runId) return
      await ipcRenderer.invoke('recording:layers-checkpoint', runId, clock())
      if (id !== runId) return
      const result = await ipcRenderer.invoke('recording:layers-finish', runId)
      if (id === runId) completed = result
      return result
    }
  }
}
