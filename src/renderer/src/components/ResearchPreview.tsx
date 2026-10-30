import { useMemo } from 'react'
import { lexMarkdownBlocksWith } from '../../../../compiler/scripts/lib/03-markdown-lexer-core.mjs'
import { renderInline } from '../../../../compiler/scripts/lib/00-inline-render.mjs'
import { createStepHtmlSanitiser } from '../../../shared/work-step-html'
import type { ResearchItem } from '../../../shared/research'

/** The compiler's Markdown lexer and inline renderer, through the existing HTML sanitiser. */
export default function ResearchPreview({ item, onSource }: { item: ResearchItem; onSource: (source: string) => void }) {
  const sanitise = useMemo(() => createStepHtmlSanitiser(window), [])
  const inline = (value: unknown): JSX.Element => <span dangerouslySetInnerHTML={{ __html: sanitise(renderInline(String(value ?? ''))).html }} />
  const blocks = useMemo(() => {
    try { return lexMarkdownBlocksWith(item.body.split('\n'), () => null) }
    catch { return [{ type: 'code', text: item.body }] }
  }, [item.body])
  return <div className="research-markdown" onClick={event => {
    const anchor = (event.target as Element).closest('a')
    if (anchor) { event.preventDefault(); onSource(anchor.getAttribute('href') ?? '') }
  }}>
    {blocks.map((block, index) => {
      if (block.type === 'table') return <table key={index}><thead><tr>{(block.header as string[]).map((cell, i) => <th key={i}>{inline(cell)}</th>)}</tr></thead><tbody>{(block.rows as string[][]).map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c}>{inline(cell)}</td>)}</tr>)}</tbody></table>
      if (block.type === 'list') {
        const contents = (block.items as string[]).map((entry, i) => <li key={i}>{inline(entry)}</li>)
        return block.ordered ? <ol key={index}>{contents}</ol> : <ul key={index}>{contents}</ul>
      }
      if (block.type === 'code') return <pre key={index}>{String(block.code ?? block.text ?? '')}</pre>
      if (block.type === 'quote') return <blockquote key={index}>{inline(block.text)}{block.cite ? <cite>{inline(block.cite)}</cite> : null}</blockquote>
      if (block.type === 'subheading') return <h4 key={index}>{inline(block.text)}</h4>
      if (block.type === 'image' || block.type === 'embed') return null // Only contained, bounded artefacts below can load.
      return <p key={index}>{inline(block.text ?? block.quote ?? '')}</p>
    })}
    {item.artefacts.map(artefact => artefact.data !== undefined && <div className="research-artefact" key={artefact.file}>
      {artefact.type === 'image' ? <img src={artefact.data} alt={item.title} />
        : artefact.type === 'html' ? <iframe title={`Preview: ${artefact.name}`} sandbox="" referrerPolicy="no-referrer" srcDoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><body>${sanitise(artefact.data).html}</body>`} />
          : <pre>{artefact.data}</pre>}
    </div>)}
  </div>
}
