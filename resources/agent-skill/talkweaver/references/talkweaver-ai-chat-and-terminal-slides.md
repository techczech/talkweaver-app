# AI chat and terminal simulation slides

Four layouts that draw a fake chat window or terminal from authored text. Ship in TalkWeaver 0.38.1; absent from 0.38.0 and earlier (an older app shows the fence as a plain code block). Typing, `stream=on`, Current-pane clicks and scrolling need 0.38.1-preview.3 or later; preview.1-2 lack them (`stream=on` is an unknown option there). No model is called; the slide is text only.

## Choose the layout

| Purpose | Tag | Fence |
|---|---|---|
| Chat as the user sees it; model internals as click-to-open rows inside the conversation | `{chat}` | `chat` |
| Chat plus a "Behind the scenes" side panel (reasoning, context, tool call, results as cards beside the chat) | `{chat-lanes}` | `chat` |
| Plain shell session (commands and output) | `{terminal}` | `terminal` |
| Coding-agent command line (prompt, thinking, tool calls, answer) | `{terminal-agent}` | `terminal` |

- Source is a ChatGPT/Claude-style web transcript: `{chat}`; add `{chat-lanes}` when the point is what happens behind the answer.
- Source is a Claude Code / agent CLI session: `{terminal-agent}`.
- Source is commands and output only: `{terminal}`.
- The tag picks the parser. Untagged `chat` fence infers `chat`; untagged `terminal` fence infers `terminal`. Always write the tag anyway.
- `chat` fence with `{terminal-agent}`, or `terminal` fence with `{chat}`/`{chat-lanes}`: accepted, labelled turns, no warning. `chat` fence with `{terminal}`: read as shell lines, hint `sim-fence-tag-mismatch`.

## Slide shape

````markdown
### Slide title
{chat-lanes model="Example model"}

```chat
user: ...
```
````

- Tag and options sit on the Trigger line (or the heading), as `key=value` tokens inside one pair of braces; quote values with spaces.
- One simulation fence per slide. A second one is ignored (`sim-extra-fence`). Split into more slides.
- Slide title is not painted. In `chat` and `chat-lanes` it becomes the highlighted "Recent" entry in the sidebar, so write it like a chat title ("Refund policy"). The other sidebar entries, placeholder, panel title and status line are fixed; authors cannot change them.
- No inline Markdown, links or images inside turns. All text is literal and escaped.
- Slide furniture (kicker, progress, section corner) is not drawn; the layouts are full-bleed.

## Options

| Option | Values (default first) | Applies to | Effect |
|---|---|---|---|
| `reveal` | `all`, `steps` | all four | `steps` = one press per part (see Step reveal). `{reveal}` and `{mode=reveal}` mean the same; `{mode=focus}` is treated as reveal |
| `sidebar` | `on`, `off` | chat, chat-lanes | `off` drops the history sidebar; column recentres. Always write `sidebar=off`; bare `{sidebar}` is the title-placement trigger, not this |
| `model` | text, default `Model` | chat, chat-lanes, terminal-agent | model-picker text; status-line text in `terminal-agent` |
| `open` | `none`, `all` | chat, chat-lanes, terminal-agent | start state of every disclosure. No per-part control |
| `window-title` | text; default `shell` / `agent-cli` | terminal, terminal-agent | title-bar text; in `terminal-agent` the header line after `◆ ` |
| `stream` | `off`, `on` | chat, chat-lanes | `on` = answer and reasoning text stream in as they come on screen (see Typing and streaming). Write `stream=on`; no bare form |
| `size` | `compact`, `large` | all four | `large` raises running text towards the deck type floor (chat text 28 px base, terminal 26 px, scaled with the window furniture); geometry stays; long content still scrolls |

- `stream` on `terminal`/`terminal-agent` is ignored (hint) and pointless: terminals always type.
- An option on a layout it does not apply to is ignored, hint `sim-option-ignored:<slide>:<key>`.
- Unknown value: the default applies (the trigger validator may also report `unresolved-trigger`). Use the values above exactly.
- Default `open=none` starts rows/results closed for the presenter to click. Use `open=all` or `reveal=steps` when the hidden parts must be visible without clicking.

## Labelled turns (`chat`, `chat-lanes`, `terminal-agent`)

Six labels, case-insensitive, at column 0, each followed by `:`. Nothing else is a label.

| Label | Body markdown |
|---|---|
| `user:` | question text. Continuation lines join with a space; a blank line starts a paragraph |
| `bot:` | answer, same rules |
| `model-reasoning:` | reasoning/thinking text, same rules. Duration: `model-reasoning (4s):` (`ms`, `s`, `min`; shown "4 s"; other text in the brackets shown verbatim) |
| `context-retrieval:` | one source per line below the label; leading `- ` stripped; text on the label line counts as the first source |
| `tool-call:` | first token = tool name, rest = arguments, verbatim, not validated as JSON. Arguments may start on the next line |
| `tool-results:` | lines verbatim, one result per line |

Exchange order: optional `user`, then any hidden parts (reasoning, context, tool call, results) in the order written, then optional `bot`. Hidden parts belong to the `bot` that follows.

- `user:` starts a new exchange. A part label or `bot:` after a `bot:` also starts a new one. Any number of exchanges per fence (multi-turn: just keep writing `user:` ... `bot:` pairs).
- `tool-results:` attaches to the nearest earlier `tool-call` in the same exchange that has no results yet. Several calls: put each `tool-results:` after its call.
- Missing `bot` or `user` is fine (conversation may stop mid-work). `tool-call` without results: arguments only, no results control. Duration on a label other than `model-reasoning` is ignored (hint).
- Indent continuation lines (two spaces) so a payload line cannot be read as a label; common leading indent is stripped. Lines like `Digital goods: x` or `note: x` are not labels and stay text.
- Blank lines at the very start or end of a tool payload are trimmed; internal blank lines, trailing spaces and the payload's own deeper indentation are kept.
- In `terminal-agent`, a user prompt and a reasoning turn render on one line (paragraph breaks are joined with spaces); answers keep paragraphs.

### Minimal `{chat}`

````markdown
### Refund policy
{chat model="Example model"}

```chat
user: What changed in our refund policy last month?
model-reasoning (4s): They want last month's changes. I should check the current refund policy and its change log before answering.
context-retrieval:
  Refund Policy v4.2 (September 2026)
  Policy change log, September 2026
tool-call: search_policy_docs {"topic": "refunds", "since": "2026-09-01"}
tool-results:
  Refund window cut from 30 to 14 days
  Digital goods: refundable only if unused
  Refunds over £200 need manager sign-off
bot: Last month the refund window shrank from 30 to 14 days, and digital goods are now refundable only if unused. Refunds over £200 also need manager sign-off.
```
````

Rows read "Thought for 4 s", "Searched 2 sources", "Used search_policy_docs"; each opens on click (all of them, independently). With `open=all` they start open.

### Minimal `{chat-lanes}`

Same fence as above; change the tag line to `{chat-lanes model="Example model"}`. Reasoning and context appear as always-open cards in the "Behind the scenes" panel; the tool-call card has a Show/Hide results control (the only click target; `open=all` shows results). Connectors link the question and answer to the panel.

### Two questions on one slide

Continue the same fence with a second exchange:

```chat
user: Does that apply to orders placed in August?
model-reasoning (2s): The change log should say when the new window took effect.
tool-call: get_change_log_entry {"policy": "refunds", "field": "effective_from"}
tool-results:
  effective_from: 2026-09-01
  Orders before this date keep 30 days
bot: No. Orders placed before 1 September keep the 30-day window.
```

### Minimal `{terminal-agent}`

````markdown
### Refund policy (agent)
{terminal-agent window-title="agent-cli · example-model · ~/policy" model="example-model"}

```terminal
user: What changed in our refund policy last month?
model-reasoning (4s): check the policy and its change log first
context-retrieval:
  Refund Policy v4.2 (September 2026)
  Policy change log, September 2026
tool-call: search_policy_docs {"topic": "refunds", "since": "2026-09-01"}
tool-results:
  Refund window cut from 30 to 14 days
  Digital goods: refundable only if unused
  Refunds over £200 need manager sign-off
bot: Last month the refund window shrank from 30 to 14 days, and digital goods are now refundable only if unused. Refunds over £200 also need manager sign-off.
```
````

Renders the prompt box, "Thinking for 4 s", "Read(2 documents)", the tool call as `name(args)`, results as `⎿` lines. Only the first result line shows; "… +N lines (click to expand)" opens the rest (a one-line result has no control). The status line shows `model` plus fixed "12% context used" decoration.

## Shell session (`terminal`)

- `$ cmd` is a typed command. `<path> $ cmd` (one token, no spaces) also sets the prompt path for this and later lines; before any path the prompt is `$`.
- A line that is only a prompt (`~/policy $`) is the cursor line.
- Every other line is output of the command above it, verbatim (whitespace kept; blank lines kept).
- A closing prompt with a block cursor is added automatically using the current path, unless the fence already ends with a prompt-only line.
- Output line that itself looks like a prompt or command (`$ 5 off`): escape with a leading backslash (`\$ 5 off`); the backslash is not shown.
- No labels, no ANSI colour parsing, no syntax highlighting.

````markdown
### A shell session
{terminal window-title="policy — shell"}

```terminal
~ $ cd policy
~/policy $ ls
change-log.md  refund-policy.md  shipping-policy.md
$ git log --oneline -3
a41c9e2 Cut refund window to 14 days
7d03b58 Digital goods: unused only
e90f1aa Add manager sign-off over £200
```
````

## Step reveal, size, long content

- `reveal=steps`: always-visible anchor, then one press per part. Stepping combines with typing: each press types the revealed part. Chat designs: the first user message is the anchor, then each part (reasoning, context, tool call), the answer, then per later exchange the question, parts, answer. `terminal-agent`: prompt is the anchor, then thinking, each context/tool block, answer. `terminal`: first command with its output is the anchor, then one press per later command. Hidden parts keep their space; nothing on screen moves; earlier parts are not dimmed. Five presses for the single-exchange examples; the next press leaves the slide. Stepping never opens a disclosure; clicking works at any step.
- Clicking a row or control never advances the slide. State resets to the authored `open` on each arrival.
- Rows, "Show results" and "+N lines" also open by clicking in the presenter's Current pane (preview.3+; before, only the audience/plain window took clicks). The click flips the same part on the live slide; the audience follows. Not while pointer, pen or highlighter is armed.
- Long content scrolls, never shrinks: the view is anchored to the latest turn/line, earlier content leaves at the top (chat designs fade it under the top bar), long lines wrap, no horizontal scroll. The presenter can also scroll it (wheel/trackpad over the conversation, in the Current pane or the presentation window; no scrollbar drawn). Scroll position is shared with the audience window. A manual scroll belongs to its step: the next step re-places the view so the newest part shows. `chat-lanes` has one scroll for chat and panel together. Print and handout are not scrollable and show the CSS anchor. Roughly 20 terminal lines (22 in `terminal-agent`) fit; no warning fires for overflow. Trim instead of relying on it, or split across slides.
- Print, PDF, handout and share pages show everything open with all steps visible; nothing is click-only.
- Text sizes are fixed (minimum 24 px at 1920 wide); these layouts are exempt from whole-slide autofit. Use `size=large` for a big room.
- Kind colours are fixed (user neutral/blue, answer teal, reasoning violet, context olive, tool call amber, results magenta) and do not follow palette or `{bg=}`.

## Typing and streaming

- Rate: 70 tokens/s at 4 characters a token = 280 characters/s. One fixed constant; no option sets it.
- `{terminal}`, `{terminal-agent}`: always type. Whole text of each part (command, output, prompt, thinking, tool block, answer) types when it comes on screen. No author switch-off. Off only by: `prefers-reduced-motion: reduce` (nothing types), Back/jump/arriving backwards (shown complete), print, handout, share pages.
- `{chat}`, `{chat-lanes}`: type only with `stream=on`, and only the answer text and the reasoning text. Question, context, tool call and results appear whole.
- Closed disclosure rows never type. In `{chat}` (default `open=none`) the reasoning sits in a closed row, so only the answer streams; use `open=all` to see reasoning stream. In `{chat-lanes}` reasoning cards are always open and stream; the tool-result control stays click-only. Opening a row later shows it whole.
- When: on a forward move only. Next onto the slide types what arrives with it (all parts under `reveal=all`; the anchor under `reveal=steps`). Next on a step types the part that step reveals. Parts arriving together type one after another in reading order; waiting parts are hidden, space kept, nothing moves.
- Next press while typing finishes the typing and does not step; the next press steps.
- Action row (`chat`) and "+N lines" (`terminal-agent`) appear after their part has typed.
- Combine freely with `reveal=steps` and `open`. Audience, plain presentation window and Current pane type the same characters (shared clock); a late joiner sees it finished.
- No blinking cursor.

### Minimal streaming

Demo-talk slide "Behind the scenes, streaming (arrive with next)": the `{chat-lanes}` example above with the tag line

```markdown
{chat-lanes model="Example model" stream=on}
```

Next onto the slide: reasoning and answer type in; the question, context and tool call appear whole.

### Minimal typing

No option. The `{terminal}` shell example above types as is; Next onto the slide types the whole session, one line after another.

## Warnings

All hints and warnings carry the slide id; they appear in the strip badge, Inspector and doctor (hints: Inspector and doctor only).

| Id | Level | Meaning and fix |
|---|---|---|
| `sim-no-fence` | warning | Layout tag but no `chat`/`terminal` fence. Add the fence under the tag line |
| `sim-empty` | warning | Fence empty; chrome only. Write the conversation or session |
| `sim-extra-fence` | warning | Second fence ignored. Move it to its own slide |
| `sim-text-before-label` | warning | Text before the first label is dropped. Start with a label or delete it |
| `sim-unknown-label:<word>` | warning | A line like `assistant:`, `thinking:`, `tool-result:`, `system:` is not a label; kept as text of the previous turn and names the nearest valid one. Rename it, or indent the line to keep it as text on purpose |
| `sim-results-without-call` | warning | `tool-results:` with no earlier `tool-call:` in the exchange; shown as a standalone result. Add the call before it |
| `sim-context-empty` | warning | `context-retrieval:` has no sources; left out. Add one source per line or remove the label |
| `sim-option-ignored:<key>` | hint | Option not valid for this layout, or a duration on a label other than `model-reasoning`. Remove it |
| `sim-fence-tag-mismatch` | hint | `chat` fence under `{terminal}`; read as shell lines. Use `{chat}`, `{chat-lanes}` or `{terminal-agent}` for labelled turns |

## Authoring rules

- Choose by purpose (table above), not by source app. Transcripts from any vendor map onto the six labels: human turn = `user:`, assistant text = `bot:`, thinking summary = `model-reasoning:`, retrieved documents/web results = `context-retrieval:`, function/tool invocation = `tool-call:`, its output = `tool-results:`.
- Keep payloads verbatim: tool names, argument JSON, result lines, shell output. Do not tidy JSON, reorder keys, fix typos or paraphrase the answer unless asked. Edits for length are cuts, not rewrites; mark a cut with a line such as `... (3 more matches)` inside the payload.
- Trim long tool results to the few lines that carry the point (the demo shows 3). The slide shows what the audience can read; do not paste a whole log.
- Do not invent turns. If the transcript has no reasoning or tool call, omit those labels; a plain two-turn chat is valid.
- Privacy before pasting: strip or replace API keys and tokens, emails, phone numbers, real names of private persons, personal paths (home directories and user names in file paths), internal hostnames/URLs and customer data. Use obvious stand-ins (`~/policy`, `user@example.com`, `sk-…`). Say in the report what was replaced.
- No real product names or logos appear in the chrome. The `model` text is free; use a generic name unless the talk needs the real one and the transcript is the speaker's own.
- Slide title = sidebar entry; keep it short and chat-like. Keep speaker notes out of the fence; use the outline's normal notes convention.
- Use existing slide IDs and block order rules from [outline and Pathway formats](content-formats.md); do not invent trigger words beyond the four tags and the options above.
- Verify only through an existing verified compiler/preview surface; if none, report the slide as source prepared, not visually checked.
