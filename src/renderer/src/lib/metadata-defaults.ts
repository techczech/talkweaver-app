// Renderer-side read-through cache of the presenter identity / deck defaults (Ticket 9b).
//
// The values are PERSISTED once, in the main process's config.json, through the existing
// `settings:*-metadata-defaults` IPC — this module adds no second store. It exists because the
// CodeMirror frontmatter widget renders synchronously and cannot await IPC: it reads the last
// known snapshot, and every surface that writes a default refreshes it.

import type { MetadataDefaults } from '../../../shared/metadata-surfaces'

export const METADATA_DEFAULTS_CHANGED_EVENT = 'tw:metadata-defaults-changed'

let snapshot: MetadataDefaults = {}
let loaded = false

/** The last known defaults. Empty until the first load resolves — never blocks a render. */
export function metadataDefaultsSnapshot(): MetadataDefaults {
  return snapshot
}

function publish(next: MetadataDefaults): MetadataDefaults {
  snapshot = next ?? {}
  loaded = true
  window.dispatchEvent(new CustomEvent(METADATA_DEFAULTS_CHANGED_EVENT))
  return snapshot
}

/** Read the defaults from the main process and refresh the snapshot. */
export async function loadMetadataDefaults(): Promise<MetadataDefaults> {
  try {
    return publish(await window.tw.settings.getMetadataDefaults())
  } catch {
    return snapshot
  }
}

/** Load once per session; later callers get the cached snapshot. */
export async function ensureMetadataDefaults(): Promise<MetadataDefaults> {
  return loaded ? snapshot : loadMetadataDefaults()
}

/** Persist one or more defaults (blank clears) and refresh the snapshot. */
export async function saveMetadataDefaults(patch: MetadataDefaults): Promise<MetadataDefaults> {
  return publish(await window.tw.settings.setMetadataDefaults(patch))
}
