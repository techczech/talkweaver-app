import { GitBranch } from 'lucide-react'
import type { TalkInfo } from '../../../../preload/index'

export default function PathwayBadge({
  talk,
  pathwayCount,
  pathwayNames,
  variant
}: {
  talk: TalkInfo
  pathwayCount: number
  pathwayNames: string[]
  variant: 'ledger' | 'shelf'
}): JSX.Element | null {
  if (pathwayCount <= 0) return null
  return (
    <button
      type="button"
      className={variant === 'shelf' ? 'tl-badge tl-badge--pathways' : 'tl-row-pathways'}
      title={`Pathways: ${pathwayNames.join(' · ')}`}
      aria-label={`Open pathways for ${talk.title}`}
      onClick={(event) => {
        event.stopPropagation()
        void window.tw.tools.openPathways({
          outlinePath: talk.outlinePath,
          talkSlug: talk.slug,
          talkTitle: talk.title
        })
      }}
    >
      <GitBranch size={variant === 'shelf' ? 8.5 : 10} aria-hidden />
      {pathwayCount}
    </button>
  )
}
