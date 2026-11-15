// A stand-in Mac update file for the in-place update tests (ADR-0044): a zip shaped as the release workflow
// makes it (ditto --keepParent: one `<Name>.app` at the top), whose Info.plist names `version` and `bundleId`,
// padded with random bytes so that a download takes long enough to hold half-way. macOS only (ditto).
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function makeUpdateZip({ version, bundleId = 'com.techczech.talkweaver', name = 'TalkWeaver', padBytes = 0 }) {
  const dir = mkdtempSync(join(tmpdir(), 'tw-update-zip-'))
  try {
    const contents = join(dir, `${name}.app`, 'Contents')
    mkdirSync(join(contents, 'Resources'), { recursive: true })
    writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>
`)
    if (padBytes > 0) writeFileSync(join(contents, 'Resources', 'padding.bin'), randomBytes(padBytes))
    const out = join(dir, 'update.zip')
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', join(dir, `${name}.app`), out])
    return readFileSync(out)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

/** "6.3 MB", as the popover writes a size (src/shared/update-install.ts sizeText). */
export function sizeLabel(bytes) {
  const mb = bytes / 1_000_000
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`
}
