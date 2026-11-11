// The verb inventory (design element 11) for the built-in agent skill: every verb an agent can call,
// as data. The skill's generated references/commands.md is built from it, and scripts/test-agent-skill-coverage.mjs
// fails, naming the verb, when one is not described in the hand-written skill (or listed with a reason
// in resources/agent-skill/not-in-skill.txt). A verb added, changed or removed is not finished until the
// skill says so: that is part of the feature, in the same change.
//
// Command-line verbs: `setup` and `settings` are checked against their own usage text by the same test, so
// this list cannot drift from the parsers; `agent` comes from the route's own table (agent-skill/cli.ts).
// In-process verbs (AGENT_VERBS, agent-verbs.ts) have no external route yet; they are listed so a new one cannot
// be forgotten.
//
// No Electron import; erasable TypeScript only (a node script imports it as it is).
import { AGENT_ROUTE_VERBS } from './agent-skill/cli.ts'
import { AGENT_VERBS } from './agent-verbs.ts'

export interface VerbEntry {
  /** `setup status`, `settings set`, `agent install` (command line) or `research.capture` (in-process). */
  verb: string
  args: string
  summary: string
  route: 'cli' | 'in-process'
}

const setup = (verb: string, args: string, summary: string): VerbEntry => ({ verb: `setup ${verb}`, args, summary, route: 'cli' })
const settings = (verb: string, args: string, summary: string): VerbEntry => ({ verb: `settings ${verb}`, args, summary, route: 'cli' })

export const CLI_VERBS: readonly VerbEntry[] = [
  setup('status', '[--json]', 'Reads every row of publishing, live service, recording storage, transcription and the Importer. Exit 0 when connected and Publishing and Going live are Ready.'),
  setup('cloudflare connect', '[--json]', 'Reads the Cloudflare token from standard input, saves it to the operating system\'s secure storage, checks it.'),
  setup('cloudflare account', '<id> [--json]', 'Chooses the account when the token sees several.'),
  setup('cloudflare create-site', '[name] [--json]', 'Sets the site name (default talkweaver-handouts) and creates the Pages site.'),
  setup('cloudflare live', '[--json]', 'Sets up or updates the live service.'),
  setup('cloudflare share-domain', '<host> | --clear [--json]', 'Attaches or removes the share-link address.'),
  setup('cloudflare disconnect', '[--json]', 'Removes the token; the deployed live service is left alone.'),
  setup('recording', '--endpoint <url> --bucket <name> [--json]', 'Sets recording storage; access keys come from standard input; checks the bucket.'),
  setup('transcription', '--python <path> --script <path> [--ffmpeg <path>] [--json]', 'Sets the transcription paths (full paths) and checks them.'),
  setup('help', '', 'Prints the list.'),
  settings('list', '[--section <id>] [--json]', 'Lists settings with their values (secrets have none).'),
  settings('get', '<key> [--json]', 'Reads one setting.'),
  settings('set', '<key> <value> [--json]', 'Changes one setting; refuses secrets and invalid values; logged as the agent.'),
  settings('reset', '<key> | --section <id> | --all --yes [--json]', 'Puts settings back to their defaults.'),
  settings('rebind', '<command> <shortcut> [--json]', 'Changes a shortcut ("cmd+shift+l" or "none").'),
  settings('reset-shortcut', '<command> | --all --yes [--json]', 'Puts a shortcut (or all) back to its default.'),
  settings('changes', '[--limit <n>] [--json]', 'Shows the changelog, newest first.'),
  settings('export', '<file> [--json]', 'Writes the settings to a file.'),
  settings('import', '<file> [--yes] [--json]', 'Imports a settings file; settings that name something to run or somewhere to send data are skipped.'),
  settings('undo-import', '--last | <batch> [--json]', 'Undoes an import.'),
  ...AGENT_ROUTE_VERBS.map((v): VerbEntry => ({ verb: v.verb, args: v.args, summary: v.summary, route: 'cli' }))
]

export const IN_PROCESS_VERBS: readonly VerbEntry[] = [
  { verb: 'imageEdit.read', args: 'vaultRoot imageId', summary: 'readImageEdit: reads the original and editable crop/markup recipe.', route: 'in-process' },
  { verb: 'imageEdit.save', args: 'vaultRoot originalId recipe stillWritable', summary: 'saveImageEdit: creates a separate PNG and recipe; never overwrites the original.', route: 'in-process' },
  ...AGENT_VERBS.map((v): VerbEntry => ({
  verb: v.id, args: Object.keys(v.inputs).join(', '), summary: 'In-process verb of the app\'s agent catalogue.', route: 'in-process'
}))]

export const VERB_INVENTORY: readonly VerbEntry[] = [...CLI_VERBS, ...IN_PROCESS_VERBS]

/** references/commands.md, generated from the inventory at build. */
export function commandsReference(): string {
  const rows = (family: string): string[] => CLI_VERBS.filter((v) => v.verb.startsWith(`${family} `)).map((v) => `| \`talkweaver ${v.verb}\` | ${v.args ? `\`${v.args}\`` : ''} | ${v.summary} |`)
  const table = (family: string): string[] => ['| Command | Arguments | What it does |', '|---|---|---|', ...rows(family), '']
  return [
    '# Commands (generated)',
    '',
    'Generated from the app\'s verb inventory at build. Do not edit. When to use each verb: [CLI](cli.md).',
    '',
    'Exit codes: 0 done or ready, 1 not done or not ready, 2 usage error. `setup` refuses while the app is open.',
    '',
    '## setup', '', ...table('setup'),
    '## settings', '', ...table('settings'),
    '## agent', '', ...table('agent'),
  ].join('\n')
}
