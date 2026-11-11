// Capture-only containment. Never used by live presenter windows or their interactive page views.
import type { Session, WebContents } from 'electron'
import { lockCaptureNetwork } from './capture-network-frame.js'
import { captureResponseHeaders } from './capture-network-headers.ts'
import { createCaptureProxy, type CaptureProxyOptions } from './capture-proxy.ts'
export { captureResponseHeaders } from './capture-network-headers.ts'

/** Keep existing policies/framing headers, add restrictive capture policies, close speculative channels. */
export async function containCaptureSession(isolated: Session, opts: CaptureProxyOptions = {}): Promise<() => void> {
  const proxy = await createCaptureProxy(opts)
  try {
    await isolated.setProxy({ mode: 'fixed_servers', proxyRules: proxy.url, proxyBypassRules: '<-loopback>' })
    await isolated.closeAllConnections()
  } catch (error) { proxy.close(); throw error }
  isolated.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ responseHeaders: captureResponseHeaders(details.responseHeaders) })
  })
  return proxy.close
}

/** Native UDP policy plus capability closure in the document and every attached child target.
 * Opaque same-target srcdoc realms can retain native APIs; the proxy remains the primary boundary.
 * CDP needs a live target, so initialise with our inert document first. No preload or app bridge. */
export async function containCaptureContents(contents: WebContents): Promise<void> {
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  await contents.loadURL('data:text/html,<!doctype html><title>Capture</title>')
  contents.debugger.attach('1.3')
  const source = `(${lockCaptureNetwork.toString()})()`
  const attach = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }
  // OOPIFs and workers can be independent targets. Pause each before execution,
  // recursively attach its descendants, install the gate, and only then resume that target.
  const active = new Set<string>()
  const fail = (): void => { if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false }) }
  contents.debugger.on('message', (_event, method, params) => {
    if (method === 'Target.detachedFromTarget') { active.delete(params.sessionId); return }
    if (method !== 'Target.attachedToTarget') return
    const id = params.sessionId as string
    active.add(id)
    void (async () => {
      await contents.debugger.sendCommand('Runtime.enable', {}, id)
      const type = params.targetInfo?.type
      if (type === 'iframe' || type === 'page') {
        await contents.debugger.sendCommand('Page.enable', {}, id)
        await contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source, runImmediately: true }, id)
      }
      const result = await contents.debugger.sendCommand('Runtime.evaluate', { expression: source, returnByValue: true }, id)
      if (result.exceptionDetails || result.result?.value !== true) throw Error('Child capture gate unavailable')
      await contents.debugger.sendCommand('Target.setAutoAttach', attach, id)
      await contents.debugger.sendCommand('Runtime.runIfWaitingForDebugger', {}, id)
    })().catch(() => { if (active.has(id)) fail() })
  })
  await contents.debugger.sendCommand('Target.setAutoAttach', attach)
  await contents.debugger.sendCommand('Page.enable')
  await contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
    source, runImmediately: true
  })
  if (!await captureNetworkReady(contents)) throw Error('Capture containment unavailable')
}

export async function captureNetworkReady(contents: WebContents): Promise<boolean> {
  if (contents.isDestroyed() || contents.getWebRTCIPHandlingPolicy() !== 'disable_non_proxied_udp') return false
  return await contents.executeJavaScript('globalThis.__twCaptureNetworkLocked === true && typeof RTCPeerConnection === "undefined" && typeof webkitRTCPeerConnection === "undefined" && typeof WebTransport === "undefined" && typeof Worker === "undefined" && typeof SharedWorker === "undefined"', false) === true
}
