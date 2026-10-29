// `TalkWeaver settings list | get <key> | set <key> <value> | reset <key> | changes | export <file> |
// import <file> | undo-import --last [--json]` (0.42): the agent's path to the same settings file and
// changelog the Settings window uses, through @app-patterns/settings' CLI (every change logged as the agent,
// through the same lock, seen by an open Settings window within a second).
//
// Found at the command position like `setup` (setup-cli.ts commandArguments), but it does NOT take the
// single-instance lock: the settings file has its own lock, so it runs while the app is open. The
// migration runs first (the same runMigration the app runs), so a first `settings` command on an
// install that has only config.json sees the preferences moved in, and a write the migration could not
// land is not stamped (tried again next time).
//
// No Electron import: scripts/test-shared-settings.mjs runs it in a temporary folder. Keys are never
// listed with a value: the schema's `secret` rows have none, and `set` refuses them.
import { commandsAdapter } from '@app-patterns/settings'
import { runSettingsCli, SettingsStore, type LockOptions, type SettingsCliIO } from '@app-patterns/settings/node'
import { APP_ID, APP_NAME, registry } from '../shared/bridle-commands.ts'
import { migrateLegacy, schema } from '../shared/settings-schema.ts'
import { commandArguments } from './setup-cli.ts'
import { runMigration } from './settings-migration.ts'

export function settingsArguments(argv: readonly string[], defaultApp: boolean): string[] | null {
  return commandArguments(argv, defaultApp, 'settings')
}

export async function runTalkWeaverSettings(args: string[], opts: { dir: string; version: string; io: SettingsCliIO; lock?: LockOptions }): Promise<number> {
  const base = { dir: opts.dir, app: APP_ID, schema, registry: commandsAdapter(registry), migrate: migrateLegacy, ...(opts.lock ? { lock: opts.lock } : {}) }
  try {
    const moved = await runMigration(opts.dir, () => new SettingsStore({ ...base, appVersion: opts.version, watch: false, who: { kind: 'app-update', version: opts.version } as never, log: () => {} }))
    if (moved.kind === 'unreadable') opts.io.stderr('The earlier preferences file (config.json) could not be read; the command goes on without moving them.\n')
  } catch {
    opts.io.stderr('The earlier preferences could not be moved into the settings file; the command goes on without them.\n')
  }
  return runSettingsCli(args, { ...base, appName: APP_NAME, version: opts.version }, opts.io)
}
