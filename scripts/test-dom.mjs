class TestClassList {
  constructor(element) {
    this.element = element
  }

  values() {
    return new Set(String(this.element.className || '').split(/\s+/).filter(Boolean))
  }

  add(...names) {
    const values = this.values()
    names.forEach((name) => values.add(name))
    this.element.className = [...values].join(' ')
  }

  remove(...names) {
    const values = this.values()
    names.forEach((name) => values.delete(name))
    this.element.className = [...values].join(' ')
  }

  contains(name) {
    return this.values().has(name)
  }

  toggle(name, force) {
    const present = this.contains(name)
    const next = force === undefined ? !present : Boolean(force)
    if (next) this.add(name)
    else this.remove(name)
    return next
  }
}

function selectorParts(selector) {
  const attributes = [...selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)]
    .map((match) => ({ name: match[1], value: match[2] }))
  const stripped = selector.replace(/\[[^\]]+\]/g, '')
  const classNames = [...stripped.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((match) => match[1])
  const tag = stripped.replace(/\.[A-Za-z0-9_-]+/g, '').trim().toUpperCase()
  return { attributes, classNames, tag }
}

function matchesSelector(element, selector) {
  const { attributes, classNames, tag } = selectorParts(selector)
  if (tag && element.tagName !== tag) return false
  if (classNames.some((name) => !element.classList.contains(name))) return false
  return attributes.every(({ name, value }) => {
    const actual = name.startsWith('data-')
      ? element.dataset[name.slice(5).replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())]
      : element.getAttribute(name)
    return value === undefined ? actual !== null && actual !== undefined : actual === value
  })
}

export class TestEvent {
  constructor(type, init = {}) {
    this.type = type
    this.bubbles = Boolean(init.bubbles)
    this.cancelable = init.cancelable !== false
    this.defaultPrevented = false
    this.propagationStopped = false
    Object.assign(this, init)
  }

  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true
  }

  stopPropagation() {
    this.propagationStopped = true
  }
}

export class TestKeyboardEvent extends TestEvent {
  constructor(type, init = {}) {
    super(type, init)
    this.key = init.key ?? ''
    this.code = init.code ?? ''
    this.metaKey = Boolean(init.metaKey)
    this.ctrlKey = Boolean(init.ctrlKey)
    this.altKey = Boolean(init.altKey)
    this.shiftKey = Boolean(init.shiftKey)
  }
}

class TestCustomEvent extends TestEvent {
  constructor(type, init = {}) {
    super(type, init)
    this.detail = init.detail
  }
}

class TestEventTarget {
  constructor() {
    this.listeners = new Map()
  }

  addEventListener(type, listener, options = {}) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push({ listener, once: Boolean(options?.once) })
    this.listeners.set(type, listeners)
    options?.signal?.addEventListener('abort', () => this.removeEventListener(type, listener), { once: true })
  }

  removeEventListener(type, listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((entry) => entry.listener !== listener)
    )
  }

  dispatchEvent(event) {
    if (!event.target) event.target = this
    event.currentTarget = this
    for (const entry of [...(this.listeners.get(event.type) ?? [])]) {
      entry.listener.call(this, event)
      if (entry.once) this.removeEventListener(event.type, entry.listener)
    }
    if (event.bubbles && !event.propagationStopped && this.parentElement) {
      this.parentElement.dispatchEvent(event)
    }
    return !event.defaultPrevented
  }
}

export class TestElement extends TestEventTarget {
  constructor(tagName, ownerDocument) {
    super()
    this.tagName = String(tagName).toUpperCase()
    this.ownerDocument = ownerDocument
    this.parentElement = null
    this.children = []
    this.attributes = new Map()
    this.dataset = {}
    this.style = {
      values: new Map(),
      setProperty: (name, value) => this.style.values.set(name, String(value)),
    }
    this.className = ''
    this.classList = new TestClassList(this)
    this.textContent = ''
    this.innerHTML = ''
    this.hidden = false
    this.disabled = false
    this.value = ''
    this.tabIndex = 0
    this.clientWidth = 0
    this.scrollHeight = 24
    this.offsetWidth = 100
  }

  append(...children) {
    for (const child of children) {
      if (child === null || child === undefined) continue
      if (child.parentElement) {
        child.parentElement.children = child.parentElement.children.filter((item) => item !== child)
      }
      child.parentElement = this
      this.children.push(child)
    }
  }

  appendChild(child) {
    this.append(child)
    return child
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = null
    this.children = []
    this.append(...children)
  }

  replaceWith(replacement) {
    if (!this.parentElement) return
    const parent = this.parentElement
    const index = parent.children.indexOf(this)
    if (index === -1) return
    this.parentElement = null
    replacement.parentElement = parent
    parent.children[index] = replacement
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
    if (name === 'class') this.className = String(value)
  }

  getAttribute(name) {
    if (name === 'class') return this.className || null
    return this.attributes.get(name) ?? null
  }

  querySelectorAll(selector) {
    const found = []
    const visit = (element) => {
      for (const child of element.children) {
        if (matchesSelector(child, selector)) found.push(child)
        visit(child)
      }
    }
    visit(this)
    return found
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }

  closest(selector) {
    let element = this
    while (element) {
      if (matchesSelector(element, selector)) return element
      element = element.parentElement
    }
    return null
  }

  contains(candidate) {
    if (candidate === this) return true
    return this.children.some((child) => child.contains(candidate))
  }

  focus() {
    this.ownerDocument.activeElement = this
    this.dispatchEvent(new TestEvent('focus'))
  }

  getBoundingClientRect() {
    return { left: 0, right: 200, top: 0, bottom: 24, width: 200, height: 24 }
  }
}

class TestDocument extends TestEventTarget {
  constructor() {
    super()
    this.activeElement = null
    this.body = this.createElement('body')
  }

  createElement(tagName) {
    const element = new TestElement(tagName, this)
    if (element.tagName === 'TABLE') {
      element.insertRow = () => {
        const row = this.createElement('tr')
        element.append(row)
        return row
      }
    }
    return element
  }

  createElementNS(_namespace, tagName) {
    return this.createElement(tagName)
  }
}

class TestResizeObserver {
  observe() {}
  disconnect() {}
}

export function installTestDom() {
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    ResizeObserver: globalThis.ResizeObserver,
    CustomEvent: globalThis.CustomEvent,
  }
  const document = new TestDocument()
  const window = new TestEventTarget()
  const storage = new Map()
  window.innerWidth = 1280
  window.document = document
  window.localStorage = {
    getItem: (key) => storage.get(String(key)) ?? null,
    setItem: (key, value) => storage.set(String(key), String(value)),
    removeItem: (key) => storage.delete(String(key)),
    clear: () => storage.clear(),
  }
  globalThis.document = document
  globalThis.window = window
  globalThis.ResizeObserver = TestResizeObserver
  globalThis.CustomEvent = TestCustomEvent
  return {
    document,
    window,
    restore() {
      globalThis.document = original.document
      globalThis.window = original.window
      globalThis.ResizeObserver = original.ResizeObserver
      globalThis.CustomEvent = original.CustomEvent
    },
  }
}
