# `TalkWeaver setup`: the set-up command

Reference for agents. The step-by-step guide (what to ask the person, in what order) is a separate document; this file fixes the commands, inputs, exit codes and the `--json` output.

The command does what Settings → Cloudflare, Recording storage and Transcription do, through the same functions, with no window.

**Quit TalkWeaver first.** While TalkWeaver is open (on the same user-data folder), every `setup` command refuses: it prints `TalkWeaver is open. Quit it and run this again, or use Settings → Cloudflare.`, exits 1, reads nothing from standard input and changes nothing. Under `--json` standard output is `{ "format": "talkweaver-setup/1", "command": null, "ready": false, "state": "app-open", "error": "TalkWeaver is open. …" }`. Ask the person to quit TalkWeaver, or to make the change in Settings → Cloudflare themselves. A TalkWeaver started while a command runs quits at once; start it again when the command has finished.

## Where the executable is

- macOS: `/Applications/TalkWeaver.app/Contents/MacOS/TalkWeaver`
- Windows: `TalkWeaver.exe` in the install folder (by default `%LOCALAPPDATA%\Programs\TalkWeaver\TalkWeaver.exe`). It is a windowed program: capture its output (pipe or redirect it), or `cmd.exe` does not wait for it. Not yet tried on Windows.

## Commands

| Command | Does | Exit 0 when |
|---|---|---|
| `setup status [--json]` | Checks every row (reads only) and prints it | Connected, Publishing handouts Ready, Going live and sharing Ready |
| `setup cloudflare connect` | Reads the token from standard input, saves it to the operating system's secure storage, checks it | Connected to one account |
| `setup cloudflare account <id>` | Chooses the account when the token sees several | Connected |
| `setup cloudflare create-site [name]` | Sets the site name (default `talkweaver-handouts`) and creates the Pages site if it is not there | Publishing handouts Ready |
| `setup cloudflare live` | Sets up or updates the live service; prints progress lines, then the state | Going live and sharing Ready |
| `setup cloudflare share-domain <host>` | Sets the share-link address; when the live service is set up, updates it so the address is attached | Share-link domain Attached |
| `setup cloudflare share-domain --clear` | Removes the address (and from the live service, when it is set up) | Share-link domain None |
| `setup cloudflare disconnect` | Removes the token; the deployed live service is left alone | Not connected |
| `setup recording --endpoint <url> --bucket <name>` | Sets recording storage; access keys from standard input; checks the bucket | Recording storage Ready |
| `setup transcription --python <path> --script <path> [--ffmpeg <path>]` | Sets the transcription paths and checks them | Transcription Ready |
| `setup help` | Prints the list | always |

Every command takes `--json`. Exit codes: **0** ready, **1** not ready (the state is printed, and `error` says why when a step failed; or TalkWeaver is open, state `app-open`), **2** usage error (nothing was done).

`setup` must come first, straight after the executable. Any switch for TalkWeaver itself goes after the command: `TalkWeaver setup status --json --user-data-dir=/path/to/folder`. A launch with anything else in that first position (a switch, a file to open) is an ordinary launch of the app.

## Every argument has a fixed format

Each argument is checked exactly as typed (nothing is trimmed). Anything else is a usage error (exit 2), and the value is never printed back.

| Argument | Format |
|---|---|
| account `<id>` | the 32 characters `0-9`, `a-f` the Cloudflare dashboard shows |
| site `[name]` | lowercase letters, digits and hyphens, not at either end, at most 58 characters |
| share-domain `<host>` | a bare hostname such as `drafts.example.com`: no scheme, port, path, wildcard, IP address or `localhost` |
| `--endpoint` | exactly `https://<account id>.r2.cloudflarestorage.com`, or with `eu.` or `fedramp.` before `r2.`; no path, query or trailing `/` |
| `--bucket` | 3 to 63 lowercase letters, digits and hyphens, not at either end |
| `--python`, `--script`, `--ffmpeg` | a full path (`/Users/…`, `C:\…`): no relative path, no `~`, no URL, no network share |

`--ffmpeg` left out keeps the current setting; `--ffmpeg ""` clears it (the ffmpeg that ships with TalkWeaver is used).

## Secrets: standard input only

- Never put a token or a key in an argument. A flag such as `--token`, or any argument outside its format, is refused with exit 2 and nothing is done. Treat a value refused this way as exposed and replace it.
- `cloudflare connect`: the token alone, on one line.
- `recording`: the access key id and the secret access key on two lines, or `{"accessKeyId": "…", "secretAccessKey": "…"}`. Only input that is empty (nothing at all before its end, or Return alone at the first prompt in a terminal) keeps the keys already saved. Blank lines, input over 64 KiB, input that could not be read, or a stream that closed early are a usage error (exit 2) and change nothing.
- Every part of `recording` (endpoint, bucket, keys) is checked before anything is saved: a usage error changes nothing.
- In a terminal the command asks for the value and does not show what is typed. A terminal that cannot hide what is typed is not read: the command exits 2 and says how to pipe the value in instead. Ctrl-C exits 2 and changes nothing. When the person pastes the token there, the agent never sees it. Never ask the person to paste a token into chat.
- Nothing the command prints holds a secret: no token, no key, no text of a Cloudflare reply.

## `--json` output

Standard output is one JSON document. Under `--json`, progress lines go to standard error.

```json
{
  "format": "talkweaver-setup/1",
  "command": "status",
  "ready": true,
  "error": null,
  "cloudflare": {
    "connection": {
      "state": "connected",
      "label": "Connected · Ada Lovelace",
      "account": { "id": "…", "name": "Ada Lovelace" },
      "accounts": [],
      "lastCheckedAt": "2026-10-10T09:14:00.000Z",
      "ready": true
    },
    "notice": null,
    "details": "Site: found. The permission to publish is proven by the first publish."
  },
  "rows": {
    "publishing":    { "state": "ready", "label": "Ready", "detail": "Site talkweaver-handouts · Custom domain: none", "ready": true, "project": "talkweaver-handouts", "permission": null, "customDomain": "none", "stale": false },
    "goingLive":     { "state": "ready", "label": "Ready", "detail": "Live sessions run on your Cloudflare account", "ready": true, "address": "https://…", "build": "…", "appBuild": "…", "updateDue": false, "permission": null, "reason": null, "details": "…" },
    "shareLink":     { "state": "none", "label": "None", "detail": "No address set in Settings", "ready": false, "host": "", "permission": null, "stale": false },
    "recording":     { "state": "not-set-up", "label": "Not set up", "detail": "…", "ready": false, "bucket": "", "missing": ["endpoint", "bucket", "keys"], "notice": null },
    "transcription": { "state": "not-set-up", "label": "Not set up — optional", "detail": "…", "ready": false, "pythonVersion": null, "ffmpeg": null },
    "importer":      { "state": "not-available", "label": "Not available", "detail": "Pictures of the original slides come from the separate TalkWeaver PPT Extractor app. …", "ready": false, "available": true, "url": "https://talkweaver.app/tools/ppt-extractor" }
  }
}
```

A usage error (exit 2) under `--json` prints `{ "format": "talkweaver-setup/1", "command": <name or null>, "ready": false, "error": "…", "usage": true }`.

Every row has `state`, `label` (the words at the row's right-hand edge in Settings, or `null` when the window shows nothing there), `detail` (the row's line of detail) and `ready`. `format` changes only when a field is removed or changes meaning; fields may be added.

### States

| Field | States |
|---|---|
| `cloudflare.connection.state` | `no-token`, `checking`, `connected`, `choose-account` (see `accounts`), `rejected`, `unreachable`, `storage-unavailable` |
| `rows.publishing.state` | `unknown`, `ready`, `no-permission` (see `permission`), `no-site`, `creating` |
| `rows.goingLive.state` | `unknown`, `not-set-up`, `setting-up`, `ready`, `updating`, `no-permission`, `failed` (see `reason`), `set-up-elsewhere` (the account has a live service and this computer has not been added to it; `updatesFirst` says whether adding it updates the live service first), `access-removed` (the live service refuses this computer's key). `otherComputers`: how many other computers it lists, or null |
| `rows.shareLink.state` | `unknown`, `none`, `attached`, `not-on-account`, `no-permission`, `not-attached` |
| `rows.recording.state` | `not-set-up` (see `missing`), `not-checked`, `ready`, `bucket-not-found`, `keys-rejected` |
| `rows.transcription.state` | `not-set-up`, `python-not-set`, `python-not-found`, `script-not-set`, `script-not-found`, `ffmpeg-not-found`, `ready`, `unknown` |
| `rows.importer.state` | `ready`, `not-available` (slide pictures come from the separate PPT Extractor app; text, notes and media still import), `unknown` |

`stale: true` means Cloudflare did not answer this time and the row is the last known state. Recording storage and transcription are optional: `setup status` exits 0 without them.
