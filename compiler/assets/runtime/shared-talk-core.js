// Shared talk (share for comments), ticket 04: the colleague page's logic without the DOM.
// A device store (name, drafts, her items, what she has seen), a line diff for the proposal
// preview, and the client that posts items with idempotency keys through an outbox and follows
// the audience socket. Every function here is injected into the handout by toString() (see
// shared-talk-page.js sharedTalkRuntimeSource), so each one may only reference the others in
// this file and browser globals — never an import.

/** Line diff (LCS) of two texts: [{op:'same'|'del'|'add', text}]. */
export function sharedTalkLineDiff(before, after) {
  const a = String(before ?? '').replace(/\r\n?/g, '\n').split('\n')
  const b = String(after ?? '').replace(/\r\n?/g, '\n').split('\n')
  while (a.length > 1 && a[a.length - 1] === '') a.pop()
  while (b.length > 1 && b[b.length - 1] === '') b.pop()
  // Past a few hundred lines the table gets big; a slide never gets there, so fall back plainly.
  if (a.length * b.length > 250000) {
    return a.map((text) => ({ op: 'del', text })).concat(b.map((text) => ({ op: 'add', text })))
  }
  const rows = a.length + 1
  const cols = b.length + 1
  const table = new Uint32Array(rows * cols)
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = a[i] === b[j]
        ? table[(i + 1) * cols + j + 1] + 1
        : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1])
    }
  }
  const out = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ op: 'same', text: a[i] }); i += 1; j += 1 }
    else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) { out.push({ op: 'del', text: a[i] }); i += 1 }
    else { out.push({ op: 'add', text: b[j] }); j += 1 }
  }
  while (i < a.length) { out.push({ op: 'del', text: a[i] }); i += 1 }
  while (j < b.length) { out.push({ op: 'add', text: b[j] }); j += 1 }
  // Group each run of changes as all deletions then all additions, the way the mockup reads.
  const grouped = []
  let dels = []
  let adds = []
  const flush = () => { grouped.push(...dels, ...adds); dels = []; adds = [] }
  for (const line of out) {
    if (line.op === 'del') dels.push(line)
    else if (line.op === 'add') adds.push(line)
    else { flush(); grouped.push(line) }
  }
  flush()
  return grouped
}

/** Texts equal once line endings and trailing whitespace are ignored. */
export function sharedTalkSameText(a, b) {
  const norm = (value) => String(value ?? '').replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/\s+$/, '')).join('\n').trim()
  return norm(a) === norm(b)
}

/** FNV-1a over the string: a short fingerprint for "what she last saw of this slide". */
export function sharedTalkFingerprint(value) {
  const text = String(value ?? '')
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0') + ':' + text.length.toString(36)
}

/** An idempotency key the worker accepts (letters, digits, hyphen, underscore; <= 100). */
export function sharedTalkNewItemId(now = Date.now()) {
  const bytes = new Uint8Array(9)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  const random = Array.from(bytes, (byte) => byte.toString(36).padStart(2, '0')).join('')
  return 'c-' + Number(now).toString(36) + '-' + random
}

/** Which slides changed between two snapshots [{slideId, html}] and whether the order did. */
export function sharedTalkCompareSlides(previous, next) {
  const before = new Map((previous || []).map((slide) => [slide.slideId, slide.html]))
  const sameOrder = (previous || []).length === (next || []).length
    && (previous || []).every((slide, i) => slide.slideId === next[i].slideId)
  const changed = (next || []).filter((slide) => before.get(slide.slideId) !== slide.html).map((slide) => slide.slideId)
  return { structural: !sameOrder, changed }
}

/** "just now", "4 min ago", "at 14:05", "on 3 Sep" — for the Updated line. */
export function sharedTalkRelativeTime(at, now = Date.now()) {
  if (!Number.isFinite(at)) return ''
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return minutes + ' min ago'
  const date = new Date(at)
  const today = new Date(now)
  if (date.toDateString() === today.toDateString()) return 'at ' + sharedTalkClock(at)
  return 'on ' + date.getDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getMonth()]
}

export function sharedTalkClock(at) {
  const date = new Date(at)
  return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
}

/**
 * The device store: everything she has typed or sent on this share, in localStorage under one
 * key per share. Each write re-reads first, so two tabs on one share do not erase each other's
 * items. The name key is the live sessions' own, so a name she gave once is remembered for both.
 */
export function createSharedTalkStore(storage, shareId) {
  const key = 'talkweaver:shared-talk:' + shareId
  const nameKey = 'talkweaver:live-name'
  let memory = null
  const empty = () => ({ v: 1, items: [], drafts: {}, seen: {}, baseline: false })
  function read() {
    try {
      const raw = storage ? storage.getItem(key) : null
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && parsed.v === 1 && Array.isArray(parsed.items)) {
          memory = { ...empty(), ...parsed }
          return memory
        }
      }
    } catch {}
    if (!memory) memory = empty()
    return memory
  }
  function write(state) {
    memory = state
    try { storage?.setItem(key, JSON.stringify(state)) } catch {}
  }
  function mutate(fn) {
    const state = read()
    const result = fn(state)
    write(state)
    return result
  }
  return {
    items: () => read().items.slice(),
    item: (itemId) => read().items.find((item) => item.itemId === itemId) || null,
    name() { try { return storage?.getItem(nameKey) || '' } catch { return '' } },
    setName(value) { try { storage?.setItem(nameKey, String(value || '')) } catch {} },
    /** Records a new item as queued; the body is frozen here so every retry sends the same bytes. */
    addItem(body, now = Date.now()) {
      return mutate((state) => {
        const item = { ...body, createdAt: now, state: 'queued', status: 'new' }
        state.items.push(item)
        return item
      })
    },
    markSent(itemId, at) {
      return mutate((state) => {
        const item = state.items.find((entry) => entry.itemId === itemId)
        if (!item) return null
        item.state = 'sent'
        item.sentAt = at
        delete item.error
        return item
      })
    },
    markFailed(itemId, error) {
      return mutate((state) => {
        const item = state.items.find((entry) => entry.itemId === itemId)
        if (!item) return null
        item.state = 'failed'
        item.error = String(error || 'refused')
        return item
      })
    },
    /** Applies a status from the socket; false when the item is not hers or the status is stale. */
    setStatus(itemId, status, at, seq) {
      return mutate((state) => {
        const item = state.items.find((entry) => entry.itemId === itemId)
        if (!item) return false
        if (Number.isFinite(seq) && Number.isFinite(item.statusSeq) && seq <= item.statusSeq) return false
        item.status = status
        item.statusAt = at
        if (Number.isFinite(seq)) item.statusSeq = seq
        // A status proves the worker holds it, whatever the post's own answer was.
        if (item.state !== 'sent') { item.state = 'sent'; item.sentAt = item.sentAt || at }
        return true
      })
    },
    draft: (draftKey) => read().drafts[draftKey] ?? null,
    setDraft(draftKey, value) {
      mutate((state) => {
        if (value == null) delete state.drafts[draftKey]
        else state.drafts[draftKey] = value
      })
    },
    drafts: () => ({ ...read().drafts }),
    seen: (slideId) => read().seen[slideId] ?? null,
    hasBaseline: () => Boolean(read().baseline),
    /** First visit: everything on the page counts as seen, so nothing opens marked "updated". */
    setBaseline(entries) {
      mutate((state) => {
        for (const [slideId, fingerprint] of entries) if (!(slideId in state.seen)) state.seen[slideId] = fingerprint
        state.baseline = true
      })
    },
    markSeen(slideId, fingerprint) {
      if (read().seen[slideId] === fingerprint) return
      mutate((state) => { state.seen[slideId] = fingerprint })
    },
  }
}

/** Worker errors that no retry can fix: the item stays on the device, marked not sent. */
export function sharedTalkPermanentError(status, code) {
  if (status === 409) return true
  if (status === 400 || status === 413 || status === 404) return true
  if (status === 429 && code === 'share_full') return true
  return false
}

export function sharedTalkRetryDelay(attempt) {
  return Math.min(30000, 1000 * Math.pow(2, Math.max(0, attempt)))
}

/**
 * The page's link to the worker. `transport` is the seam the tests fake:
 *   postItem(body) -> Promise<{status, json, retryAfter}> (rejects when the network fails)
 *   openSocket(since, {onOpen, onMessage, onClose}) -> {close()}
 * Items go through the store's queue in order, one request at a time, so a retry can never race
 * the first attempt; the worker's idempotency on itemId makes a resend after a lost answer safe.
 * The first socket of a page load asks for since=0, so statuses on her earlier items arrive;
 * reconnects ask from the last seq seen.
 */
export function createSharedTalkClient(options) {
  const store = options.store
  const transport = options.transport
  const now = options.now || (() => Date.now())
  const schedule = options.schedule || ((fn, ms) => setTimeout(fn, ms))
  const cancel = options.cancel || ((id) => clearTimeout(id))
  const onChange = options.onChange || (() => {})
  const onTalkUpdated = options.onTalkUpdated || (() => {})
  let revision = Number(options.revision) || 0
  let lastSeq = 0
  let firstConnect = true
  let socket = null
  let socketOpen = false
  let socketAttempt = 0
  let socketTimer = null
  let postFailing = false
  let postAttempt = 0
  let retryTimer = null
  let flushing = false
  let flushAgain = false
  let closed = false
  let stopped = false

  function status() {
    const items = store.items()
    return {
      connected: socketOpen && !postFailing,
      socketOpen,
      offline: !socketOpen || postFailing,
      closed,
      queued: items.filter((item) => item.state === 'queued').length,
      revision,
      lastSeq,
    }
  }
  function changed(reason) { onChange(reason, status()) }

  function scheduleRetry(ms) {
    if (retryTimer != null || stopped || closed) return
    retryTimer = schedule(() => { retryTimer = null; void flush() }, ms)
  }

  async function flush() {
    if (closed || stopped) return
    if (flushing) { flushAgain = true; return }
    flushing = true
    let halted = false
    try {
      for (;;) {
        flushAgain = false
        const next = store.items().find((item) => item.state === 'queued')
        if (!next) break
        const body = {}
        for (const field of ['itemId', 'name', 'kind', 'slideId', 'afterSlideId', 'baseRevision', 'text', 'reason', 'section']) {
          if (next[field] !== undefined) body[field] = next[field]
        }
        let response
        try {
          response = await transport.postItem(body)
        } catch {
          postFailing = true
          halted = true
          changed('offline')
          scheduleRetry(sharedTalkRetryDelay(postAttempt++))
          return
        }
        const code = response && response.json && response.json.error ? response.json.error.code : ''
        if (response.status === 200 || response.status === 201) {
          postAttempt = 0
          if (postFailing) { postFailing = false }
          store.markSent(next.itemId, now())
          changed('sent')
          continue
        }
        if (response.status === 410) { closed = true; halted = true; changed('closed'); return }
        if (sharedTalkPermanentError(response.status, code)) {
          store.markFailed(next.itemId, code || ('http_' + response.status))
          changed('failed')
          continue
        }
        if (response.status === 429) {
          // Rate limited: the worker is reachable, so this is a pause, not "offline".
          const seconds = Number(response.retryAfter)
          halted = true
          scheduleRetry(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : sharedTalkRetryDelay(postAttempt++))
          changed('rate_limited')
          return
        }
        postFailing = true
        halted = true
        changed('offline')
        scheduleRetry(sharedTalkRetryDelay(postAttempt++))
        return
      }
    } finally {
      flushing = false
      // A halted queue waits for its scheduled retry (or the socket reopening), never re-spins.
      if (flushAgain && !halted) void flush()
      flushAgain = false
    }
  }

  function handleMessage(message) {
    if (!message || typeof message !== 'object') return
    if (Number.isInteger(message.seq) && message.seq > lastSeq) lastSeq = message.seq
    if (message.type === 'talk.updated' && Number.isInteger(message.revision)) {
      if (message.revision > revision) {
        revision = message.revision
        onTalkUpdated(message.revision)
      }
      return
    }
    if (message.type === 'item.status' && typeof message.itemId === 'string') {
      if (store.setStatus(message.itemId, message.status, message.at, message.seq)) changed('status')
      return
    }
    if (message.type === 'share.closed') {
      closed = true
      disconnect()
      changed('closed')
    }
  }

  function connect() {
    if (closed || stopped || socket) return
    const since = firstConnect ? 0 : lastSeq
    let opened = false
    const current = transport.openSocket(since, {
      onOpen() {
        if (socket !== current) return
        opened = true
        firstConnect = false
        socketOpen = true
        socketAttempt = 0
        postFailing = false
        postAttempt = 0
        changed('online')
        void flush()
      },
      onMessage(raw) {
        if (socket !== current) return
        let message = raw
        if (typeof raw === 'string') { try { message = JSON.parse(raw) } catch { return } }
        handleMessage(message)
      },
      onClose() {
        if (socket !== current) return
        socket = null
        const wasOpen = socketOpen
        socketOpen = false
        if (wasOpen || !opened) changed('offline')
        if (closed || stopped) return
        socketTimer = schedule(() => { socketTimer = null; connect() }, sharedTalkRetryDelay(socketAttempt++))
      },
    })
    socket = current
  }

  function disconnect() {
    if (socketTimer != null) { cancel(socketTimer); socketTimer = null }
    const current = socket
    socket = null
    socketOpen = false
    try { current?.close() } catch {}
  }

  return {
    status,
    start() { connect(); void flush() },
    stop() {
      stopped = true
      disconnect()
      if (retryTimer != null) { cancel(retryTimer); retryTimer = null }
    },
    /** Queue one item (a body without itemId/name) and try to send it now. */
    send(body) {
      const name = store.name().trim()
      const item = store.addItem({ itemId: sharedTalkNewItemId(now()), ...(name ? { name: name.slice(0, 80) } : {}), ...body }, now())
      changed('queued')
      void flush()
      return item
    },
    /** Browser came back online, or the page wants a try now. */
    retry() {
      if (retryTimer != null) { cancel(retryTimer); retryTimer = null }
      postAttempt = 0
      if (!socket && socketTimer != null) { cancel(socketTimer); socketTimer = null; connect() }
      void flush()
    },
    wentOffline() { postFailing = true; changed('offline') },
    /** The page reloaded talk.json itself; keep the revision in step. */
    setRevision(value) { if (Number.isInteger(value) && value > revision) revision = value },
    flush,
    handleMessage,
  }
}

export function sharedTalkEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

export function sharedTalkInline(text) {
  return sharedTalkEscape(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
}

/**
 * Her proposed new slide as the page previews it: the first heading is the title, list lines are
 * bullets, other lines paragraphs, in the deck's own list-slide markup so the deck styles apply.
 * An approximation of what the compiler will make; the app decides the real markup on Accept.
 */
export function sharedTalkMarkdownSlide(text, section) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  let title = ''
  const body = []
  let list = []
  const flushList = () => {
    if (list.length) body.push('<ul class="feature-list fl-plain">' + list.map((item) => '<li><span class="fl-text">' + sharedTalkInline(item) + '</span></li>').join('') + '</ul>')
    list = []
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) { flushList(); continue }
    const heading = line.match(/^#{1,6}\s+(.*)$/)
    if (heading && !title) { title = heading[1].replace(/\s*\{[^}]*\}\s*$/, ''); continue }
    const bullet = raw.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/)
    if (bullet) { list.push(bullet[1]); continue }
    flushList()
    body.push('<p class="content-p">' + sharedTalkInline(heading ? heading[1] : line) + '</p>')
  }
  flushList()
  const kicker = section ? '<p class="kicker">' + sharedTalkEscape(section) + '</p>' : ''
  const head = (kicker || title) ? '<header class="slide-head">' + kicker + (title ? '<h1>' + sharedTalkInline(title) + '</h1>' : '') + '</header>' : ''
  return { title, html: '<div class="slide-content layout-list">' + head + body.join('') + '</div>' }
}
