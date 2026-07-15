/// <reference lib="dom" />
// Preload entry for a plain presentation window (present mode 'window'). Mounts ONLY the ⌘E edit
// bridge — no recording. (The presenter view gets the edit bridge via the recorder preload instead,
// and the audience view stays preload-less + portable.)

import { mountEditBridge } from './present-edit-bridge'

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => mountEditBridge(), { once: true })
} else {
  mountEditBridge()
}
