# resources/agent-setup

What TalkWeaver ships for an agent that sets it up on a person's computer. It is for agents and for
people following an agent's steps.
This folder is inside the installed app and in the repository, so set-up never depends on a file
elsewhere on the computer.

| File | What it is | Read it when |
|---|---|---|
| `cloudflare.md` | The procedure: check status, have the person put the token in (never in chat), create the site, set up going live, check again; exit codes; what to do for each state | Setting up publishing, going live, the share-link address or recording storage |
| `setup-command.md` | Reference for `TalkWeaver setup`: every command, its input, exit codes, the `--json` output and every state | You need an exact command, flag or field |
| `transcription/SETUP.md` | Steps to make a Python environment and fetch the speech model for optional transcription | The person wants transcripts of recordings |
| `transcription/parakeet_to_srt.py` | The transcription script TalkWeaver runs (vendored; its origin is in `PROVENANCE.md`) | Do not edit or copy it; point TalkWeaver at this path |
| `transcription/requirements.txt` | The Python packages that script needs | Step 3 of `transcription/SETUP.md` |
| `transcription/PROVENANCE.md` | Where the script came from | Checking what ships |

## Rules for any agent using these files

- Check first with `TalkWeaver setup status --json`; do only what the states call for.
- **Never ask for a token or a key in chat, and never put one in an argument.** The person pastes
  it into Settings, or into the command's prompt in their own terminal.
- Everything the Settings → Cloudflare, Recording storage and Transcription screens do, the
  `setup` command does with the same functions. Use whichever the person prefers; the other shows
  the same result.
- Transcription is optional. Nothing else in TalkWeaver needs it.

`cloudflare.md` is copied verbatim into the public `talkweaver` skill as
`references/talkweaver-setup.md` when the skill is published, so it avoids links that would break
outside this repository.
