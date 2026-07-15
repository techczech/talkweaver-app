export type IndexedTalk = {
  name: string
  path: string
  outlinePath: string
  title: string
  slug: string
}

export function createVaultIndex(options: { cachePath: string; batchSize?: number }): {
  cached(root: string): Promise<IndexedTalk[]>
  metadata(root: string): Promise<Record<string, { createdMs: number; editedMs: number; subtitle: string | null; event: string | null }>>
  refresh(root: string, onBatch?: (batch: IndexedTalk[], reset: boolean, done: boolean) => void): Promise<IndexedTalk[]>
  invalidate(): void
}
