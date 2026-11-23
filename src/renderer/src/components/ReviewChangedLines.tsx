import { useMemo } from 'react'
import { changedLines } from '../../../shared/feedback'

export default function ReviewChangedLines({ before, after }: { before: string; after: string }) {
  const diff = useMemo(() => changedLines(before, after), [before, after])
  return <pre className="tw-review-diff" aria-label="Markdown changes" tabIndex={0}>
    {diff.length ? diff.map((line, index) => line.op === 'add'
      ? <ins key={index}>{line.text}{'\n'}</ins> : <del key={index}>{line.text}{'\n'}</del>) : 'Only spacing changed.'}
  </pre>
}
