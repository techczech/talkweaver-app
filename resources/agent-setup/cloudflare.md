# Set up Cloudflare for TalkWeaver (agent procedure)

For an agent setting up TalkWeaver's Cloudflare features on a person's computer. This file is
self-contained: it can be copied into a skill as it is. The full command reference (every command,
the `--json` fields, every state) is `setup-command.md`, beside this file in TalkWeaver's
`resources/agent-setup/` folder (the same folder is inside the installed app).

## The one rule

**Never ask the person for the Cloudflare token in chat, and never put it in a command line.**
The token goes from the person's clipboard into TalkWeaver by one of two routes, and you do not
see it either way:

1. The person pastes it into **Settings → Cloudflare → Cloudflare API token** and presses **Save
   token**. (Simplest. Use this unless they ask to stay in a terminal.)
2. The person runs `<TalkWeaver> setup cloudflare connect` **in their own terminal** and pastes at
   the prompt. The prompt does not show what is typed. The command also reads the token from
   standard input, so `<their password-manager command> | <TalkWeaver> setup cloudflare connect`
   works when they have the token in a manager.

If the person pastes a token into chat anyway, do not use it, do not repeat it, and tell them to
delete that token in Cloudflare (My Profile → API Tokens) and make a new one. The command refuses
an argument that looks like a token or key (exit code 2, nothing done) and says to treat the value
as exposed.

## What to run

`<TalkWeaver>` is the program:

- macOS: `/Applications/TalkWeaver.app/Contents/MacOS/TalkWeaver`
- Windows: `%LOCALAPPDATA%\Programs\TalkWeaver\TalkWeaver.exe` by default, or `TalkWeaver.exe` in
  the folder the person installed it to. It is a windowed program: capture its output (pipe or
  redirect it) or `cmd.exe` will not wait for it.

The command opens no window. Quit TalkWeaver first. While TalkWeaver is open, every setup command
stops at once with exit 1 and state `app-open`, and changes nothing. Add `--json` to any command to
get one JSON document on standard output (progress lines then go to standard error).

**Exit codes:** `0` ready, `1` not ready or TalkWeaver is open (state `app-open`) (the state is
printed, and `error` says why when a step failed), `2` usage error (nothing was done).

## Procedure

1. **Look first.** Run `<TalkWeaver> setup status --json`. Read `cloudflare.connection.state` and
   the `rows`. Do only the steps the states call for. Exit 0 means connected, Publishing handouts
   Ready and Going live and sharing Ready; recording and transcription are optional and do not
   change it.
2. **Connect** (`connection.state` is `no-token`, `rejected`, or the person wants another
   account). Tell the person what token to make, in plain words:
   - In the Cloudflare dashboard: My Profile → API Tokens → Create Token → Create Custom Token.
   - Permissions: `Account · Cloudflare Pages · Edit` (publishing handouts),
     `Account · Workers Scripts · Edit` (going live and sharing), and, only if they want their own
     address on share links, `Zone · Workers Routes · Edit` for that domain's zone.
   - Account Resources: the account TalkWeaver should use.
   - Create it, copy it (Cloudflare shows it once), then paste it by route 1 or 2 above.

   Then run `setup status --json` again. A saved token shows `connected`.
3. **Choose an account** if `connection.state` is `choose-account`: show the person the names in
   `connection.accounts`, and run `<TalkWeaver> setup cloudflare account <id>` for the one they
   pick.
4. **Create the site** if `rows.publishing.state` is `no-site`:
   `<TalkWeaver> setup cloudflare create-site` (or `create-site <name>` for a name other than
   `talkweaver-handouts`). Say the name first. It makes the Cloudflare Pages site in their
   account. Exit 0 means Publishing handouts is Ready.
5. **Set up going live** if `rows.goingLive.state` is `not-set-up` (or `failed`, after fixing the
   reason): `<TalkWeaver> setup cloudflare live`. It uploads the live service to the person's
   account and sets its keys, printing progress lines. Exit 0 means Going live and sharing is
   Ready.
6. **The share-link address** (optional, only if asked): `<TalkWeaver> setup cloudflare
   share-domain drafts.example.com` (a bare hostname, no `https://`). The domain must be a zone on
   the person's Cloudflare account. `setup cloudflare share-domain --clear` removes it.
7. **Recording storage** (optional): the person needs a Cloudflare R2 bucket and an R2 access key
   pair (R2 → Manage API tokens → Create API token, Object Read & Write). Run
   `<TalkWeaver> setup recording --endpoint https://<account id>.r2.cloudflarestorage.com --bucket
   <name>` **in the person's terminal** so they paste the access key id and the secret access key
   (two lines) at the prompt, or the person enters them in Settings → Recording storage. Never ask
   for the keys in chat; never put them in arguments.
8. **Check again.** Run `setup status --json` and tell the person, in the window's own words (each
   row's `label`), where they stand. Transcription is a separate, optional set-up: see
   `transcription/SETUP.md` in the same folder.
9. **Finish.** Tell the person that publishing a handout from a talk, and Go live, now work, and
   that Settings → Cloudflare shows the same rows. Whether the token may publish is proven only by
   the first real publish; if that is refused, Publishing handouts turns to "The token cannot
   publish pages" and the token needs `Account · Cloudflare Pages · Edit`.

To remove the token: `<TalkWeaver> setup cloudflare disconnect`. The deployed live service is left
alone.

## If something is not ready

| State (in `--json`) | Window says | Do |
|---|---|---|
| `app-open` | TalkWeaver is open | Ask the person to quit TalkWeaver, or to make the change in Settings → Cloudflare |
| `connection.state` = `no-token` | Not connected | Step 2 |
| `checking` | Checking… | Wait a few seconds and check again |
| `choose-account` | Choose an account | Step 3 |
| `rejected` | Cloudflare did not accept this token | The token is wrong, expired or deleted. Make a new one, step 2 |
| `unreachable` | Could not check (offline?) | The computer is offline or Cloudflare did not answer. Check the connection and run status again; rows are the last known (`stale: true`) |
| `storage-unavailable` | This computer's secure storage is unavailable, so the token cannot be saved | The operating system would not keep the secret; TalkWeaver will not save it in a plain file. Ask the person to restart TalkWeaver signed in to their normal user account. Do not work around it |
| `publishing.state` = `no-site` | No site yet | Step 4 |
| `publishing.state` = `no-permission` | The token cannot publish pages | New token with `Account · Cloudflare Pages · Edit` (step 2) |
| `goingLive.state` = `not-set-up` | Set up going live | Step 5 |
| `goingLive.state` = `no-permission` | The token cannot run the live service | New token with `Account · Workers Scripts · Edit` (step 2), then step 5 |
| `goingLive.state` = `failed` | Set-up failed | Read `reason`, fix it, run step 5 again |
| `goingLive.state` = `set-up-elsewhere` | Set up on another computer | Step 5: it adds this computer with a key of its own. Nothing made on the other computer changes |
| `goingLive.state` = `access-removed` | This computer's access was removed | Ask the person whether this computer should go live again; if so, step 5 |
| `shareLink.state` = `not-on-account` | This domain is not on this Cloudflare account | Add the domain to Cloudflare as a zone, or correct the hostname |
| `shareLink.state` = `no-permission` | The token cannot attach a domain | New token that also has `Zone · Workers Routes · Edit` for that zone |
| `shareLink.state` = `not-attached` | Not attached yet | Run step 5 again (`setup cloudflare live` attaches the address) |
| `recording.state` = `not-set-up` | Not set up | `missing` lists `endpoint`, `bucket` and/or `keys`; step 7 |
| `recording.state` = `bucket-not-found` | Bucket not found | Correct the bucket name or the endpoint |
| `recording.state` = `keys-rejected` | Keys rejected | The person makes new R2 keys; step 7 |
| exit code 2 | (usage error) | Read `error`; nothing was done. If it says an argument looks like a token or key, treat that value as exposed |

Never print, log or summarise a token, a key or the text of a Cloudflare reply. Nothing the command
prints holds one; do not add your own.
