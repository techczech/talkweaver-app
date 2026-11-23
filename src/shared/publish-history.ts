// Structured events only: no API bodies, source text, credentials or raw exception strings.
export type PublishStage = 'started' | 'files' | 'authorised' | 'inventory' | 'record' | 'building' | 'built' | 'uploading' | 'uploaded' | 'confirmed' | 'local-record-failed' | 'finished'
export type PublishHistoryEvent = {
  attemptId: string; at: string; computer: string; appVersion: string; entry: string; stage: PublishStage
  site?: string; revision?: string; files?: number; bytes?: number; removed?: number; missing?: number; folders?: string[]
  recordPresent?: boolean; linksReconciled?: number; linkStyleChanged?: boolean; outcome?: 'published' | 'unchanged' | 'rehearsed' | 'stopped' | 'unknown' | 'unexpected-error'
}
export type PublishHistoryAttempt = {
  id: string; startedAt: string; computer: string; appVersion: string; entry: string
  site?: string; outcome?: PublishHistoryEvent['outcome']; events: PublishHistoryEvent[]
}
export type PublishSiteCheck = { state: 'in-step' | 'changed' | 'unknown'; checkedAt: string; revision?: string; publishedBy?: string; publishedAt?: string; publisherVersion?: string }
export const publishStageLabel: Record<PublishStage, string> = {
  started: 'Started publishing', files: 'Checked this Mac’s source files', authorised: 'Checked the publishing connection', inventory: 'Checked the live site',
  record: 'Read the shared short-link record', building: 'Started building the selected pages', built: 'Built the selected change',
  uploading: 'Started uploading missing assets', uploaded: 'Uploaded missing assets', confirmed: 'Confirmed the live deployment',
  'local-record-failed': 'Could not save the published Run link on this Mac', finished: 'Finished',
}
