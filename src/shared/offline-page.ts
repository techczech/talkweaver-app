export type OfflinePageInput = { outlinePath: string; source: string }
export type OfflinePageSaveResult =
  | { ok: true; embedPath: string; title: string; omitted: number; images: number; dataFiles: number }
  | { ok: false; message: string }
