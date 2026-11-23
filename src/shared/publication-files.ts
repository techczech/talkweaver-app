import type { MediaPublishChoice, PublishNotReady } from './publish-status.ts'

export type PublicationFileFinding = { file: string; slide: string; reason: 'missing' | 'outside' | 'unreadable' | 'not-downloaded' }
export type PublicationFileCheck = { checked: number; findings: PublicationFileFinding[] }

export const PUBLICATION_FILES_PENDING = 'Some media may still be downloading.'
const reasonText: Record<PublicationFileFinding['reason'], string> = {
  missing: 'missing',
  outside: 'outside the allowed media folders',
  unreadable: 'could not be read',
  'not-downloaded': 'still downloading',
}
const describe = (finding: PublicationFileFinding) => `${finding.file} — ${reasonText[finding.reason]}${finding.slide ? ` (slide ${finding.slide})` : ''}`

export function publicationFilesWarning(check: PublicationFileCheck): PublishNotReady | null {
  if (!check.findings.length) return null
  return { kind: 'media-warning', title: 'Some media may be unavailable',
    detail: check.findings.slice(0, 20).map(describe).join('\n'),
    fix: { action: 'get-library-files', label: 'Get files and recheck' } }
}

/** A recovery recheck always comes back to the person before any upload. */
export function publicationMediaReview(check: PublicationFileCheck | undefined, notices: string[], choice?: MediaPublishChoice): {
  prompt?: PublishNotReady; notices?: string[]
} {
  const findings = check?.findings ?? []
  if (choice === 'recheck-media') {
    const warning = check && publicationFilesWarning(check)
    return { prompt: warning || {
      kind: notices.length ? 'media-warning' : 'media-ready',
      title: notices.length ? 'Some media may be unavailable' : 'Media is ready to publish',
      detail: notices.join('\n') || null,
      fix: { action: 'get-library-files', label: 'Get files and recheck' },
    } }
  }
  if (check && choice !== 'with-placeholders' && findings.some(finding => finding.reason !== 'not-downloaded')) {
    return { prompt: publicationFilesWarning(check) ?? undefined }
  }
  return { notices: [...notices, ...findings.filter(finding => finding.reason === 'not-downloaded').slice(0, 20).map(describe)] }
}

/** Media that disappears during the build is reported with the published handout. */
export function publicationBuildWarnings(warnings: string[]): string[] {
  return warnings.map(warning => {
    const match = /^(missing-asset|missing-image|asset-outside-vault):([^:]+):(.+)$/.exec(warning)
    return match
      ? describe({ slide: match[2], file: match[3], reason: match[1] === 'asset-outside-vault' ? 'outside' : 'missing' })
      : warning
  })
}
