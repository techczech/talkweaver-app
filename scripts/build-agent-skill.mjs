#!/usr/bin/env node
// Builds the app's agent skill (design element 19): resources/agent-skill/talkweaver/ copied to
// agent-skill-dist/talkweaver/ with metadata.app and metadata.app-version stamped into SKILL.md (the skill
// and the app are always the same version), the set-up procedure copied in as references/talkweaver-setup.md
// (one source: resources/agent-setup/cloudflare.md), and references/commands.md generated from the verb
// inventory (src/main/agent-inventory.ts), so the skill cannot drift from the CLI.
//
//   node scripts/build-agent-skill.mjs [--out <dir>]      default agent-skill-dist (packed by electron-builder)
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SKILL_NAME = 'talkweaver'
export const APP_ID = 'talkweaver'

/** SKILL.md with `metadata.app` and `metadata.app-version` set (any earlier metadata block is replaced). */
export function stampSkill(skillMd, appId, version) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd)
  if (!m) throw new Error('SKILL.md has no frontmatter')
  const lines = m[1].split(/\r?\n/)
  const kept = []
  let inMeta = false
  for (const line of lines) {
    if (/^metadata:\s*$/.test(line)) { inMeta = true; continue }
    if (inMeta && /^\s+\S/.test(line)) continue
    inMeta = false
    kept.push(line)
  }
  kept.push('metadata:', `  app: ${appId}`, `  app-version: ${version}`)
  return `---\n${kept.join('\n')}\n---${skillMd.slice(m[0].length)}`
}

export async function buildAgentSkill({ outDir, version } = {}) {
  const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const out = resolve(outDir ?? join(root, 'agent-skill-dist'))
  const dest = join(out, SKILL_NAME)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(join(root, 'resources', 'agent-skill', SKILL_NAME), dest, { recursive: true })
  cpSync(join(root, 'resources', 'agent-setup', 'cloudflare.md'), join(dest, 'references', 'talkweaver-setup.md'))
  const skillPath = join(dest, 'SKILL.md')
  writeFileSync(skillPath, stampSkill(readFileSync(skillPath, 'utf8'), APP_ID, version ?? pkgVersion))
  const { commandsReference } = await import(pathToFileURL(join(root, 'src', 'main', 'agent-inventory.ts')).href)
  writeFileSync(join(dest, 'references', 'commands.md'), `${commandsReference()}\n`)
  return dest
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out')
  const dest = await buildAgentSkill({ outDir: i > 0 ? process.argv[i + 1] : undefined })
  console.log(`agent skill built: ${dest}`)
}
