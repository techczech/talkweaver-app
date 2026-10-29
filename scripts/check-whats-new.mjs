#!/usr/bin/env node
// Refuses a release version without its What's new notes (update notices, ADR-0041): run before packing
// (scripts/electron-builder-before-pack.cjs) and by hand. A preview version needs none.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { whatsNewProblems } from './lib/update-release-checks.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version
const file = join(repo, 'resources', 'whats-new', `${version}.md`)
const problems = whatsNewProblems(version, existsSync(file) ? readFileSync(file, 'utf8') : null)
if (problems.length) {
  for (const problem of problems) console.error(`check-whats-new: ${problem}`)
  process.exit(1)
}
console.log(`check-whats-new: ${version} ${/-/.test(version) ? 'is a preview and needs no notes' : 'has its notes'}`)
