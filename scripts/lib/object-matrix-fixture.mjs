// The compiler's reference fixtures cover the layout vocabulary. These extra specimens
// cover editing objects, local media, private blocks and the two reported regressions.
import { fixtures } from '../../compiler/reference/fixtures.mjs'

const map = [
  ['Models', 'Drafting', 'Checking'],
  ['Tools', 'Terminal'],
  ['Hardware', 'Laptop', 'Workstation', 'Server'],
  ['Context', 'Git', 'Notes'],
  ['Skills', 'Research', 'Teaching']
]

export const branches = map.map(([name]) => name)
export const matrixTitle = 'Object matrix fixture'

const slide = (id, name, body, extras = {}) => ({
  id, name, markdown: '### ' + name + '\n{id=' + id + '}' + (extras.tokens ?? '') + '\n\n' + body, ...extras
})
const object = (id, name, body, kind, painted, tokens) => slide(id, name, body, { kind, painted, tokens })
const table = map.map(([name, ...cells]) => '- ' + name + '\n' + cells.map(cell => '  - ' + cell).join('\n')).join('\n')

export const cases = [
  object('matrix-map', 'Five branch mind map', table, 'mindmap', '.mindmap-mm[data-mm-painted] svg .markmap-node', '{mindmap}{mode=reveal}'),
  object('matrix-table', 'Header row table', table, 'table', '.slide-table', '{table}{mode=reveal}'),
  object('matrix-table-plain', 'Plain header and column', table, 'table', '.slide-table', '{table}{table-header=off}{table-first-column=off}'),
  object('matrix-image', 'Local picture', '![Two connected boxes](assets/two-box.svg)', 'picture', 'figure img'),
  object('matrix-video', 'Local video', '![A local clip](clip.webm){controls}', 'picture', 'figure video, figure img'),
  object('matrix-audio', 'Local audio', '![A silent audio clip](silent.wav)', 'picture', '.slide-audio'),
  object('matrix-embed', 'Local HTML embed', '[Embed: widget.html]', 'embed', 'figure.slide-embed'),
  object('matrix-sim', 'Local HTML simulation', '[Simulation: widget.html]', 'embed', 'figure.slide-embed'),
  object('matrix-mermaid', 'Mermaid diagram', '~~~mermaid\nflowchart LR\n  A[Draft] --> B[Publish]\n~~~', 'mermaid', '.mermaid-mm svg'),
  object('matrix-svg', 'SVG diagram', '~~~svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 60"><rect width="90" height="60" fill="#1555b3"/><circle cx="45" cy="30" r="16" fill="white"/></svg>\n~~~', 'svg', '.svg-panel svg, .inline-svg svg, .slide-content svg'),
  slide('matrix-poll', 'Poll question', '- Keep\n- Change', { tokens: '{poll=single}', painted: '.poll-frame' }),
  slide('matrix-board', 'Feedback board', '- Keep\n- Stop\n- Try', { tokens: '{poll=board}', painted: '.poll-frame' }),
  slide('matrix-reactions', 'Custom reactions', 'Which part should we explore?', { tokens: '{reactions="More examples","More time"}' }),
  slide('matrix-icon', 'An explicit icon', '- Draft {icon=lucide:pencil}\n- Check {icon=lucide:check}', { tokens: '{iconlist}', painted: '.slide-content li svg' }),
  object('matrix-notes', 'Speaker notes', 'A public body line.\n\n:::notes\nPrivate notes matrix sentinel.\n:::', 'notes'),
  object('matrix-comment', 'HTML comment', 'A public body line.\n\n<!-- Private comment matrix sentinel. -->', 'comment'),
  ...fixtures.map(fixture => {
    // The reference corpus uses ref-table twice for its two storage forms.
    const id = fixture.id === 'ref-table' && fixture.explicit === '{layout=table}' ? 'ref-outline-table' : fixture.id
    const kind = ({ 'ref-mindmap': 'mindmap', 'ref-code': 'code', 'ref-table': 'table', 'ref-outline-table': 'table',
      'ref-image': 'picture', 'ref-copy-visual': 'picture', 'ref-gallery': 'picture', 'ref-image-claim': 'picture',
      'ref-cta-screenshots': 'picture', 'ref-image-quote': 'picture', 'ref-image-grid': 'picture',
      'ref-chat': 'chat', 'ref-chat-lanes': 'chat', 'ref-terminal': 'terminal', 'ref-terminal-agent': 'chat',
      'ref-trace': 'trace', 'ref-trace-dialogue': 'trace', 'ref-embed': 'embed', 'ref-auto-embed': 'embed',
      'ref-chart-bar': 'chart', 'ref-chart-line': 'chart', 'ref-chart-pie': 'chart'
    })[id]
    const markdown = fixture.markdown
      .replace('id=' + fixture.id, 'id=' + id)
      .replace('[Embed: https://example.org/demo]', '[Embed: widget.html]')
      // The reference deck also documents inline layout triggers. Use their equivalent
      // trigger line for layouts with a dedicated Markdown card.
      .replace(/^(#{2,6} .+?)[ \t]+((?:\{[^{}\n]*\}[ \t]*)+)$/m, '$1\n$2')
      .replace('{id=ref-carousel}', '{id=ref-carousel}{carousel}')
      .replace(/^\{chat\}$/m, '{chat}{mode=reveal}')
    const painted = id === 'ref-mindmap' ? '.mindmap-mm[data-mm-painted] svg .markmap-node' : undefined
    return { id, name: fixture.name, kind, markdown, painted }
  })
]

export const outline = [
  '---', 'title: ' + matrixTitle, 'outline_version: 2', 'auto_title_slide: false', 'auto_thanks_slide: false', '---',
  '## Object specimens', '{id=matrix-section}', '',
  ...cases.flatMap(specimen => [specimen.markdown, ''])
].join('\n')
