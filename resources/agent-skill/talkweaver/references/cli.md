# TalkWeaver command line

Run `talkweaver <command>`. The fallback is the app binary with the same arguments. Every verb takes `--json`.

For setup, settings and agent, exit 0 means done, 1 means the action stopped or the feature needs setup, and 2 means a usage error. Publish has its own result codes below.

The complete verb list with arguments is generated: [commands](commands.md). This page says when to use each verb.

## publish

- Publish only when the owner asks. Use the requested Talk and check that its configured Pages site is the intended destination. The command uses TalkWeaver's stored credentials. It accepts a talk path or id and the documented switches.
- `talkweaver publish <talk path or id> --dry-run` builds and checks against the configured site, reports staged files and bytes and surfaces any problems. It sends no upload or deployment and records no publish attempt. It uses the recorded live-service address without updating the service.
- `talkweaver publish <talk path or id>` publishes the Talk handout through the same operation as the editor's Publish handout. Pass the outline path, a talk folder path or a unique talk id (the outline filename without `-outline.md`) in an open library. Use the full outline path when ids collide.
- On Mac and Unix, publish and dry-run use the running app through a connection local to the OS user running TalkWeaver. They use the saved outline and warn if it differs from the open editor. Save any intended edits in TalkWeaver before publishing. Both commands run headlessly when the app is closed.
- On Windows, publish and dry-run require TalkWeaver to be closed. With the app open, they exit `4` with the next step “Close TalkWeaver and retry.”
- `talkweaver publish <talk path or id> --status` reads this computer's recent attempts for the talk, including the failure step, Cloudflare codes, timings and whether the outcome is known. It works while the app is open and makes no network request.
- `--json` writes one JSON object per line to stdout. Every object has `format: "talkweaver-publish/1"` and `event: "progress"`, `"warning"` or `"result"`. Read the final result for `outcome`, the `url` of a published or unchanged handout, or `reason`, `liveSite`, `nextStep` and any `diagnostic` for a failure. Status returns `attempts`.
- Exit codes: `0` published, unchanged, dry-run complete or status read. `1` failed with the live site untouched. `2` usage error, including an unknown or ambiguous talk id. The CLI lists matching outlines or up to ten suggestions in the terminal or in `candidates` with `--json`. `3` outcome unknown. `4` setup or a compatible running app required. `130` cancelled before deployment.
- For exit `3`, check the intended live page and report the uncertainty. Read the history before another attempt. For setup or sign-in, use the returned next step in TalkWeaver. Ctrl+C cancels while cancellation is available. After the deployment request starts, wait for confirmation.

## setup

Publishing, live service, recording storage, transcription. Quit TalkWeaver first: every `setup` verb refuses while the app is open and changes nothing. Procedure and states: [set-up procedure](talkweaver-setup.md).

- `talkweaver setup status --json`: reads every row; start here. `secondMac` lists what this Mac lacks of the set-up kept per Mac (set-up folder, token, site, live key, share-link address, transcription, word-timing models, agent skill).
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
- `talkweaver settings set <key> <value>`: refuses secrets and invalid values. `talkDefaults.typeface` is an alias of `talkDefaults.font` (stored as `font`).
- The setting `setup.folder` (with `settings set` and `settings get`): the set-up folder this Mac shares its preferences, shortcuts and Cloudflare site through (a `TalkWeaver set-up` folder is made inside it). The first time another Mac's set-up is there, the owner reviews and applies it in Settings › Set-up folder; `setup status` says whether that is still to do. After that, a change of the Cloudflare account, site or branch made on another Mac is offered there (Use on this Mac), never applied by a read. Only text that cannot hold a path, an address or a token travels: plain text (letters, digits, spaces and . , ' ’ - – — ( ) & ! +, at most 200 characters), web addresses written in full (http or https, no user name, query or fragment) and names by their own pattern. Any other value stays on its Mac, and Settings › Set-up folder names it with why. The closing slide's call to action and the credits do not travel.
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
