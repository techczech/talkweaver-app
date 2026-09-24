export const BACKUP_ASSETS_CEILING_BYTES: number

export type BackupSkip = { slug: string; reason: string }
export type BackupRunResult = {
  at: number
  ok: boolean
  exported: number
  skipped: number
  failed: number
  skippedTalks: BackupSkip[]
  folder?: string
  error?: string
}

export function joinBackupPath(folder: string, slug: string): string

export function createBackupSweep(options: {
  buildHtml: (outlinePath: string) => Promise<string>
  assetBytesOf: (outlinePath: string) => number
  writeFile: (dest: string, html: string) => void
  ensureDir: (folder: string) => void
  onExported?: (slug: string, bytes: number) => void
  log?: (line: string) => void
  destFor?: (folder: string, slug: string) => string
  assetsCeilingBytes?: number
  yieldToEventLoop?: () => Promise<void>
}): {
  run(input: { folder: string; talks: Array<{ slug: string; outlinePath: string }> }): Promise<BackupRunResult>
  exportOneTalk(outlinePath: string, dest: string): Promise<{ ok: boolean; bytes: number }>
}
