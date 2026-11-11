/**
 * "Open settings for <feature>" (house rule R12): every feature that has preferences opens the Settings
 * window at its section instead of showing a read-only copy. `section` is a real Settings section id:
 * 'recording', 'importing', 'presenting', 'publishing', 'writing', 'talk-defaults', 'updates', or one of
 * the custom pages 'cloudflare', 'backups'. Without one Settings opens where it was.
 */
export function openSettingsAt(section?: string): void {
  void window.tw.settingsWindow?.open(section).catch(() => { /* main not answering: nothing to show */ })
}
