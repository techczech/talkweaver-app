// Runs only in an isolated world of the disposable page. Returns data, never raw HTML.
export function readOfflinePage() {
  const tags = new Set('address article aside b blockquote br caption code dd del details div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i li main nav ol p pre s section small span strong sub summary sup table tbody td th thead time tr u ul'.split(' '))
  const styles = 'display color background-color font-family font-size font-weight font-style line-height text-align white-space border-top-width border-top-style border-top-color border-bottom-width border-bottom-style border-bottom-color border-left-width border-left-style border-left-color border-right-width border-right-style border-right-color border-collapse padding-top padding-right padding-bottom padding-left margin-top margin-right margin-bottom margin-left max-width'.split(' ')
  let count = 0, omitted = 0, textSize = 0, imageSize = 0
  const images = []
  function visit(node, depth) {
    if (++count > 12000 || depth > 80) { omitted++; return null }
    if (node.nodeType === 3) {
      const text = node.textContent.slice(0, Math.min(200000, Math.max(0, 4 * 1024 * 1024 - textSize)))
      textSize += text.length
      if (text.length < node.textContent.length) omitted++
      return { text }
    }
    if (node.nodeType !== 1) return null
    const tag = node.localName
    if (['script', 'style', 'link', 'meta', 'base', 'noscript', 'template'].includes(tag)) return null
    const computed = getComputedStyle(node)
    if (computed.display === 'none' || computed.visibility === 'hidden') return null
    if (['input', 'textarea', 'select'].includes(tag)) { omitted++; return null }
    if (computed.backgroundImage !== 'none') omitted++
    const style = {}
    for (const key of styles) style[key] = computed.getPropertyValue(key).slice(0, 300)
    if (tag === 'img' || tag === 'canvas') {
      style.width = computed.width
      style.height = computed.height
      let src = tag === 'img' ? node.currentSrc || node.src : ''
      try {
        if (tag === 'canvas') src = node.toDataURL('image/png')
      } catch { omitted++ }
      if (!src) return null
      imageSize += src.length
      if (images.length >= 100 || imageSize > 12 * 1024 * 1024) { omitted++; return null }
      const index = images.push({ src }) - 1
      return { tag: 'img', image: index, alt: (node.alt || '').slice(0, 300), style }
    }
    if (['iframe', 'object', 'embed', 'video', 'audio', 'svg'].includes(tag)) { omitted++; return null }
    const children = Array.from(node.childNodes).map(child => visit(child, depth + 1)).filter(Boolean)
    const attrs = {}
    for (const key of ['colspan', 'rowspan', 'start', 'value']) { const value = node.getAttribute(key); if (value && /^-?\d{1,5}$/.test(value)) attrs[key] = value }
    return { tag: tags.has(tag) ? tag : 'div', style, attrs, children }
  }
  return { title: document.title.slice(0, 200), tree: visit(document.body || document.documentElement, 0), images, omitted }
}
