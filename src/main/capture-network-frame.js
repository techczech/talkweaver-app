// CDP installs this in the capture document and recursively attached targets before their scripts.
// Same-target opaque srcdoc realms may retain native APIs: the filtering proxy is the boundary.
// Workers are unavailable in this disposable capture: otherwise they could obtain fresh network APIs.
export function lockCaptureNetwork() {
  try {
    if (globalThis.__twCaptureNetworkLocked === true) return true
    const deny = () => { throw new DOMException('Unavailable during offline capture', 'NotAllowedError') }
    let container
    try { container = globalThis.navigator?.serviceWorker } catch { /* opaque origins cannot obtain a service-worker container */ }
    if (container) {
      for (const object of [container, Object.getPrototypeOf(container)]) {
        Object.defineProperty(object, 'register', { value: deny, configurable: false, writable: false })
      }
    }
    const names = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCIceTransport', 'RTCDtlsTransport', 'RTCSctpTransport', 'RTCQuicTransport',
      'WebTransport', 'WebSocketStream', 'TCPSocket', 'TCPServerSocket', 'UDPSocket', 'Worker', 'SharedWorker', 'ShadowRealm', 'documentPictureInPicture']
    for (const name of names) Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false })
    Object.defineProperty(globalThis, '__twCaptureNetworkLocked', { value: true, configurable: false, writable: false })
    return true
  } catch {
    // Fail closed before the HTML parser's scripts: an unsupported realm must never run the source.
    globalThis.stop?.()
    return false
  }
}
