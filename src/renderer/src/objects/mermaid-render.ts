// The app's one mermaid door. Lazy so mermaid's ~2 MB never loads until a deck uses it.
let ready: Promise<typeof import('mermaid')> | null = null
export const MERMAID_CONFIG = {
  startOnLoad: false,
  theme: 'neutral' as const,
  securityLevel: 'strict' as const,
  suppressErrorRendering: true,
  // Mermaid 11.16's global setting controls shared label renderers. Keep the deprecated
  // flowchart-specific path false too; the class.htmlLabels schema key has no bundle read site.
  htmlLabels: false,
  flowchart: { htmlLabels: false }
}
function library(): Promise<typeof import('mermaid')> {
  ready ??= import('mermaid')
    .then((module) => { module.default.initialize(MERMAID_CONFIG); return module })
    .catch((error) => {
      ready = null
      throw error
    })
  return ready
}
/** Render to SVG text. On failure, sweep mermaid's orphaned error nodes out of document.body
 *  (mermaid.render appends work nodes to <body>; a throw strands them — WriteFlex C-series find). */
export async function renderMermaid(source: string): Promise<{ svg: string } | { error: string }> {
  const id = `tw-mermaid-${crypto.randomUUID()}`
  const originalBodyChildren = new Set(document.body.children)
  try {
    const { default: mermaid } = await library()
    const { svg } = await mermaid.render(id, source)
    return { svg }
  } catch (error) {
    document.getElementById(id)?.remove()
    Array.from(document.body.children).forEach((node) => {
      if (!originalBodyChildren.has(node) && /^d[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(node.id)) node.remove()
    })
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
