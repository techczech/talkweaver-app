# TalkWeaver command line

Run as `talkweaver <family> <verb>`; the fallback is the app binary with the same arguments. Every verb takes `--json`.

Exit codes: 0 done, 1 not done or not ready (the state is printed), 2 usage error (nothing was done).

The complete verb list with arguments is generated: [commands](commands.md). This page says when to use each verb.

## setup

Publishing, live service, recording storage, transcription. Quit TalkWeaver first: every `setup` verb refuses while the app is open and changes nothing. Procedure and states: [set-up procedure](talkweaver-setup.md).

- `talkweaver setup status --json`: reads every row; start here.
- `talkweaver setup cloudflare connect`: token on standard input, never an argument.
- `talkweaver setup cloudflare account <id>`: when the token sees several accounts.
- `talkweaver setup cloudflare create-site [name]`: the Pages site for handouts.
- `talkweaver setup cloudflare live`: set up or update the live service.
- `talkweaver setup cloudflare share-domain <host>` or `--clear`: the share-link address.
- `talkweaver setup cloudflare disconnect`: removes the token; the deployed live service stays.
- `talkweaver setup recording --endpoint <url> --bucket <name>`: access keys on standard input.
- `talkweaver setup transcription --python <path> --script <path> [--ffmpeg <path>]`: full paths only.
- `talkweaver setup help`: the list.

Each argument has a fixed format and is refused (exit 2, value never echoed) outside it. `--json` prints one document, format `talkweaver-setup/1`, with `ready`, `error` and one row per area; progress goes to standard error.

## settings

The same settings file and changelog the Settings window uses. Runs beside the open app. Every change is logged as the agent; pass `--agent <name>` to name yourself.

- `talkweaver settings list [--section <id>]`: keys and values. Secrets have no value.
- `talkweaver settings get <key>`.
- `talkweaver settings set <key> <value>`: refuses secrets and invalid values.
- `talkweaver settings reset <key>`, `--section <id>` or `--all --yes`.
- `talkweaver settings rebind <command> <shortcut>`: shortcut like `cmd+shift+l`, or `none`.
- `talkweaver settings reset-shortcut <command>` or `--all --yes`.
- `talkweaver settings changes [--limit <n>]`: the changelog, newest first.
- `talkweaver settings export <file>`: writes the settings to a file.
- `talkweaver settings import <file> [--yes]`: reads a settings file; skips settings that name something to run or somewhere to send data.
- `talkweaver settings undo-import --last` or `<batch>`: undoes an import.

## agent

The skill's own state, from the same module as Settings, recorded in the same changelog.

- `talkweaver agent status [--agent <id>] --json`: agents found on this computer, whether the skill is installed for each, its version, and why a copy was kept.
- `talkweaver agent install --agent <id>`: installs the skill (and this command) for the agents named, only. Without `--agent` it is a usage error.
- `talkweaver agent remove --agent <id>`: removes the skill where the app installed it and it is unedited.
- Agent ids: `claude-code`, `codex`, `gemini-cli`, `antigravity`, `t3-code`.
- A link, a folder the app did not make, an edited copy and a newer copy are kept. There is no force flag; Replace is in Settings.
