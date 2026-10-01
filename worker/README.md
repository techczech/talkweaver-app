# TalkWeaver Live sessions Worker

This standalone Cloudflare Worker provides the Live-session channel and the shared-talk (share for
comments) channel. It does not contain Electron wiring.

## Durable Objects

- `LiveSession` stores one session's lifecycle and latest `{slideId, reveal}` state in SQLite. It
  accepts hibernating presenter and audience WebSockets. Only an authenticated presenter can
  publish. An audience socket receives the latest state immediately when it joins and receives each
  later update.
- `SessionRegistry` stores the active session for each talk slug. `GET /session/<slug>` returns
  `{live:true,sessionId}` while the entry is active and `{live:false}` otherwise. SQLite records and
  alarms enforce the 12-hour TTL. It also maps each talk slug to its active shared talk (no TTL;
  the share removes its own entry when it is stopped or retired).
- `SharedTalk` stores one shared talk (share for comments): the handout HTML the owner last
  pushed (in 512K-character chunks), its per-slide source text and revision, and the colleague's
  items. It accepts hibernating owner and audience WebSockets. An alarm retires a share after 60
  days with no push, item or status change.
- `RunShare` and `RunPrework`: a Run's read-only share link and a planned Run's pre-work (below).

## Required secrets

Set both values with `wrangler secret put` or through the deployment environment. Never put their
values in `wrangler.jsonc`.

- `ADMIN_SECRET`: bearer secret required by `POST /sessions`. The later Electron deployment bridge
  will hold this credential.
- `SESSION_SIGNING_SECRET`: high-entropy HMAC key used to mint and verify presenter tokens and
  shared-talk owner tokens. The token's role keeps the two from standing in for each other.

Example secret setup, without literal values:

```sh
bunx wrangler secret put ADMIN_SECRET --config worker/wrangler.jsonc
bunx wrangler secret put SESSION_SIGNING_SECRET --config worker/wrangler.jsonc
```

## HTTP and WebSocket routes

- `POST /sessions` with `Authorization: Bearer <ADMIN_SECRET>` and `{"talkSlug":"my-talk"}` creates
  a session. The response contains `sessionId`, `presenterToken`, `shortId`, and `expiresAt`.
- `GET /session/<talk-slug>` discovers the active session.
- `GET /sessions/<session-id>/audience` with `Upgrade: websocket` opens the public audience channel.
- `GET /sessions/<session-id>/presenter?token=<presenter-token>` with `Upgrade: websocket` opens the
  presenter channel. A bearer token is also accepted.
- `POST /sessions/<session-id>/close` closes the session. It accepts the presenter token or admin
  bearer secret.

## Shared talk routes

`<id>` is the eight-character share id. The route grammar is exactly the routes below, parsed
once by `shared-talk-route.ts` for both the entry Worker and the object; any other path under
`/shares/` (an extra segment such as `/shares/<id>/talk/x`, a trailing slash) is `404 Route not
found` from the entry Worker and never reaches an object.

**Replay is by the share-wide `seq`, not by talk revision.** Every push, new item and status
change takes the next `seq`; every socket event carries it, and `?since=<seq>` on reconnect
replays what came after. `revision` counts only the owner's pushes.

- `POST /shares` with `Authorization: Bearer <ADMIN_SECRET>` and
  `{"talkSlug":"my-talk","title":"My talk"}` creates a share and registers it for the slug. The
  response is `201 {"shareId","ownerToken"}`. If the slug already has an active share, that share
  is stopped first (its sockets get `share.closed`), so a slug never has two live shares. If the
  new share cannot be registered it is discarded and the call fails with 503, so no share exists
  without an owner token having been handed out.
- `GET /shares/by-talk/<talk-slug>` with the admin bearer returns `{active:true,shareId}` or
  `{active:false}`. It is not public: a public lookup would hand out share links by slug.
- `PUT /shares/<id>/talk` with `Authorization: Bearer <ownerToken>` and
  `{"revision":n,"html":"…","slides":[{"slideId","title","text"}]}` replaces the shared talk.
  `revision` must be the previous revision + 1; otherwise `409 {"error":{"code":"revision_conflict"},"revision":current}`
  and the app pushes again from `current + 1`. Returns `{revision, seq}`.
- `GET /shares/<id>` serves the pushed handout HTML with the comments-runtime slot inserted
  before `</head>`: a `<script type="application/json" id="tw-shared-talk-config">` block holding
  `{shareId, revision, seq, api, audienceSocket}` and an empty
  `<script id="tw-shared-talk-runtime" data-slot="shared-talk-runtime">`. `seq` is the share's
  sequence when the page was served: the runtime's first `?since=`. Before the first push the page
  answers 404 with a short notice; after Stop sharing, 410.
- `GET /shares/<id>/talk.json` returns `{shareId, title, revision, updatedAt, slides}`.
- `POST /shares/<id>/items` records a colleague's item. It is idempotent on `itemId`: a repeat of
  the same item returns `200` with the stored item, a different item under a known id `409
  item_conflict`, a new item `201 {"item"}`. `name` is optional. Kinds:
  - `{"kind":"note","slideId","text"}`
  - `{"kind":"replace","slideId","baseRevision","text"}`
  - `{"kind":"delete","slideId","baseRevision","reason"?}`
  - `{"kind":"insert","afterSlideId":"<slide-id>|start","baseRevision","text","section"?}`

  Any other kind is `400 invalid_item_kind`. Text is capped at 20,000 characters (`item_too_large`)
  and `baseRevision` may not be later than the current revision. Items are refused until the first
  push. Each share holds at most 5,000 items and 8 MiB of item JSON (`429 share_full`), and takes
  new items at 30 per minute with bursts of 30 (`429 rate_limited` with `Retry-After`); repeats of
  a known item are free.
- `PATCH /shares/<id>/items/<itemId>` with the owner token and
  `{"status":"new"|"accepted"|"dismissed"|"done"}` sets an item's status and tells the audience.
  Any status may follow any other: `done` closes a note, `new` reverts (Undo).
- `GET /shares/<id>/audience[?since=<seq>]` with `Upgrade: websocket` opens the colleague's
  channel. It receives `talk.updated` and `item.status`; on connect it replays what came after
  `since` (the latest `talk.updated` once, and each changed status, in `seq` order).
- `GET /shares/<id>/owner[?since=<seq>]` with `Upgrade: websocket` and
  `Authorization: Bearer <ownerToken>` opens the owner channel. It receives `item.new` and replays
  every item after `since`. Prefer the header; `?token=<ownerToken>` is also accepted for clients
  that cannot set socket headers.
- `POST /shares/<id>/close` (Stop sharing) accepts the owner token. Addition to the spec: it also
  accepts the admin bearer, so the app can stop a share whose owner token it has lost. Both sockets
  receive `{"type":"share.closed","reason":"stopped"}` and every later request answers 410.

**Owner token.** It is long-lived: it carries no expiry and stays valid until the share is
stopped or retired. Treat it like a password. When it is passed as `?token=` on the owner socket
it travels in the URL and can land in proxy or access logs, which is why the bearer header is
preferred.

**Credentials are kept apart.** The audience routes (`GET` page, `talk.json`, `POST items`,
audience socket) refuse any request carrying an `Authorization` header or `token` parameter with
`400 credentials_not_allowed`, so neither the owner token nor the admin secret works on, or
travels through, the colleague's page. The owner routes accept the owner token only; the admin
bearer is not an owner credential except for close.

**Body limits.** The entry Worker checks the owner token on push and status patch first, so an
unauthenticated upload gets `401` without its body being read. It then reads the body and cuts it
off at the route's cap, whether or not Content-Length is sent: 64 KiB for an item, 1 KiB for a
status patch, 32 MiB for a push (`413 body_too_large`). Routes that take no body are forwarded
without one. The object keeps its own token check and cap.

**Accepted limit: anyone with the link can fill a share.** The colleague's page is anonymous by
design, with no per-client identity, so the limits are per share: 5,000 items, 8 MiB of item JSON,
and the new-item token bucket. Someone holding the link can use them up, after which the share
answers `429`. The recovery is to re-share: `POST /shares` for the slug stops the full share and
issues a new link.

**Lifecycle.**

- When a share closes, its closed state is saved and the retry alarm armed before the registry
  entry is removed, so an eviction in between leaves a closed share whose alarm finishes the job,
  never an open share with no registry entry. A failed removal is retried every minute.
- Stop sharing deletes the handout HTML at once and keeps slides and items for 7 days, so the
  owner app can still reconnect its owner socket, collect what it missed (`?since=`) and receive
  `share.closed`. After 7 days the alarm deletes everything: slides, items and metadata.
- A deleted share leaves a tombstone holding only its id, so its link keeps serving the "Sharing
  has stopped" page (410) and its API routes keep answering `410 share_closed`.
- Retirement (60 days with no push, item or status change) sends `share.closed` with
  `reason:"retired"` and deletes everything at once; items are already on the owner's disk.
- Only the share's metadata is held in memory; items, slides and HTML are read from storage per
  route, and replay reads items 200 at a time.

Shared-talk events:

```json
{"type":"talk.updated","revision":4,"seq":12}
{"type":"item.status","itemId":"k2-…","status":"accepted","at":1790000000000,"seq":13}
{"type":"item.new","item":{"itemId":"k2-…","kind":"note","slideId":"slide-3","text":"…","createdAt":1790000000000,"seq":11,"status":"new","statusSeq":11},"seq":11}
```

## Message protocol

The presenter sends:

```json
{"type":"slide.publish","slideId":"slide-3","reveal":2}
```

Audience sockets receive the current state on join and after every publish:

```json
{"type":"slide.state","slideId":"slide-3","reveal":2,"revision":1}
```

All sockets receive `{"type":"session.closed"}` before a normal close.

### Reactions and questions (ADR-0027)

Protocol-2 audience sockets only, through the acknowledged path; on protocol 1 they stay inert
(`invalid_or_inert_message`). Each message carries a `submissionId`; a retry with the same id gets
the original receipt and is never counted twice.

```json
{"type":"reaction.send","submissionId":"…","reaction":"puzzled","slideId":"slide-3","tMs":41000}
{"type":"reaction.send","submissionId":"…","reaction":"puzzled","slideId":"slide-3","tMs":45000,"withdrawn":true}
{"type":"question.submit","submissionId":"…","text":"Why?","name":"Priya","slideId":"slide-3","tMs":46000}
```

- `reaction` is `puzzled helped bookmark agree disagree yes no more slower` or `custom:<label>`
  (1–40 characters). One meaning reaction per participant per slide: a new one replaces the old; the
  bookmark counts independently. Question text is 1–500 characters, name at most 60, both trimmed
  and kept as text.
- **Reactions are applied in arrival order.** Whether a message adds, replaces or withdraws depends
  on what the participant already holds, so a client must send its offline queue first-in first-out
  over one socket, waiting for each ack before the next; two sockets sending at once can reorder a
  tap and its undo.
- Storage guards (not abuse policy): per participant 300 reaction submissions and 20 questions
  (`participant_limit_reached`); per session 4,000 reaction submissions and 400 questions, and the
  feedback row at most 1 MB serialised (`reaction_limit_reached` / `question_limit_reached`), and at
  most 600 stored receipts per participant (`participant_limit_reached`). Only submissions that change
  state are stored and count. A no-op (the reaction already held, a withdrawal of one not held) and a
  `reactions_paused` / `questions_paused` refusal store nothing, not even a receipt: a retry
  recomputes its answer, so a queued message refused during a pause lands when resent after the
  resume. Invalid submissions are refused with their reason and never stored.
- The sender receives only `reaction.ack` / `question.ack` (`status`, and `error` when rejected:
  `unknown_reaction`, `invalid_custom_label`, `missing_slide_id`, `question_too_long`,
  `reactions_paused`, `questions_paused`, `submission_id_conflict`, …).
- Presenter sockets receive `reaction.counts` (`slideId`, `counts`, and the `records` the reaction
  added) and `questions.state` (every question). No audience socket ever receives either.
- Presenter operations: `question.answer` (`questionId`, `answered`) and `switches.set`
  (`questionsAllowed`, `reactionsAllowed`). While reactions are paused, meaning reactions are refused
  and bookmarks are still accepted and stored, but no `reaction.counts` goes to presenters; the
  `switches.set` that turns reactions back on sends each slide's current counts, with the records
  made during the pause. A presenter that reconnects during a pause sees the current counts,
  including bookmarks made during the pause, in its `session.snapshot`. Every protocol-2 socket
  receives `switches.state`.
- `session.snapshot` carries `switches` for both roles, and for the presenter `reactionCounts`,
  `questions` and `reactionRecords` after `afterReactionSequence`. `GET …/recovery` returns the same
  presenter fields. The feedback state is stored in its own `kv` row, `feedback`.

### Feedback boards (ADR-0032, amendment 2026-09-30 point 1)

A board is a poll of type `board` (`build` `15-feedback-boards`; ticket 06 made it `16-run-boards`, ticket 05 `17-board-wording`, ticket 09 `18-run-prework`). Its `options` are the columns
and its `board` field carries the settings, which the parser fills with defaults:
`{instructions?, example?, hints?: {<columnId>: text}, limit: 24 (null = All), cardChars: 140,
cardsPerPhone: 5, names: false, closesAfterDays: 7}`. A board takes cards, never votes. Its
`poll.state` carries `board` (the settings) and `boardState`: the cards (oldest first), the numbered
groups, and the big-screen view the worker derives so every screen agrees
(`columns[].onScreen` in order — groups largest first, then singles newest first — and
`columns[].waiting`, the "+ n more on your phone"; `entries`, `shown`, `waiting`, `cardCount`,
`release`). Presenter sockets get every card, with `hidden`, `name`, `fromGroup` and `touched`;
audience sockets (phones and venue screens) get visible cards and groups only, with no field that
names or marks a participant.

Audience cards, protocol 2 only, idempotent by participant and `submissionId`:

```json
{"type":"card.add","submissionId":"…","pollId":"poll-…","column":"keep","text":"More hands-on","name":"Sam"}
{"type":"card.edit","submissionId":"…","pollId":"poll-…","cardId":"card-3","text":"More time for hands-on"}
{"type":"card.withdraw","submissionId":"…","pollId":"poll-…","cardId":"card-3"}
```

The sender (and its other tabs) gets `card.ack` (`status`, `cardId`, `error` when rejected:
`board_closed`, `board_frozen`, `unknown_column`, `empty_card`, `card_too_long`,
`card_limit_reached`, `card_not_found`, `card_sorted`, `participant_limit_reached`, `board_full`,
`submission_id_conflict`, `storage_failed`, `board_not_found`). Length counts characters as people
do (an emoji is one). Own cards only, and only until the presenter sorts them into a group; another
phone's card, a hidden card and a withdrawn card all answer `card_not_found`. A name is kept only
when the board takes names. Refusals store nothing, so a queued card refused while the board is
closed lands when resent after a reopen. `session.snapshot` for an audience socket carries
`myCards` (its own cards on every board, hidden and withdrawn ones left out) and `myBoards`
(`{pollId, cardsUsed, cardsPerPhone}` per board).

**A hidden card still counts towards its phone's cards** (hiding a card never grants another), but
it leaves the phone's `myCards` silently. So the phone is given `cardsUsed` — in `myBoards` and on
every confirmed `card.ack` — and closes its card box when `cardsUsed` reaches `cardsPerPhone`,
without ever being told that one of its cards was hidden. Withdrawing a card frees its place.

Presenter operations go through `operation` with an `operationId` (a resend repeats the ack):
`board.move` (`target`, `column`), `board.merge` (`source`, `target`), `board.split` (`group`),
`board.hide` (`target`, `hidden`), `board.freeze` (`frozen`), `board.release` (`mode`: `next` with
`count` (default 12), `all`, `groupsOnly` or `limit`; with `column` for one column's own menu:
`all`, `groupsOnly`, `limit`), `board.limit` (`limit`, null for All) and `board.relabel` (`group`, `text`: the group's own wording,
drawn in D13 as "Edit the group's wording"; text only, trimmed, at most the board's card length
(`card_too_long`), an empty text clears it). A group's wording travels as `label` on the group in both
views and every screen shows it in place of the group's first card's text; the cards keep their own
text, and the wording goes with the group's number (a split or a merge into another group retires both). A target is
`{"cardId":"card-3"}` or `{"group":4}`. Merging onto a card that is in a group joins that group;
merging a group into another retires its number; split retires the number; numbers are never
reused. A frozen board refuses move, merge, split and relabel; hide and put back still work (hiding is
moderation), as do release and limit. Hiding a group and putting the group back touch only the
group-level hide: a card hidden on its own before or after stays hidden until it is put back from its
own menu, which also shows a card hidden with its group. A card merged into a group takes that group's group-level hide:
into a hidden group it is hidden with it, into a shown group it is shown (its own hide is kept).

The big screen shows every group (a group counts once and never waits) and then the oldest singles
up to the limit; "Show next" adds only cards waiting at that moment, so the screen never shows more
than was released; "All" and a column's "every card" include cards still to come; "groups only"
on a column keeps its singles on phones without promoting another column's newest cards.

Two consequences of that model, kept as drawn (round 2's `released()`), for ticket 05's panel:
"Show next 12" while the board-wide "groups only" is on raises the allowance but shows nothing new
until "groups only" is turned off; and a column's own "groups only" or "every card" still wins while
the board-wide "Show all" is on ("Back to the limit" clears both).

Storage guards: 1,000 cards per board, 200 stored submissions per participant per board, and each
board's row at most 1 MB serialised (measured exactly on every submission), with 64 KB kept for the presenter's operations
(`board_full`, `participant_limit_reached`). Hidden cards still count towards a phone's cards;
withdrawn ones do not. Each board is stored in its own `kv` row, `board:<pollId>`; a board
whose row is missing on load is rebuilt empty from its definition's settings (its own limit).

### Boards left open after End live (feedback-boards ticket 06)

`POST /sessions/<id>/close` takes an optional body `{"keepBoardsOpen": true}`. Every board poll still
open at that moment keeps taking cards until `now + closesAfterDays` (the board's own setting, 1, 7 or
30 days); a board already closed stays closed. The response names them: `{"ok":true,"lateBoards":
{"<pollId>": <closesAt ms>}}` (empty without keepBoardsOpen, or with no open board). The session is
closed as before for the presenter and every connected socket (`session.closed`, so phones stop
following), but:

- the registry keeps the talk slug pointing at the session until the last kept board closes, so the
  join link still resolves;
- a protocol-2 audience socket may still join; it gets `session.hello` with `expiresAt` = the last
  board's close, and answers only `session.ping`, `session.sync` (a snapshot with `slideState: null`
  and only the boards left open) and `card.add` / `card.edit` / `card.withdraw` for a board still
  open (any other board answers `board_closed`); everything else is `protocol.error session_not_live`.
  A protocol-1 socket is refused;
- `GET …/recovery` (presenter token, checked as issued) adds `lateBoards` (the boards still open, with
  their close times) and `endedAt`; `GET …/status` adds `lateBoards` while one is open;
- `POST …/close` again ("Close it now") closes every board left open. It takes the admin secret or the
  presenter token checked as issued, so it works after the 12-hour live window;
- a new live session for the same talk slug takes the join link: before it registers, the entry
  Worker asks the talk's current session to close its boards left open (`/internal/supersede`, reachable
  only from inside the Worker), so no board claims to be open where no phone can reach it;
- recovery names each board left open that has closed since, with when and why:
  `closedBoards: {"<pollId>": {"at", "reason": "expired" | "closed" | "superseded"}}`;
- the alarm closes each board when its time comes (and every route closes a board whose time has
  passed before serving). Once none is left the remaining sockets get `session.closed`, the registry
  entry is removed and the alarm is cleared. Cards, groups and hidden flags stay for the recovery.

The rules are pure functions in `late-boards.ts`, unit-tested with a fake clock.

## A Run's read-only share link (feedback-boards ticket 06)

`RunShare` Durable Objects (migration `v3`) hold one read-only link each. The app keeps one link per
Run in its own registry; nothing is registered by talk here.

- `POST /results` with the admin bearer → `201 {"shareId","ownerToken"}`. The owner token has its own
  role (`results-owner`): a shared talk's owner token cannot stand in for it, nor the reverse.
- `PUT /results/<id>/content` with the owner token (checked by the entry Worker before the body is
  read; body capped at 1 MiB) replaces what the link shows: `{expiresAt, title, subtitle?, boards,
  polls}`. `expiresAt` is `null` ("until I stop it") or a time within the next 31 days. The push is
  rebuilt from a closed schema; a card, column, board or poll carrying `hidden`, `name` or
  `participant` is refused (`400`), and at least one board or poll is required.
- `GET /results/<id>` serves the page: plain HTML written from the push with every string escaped,
  no script, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; …`,
  `no-store`, `noindex`. It refuses any credential (`400 credentials_not_allowed`). An unknown id and
  a link not pushed yet answer the same 404, so a guessed id learns nothing.
- Every route takes exactly one method (`405` otherwise): the page is read-only.
- `POST /results/<id>/close` (Stop sharing) takes the owner token or the admin secret. The content is
  deleted at once and a tombstone keeps answering `410` ("stopped sharing").
- A link past its `expiresAt` answers `410` ("expired") and its content is deleted (by the alarm, or
  by the first request after it); a push cannot revive it.

## A planned Run's pre-work (feedback-boards ticket 09)

`RunPrework` Durable Objects (migration `v4`, binding `RUN_PREWORK`) hold one planned Run's pre-work
form and its anonymous answers. The app keeps one per Run in its own registry (with the owner token)
and puts the id in the Run's handout; nothing is registered by talk here. Build `18-run-prework`; ticket 11 made it `19-board-seed` (boards open with pre-work answers, below).

- `POST /prework` with the admin bearer → `201 {"preworkId","ownerToken"}`. The owner token has its
  own role (`prework-owner`); a shared talk's or a results link's owner token cannot stand in for it.
- `PUT /prework/<id>/form` (owner; body capped at 256 KiB) sets `{opensAt, closesAt, form}` (ms; it
  closes after it opens, at most 400 days ahead). The form is rebuilt from a closed schema
  (`worker/prework-protocol.ts`): steps `slide | check | question | task` with their poll or done
  setting. A `right` key anywhere in it is refused (`400 right_answer_not_allowed`): the quick check's
  right answer never leaves the app.
- `GET /prework/<id>` (public, no credential) → `{state: not_yet | open | closed, opensAt, closesAt,
  people?}` (`people` only once closed). `404` until the first push, the same as an unknown id.
- `POST /prework/<id>/submit` (public; 8 KiB) `{participantId, submissionId, stepId, kind, …}` with
  kind `read`, `answer` (`choice` or `text`, checked against the step's poll), `done` (a pre-task
  with Mark as done) or `question` (`text`, optional `name`; only where the step takes questions).
  Refused before it opens (`409 prework_not_open`) and after it closes (`410 prework_closed`).
  Idempotent by `submissionId` (the same body again → `200`, nothing stored; a different body →
  `409`). A read, an answer and a done mark are one entry per person and step (the latest wins);
  each question is its own entry. The device id is stored only as a hash.
- `POST /prework/<id>/mine` (public) `{participantId}` → that device's own entries.
- `GET /prework/<id>/results?after=<seq>` (owner) → entries changed after the sequence number, 500 a
  page, with `people`, `phase` and `lastActivityAt`; the app mirrors them onto the Run by entry id.
- `POST /prework/<id>/close` (owner or admin): closes now. Only this early close is sticky: a later
  push never reopens it. A form closed by its date is reopened by a push that moves the close date
  later (a rescheduled Run).
- Caps (`PREWORK_LIMITS`): 2 000 people, 400 changes and 20 questions per person, 8 MiB of entries;
  3 000 submissions a minute for the form and 60 for one person; per network source (the entry
  Worker passes `cf-connecting-ip`, hashed in the object; an IPv6 address counts by its /64) 300 a
  minute and 400 new participant ids an hour (a full theatre behind one venue address); over the
  form's life a source may bring up to the form's own 2 000 (`429 source_limit`).
  A submission without `cf-connecting-ip` is refused `503 source_unknown`, except on a local Worker
  started with `PREWORK_LOCAL_SOURCE=1` (the app's local Worker and the test harness), where it is one
  local source.
  A participant id counts toward the 2 000 only with its first accepted entry. All `429`s carry
  `retry-after`. An unexpected failure answers `503 prework_unavailable` (with `retry-after`), never 500.
- With no push and no accepted submission for 60 days after the later of its last activity and its
  close, the alarm deletes everything; the id then answers `410 prework_gone`.
  `PREWORK_IDLE_PURGE_MS` shortens this for local test Workers only.

## Local verification

```sh
bun test worker/*.test.ts
bunx tsc -p worker/tsconfig.json --noEmit
bunx wrangler deploy --config worker/wrangler.jsonc --dry-run
npm run test:live-worker:integration
npm run test:shared-talk-worker:integration
npm run test:run-boards-worker:integration
npm run test:prework-worker:integration
```

### A board that opens with pre-work answers (feedback-boards ticket 11)

A `poll.open` for a board may carry `seed: [{column, text}]`, the answers the Run page picked for the
slide a pre-work step feeds (`{results=<step id>}` on a board slide). The parser keeps it on a board only,
drops cards for unknown columns or without text, and cuts each text to the board's card length. The
session takes it once, when the board is first made (`seedBoard`): a board that already has cards, and a
reopened or replayed one, takes no second seed. Seeded cards are ordinary cards owned by no participant
(`seed:prework`), so no phone can edit or withdraw one; the seed is not kept on the stored poll and is
never sent back. The app builds it in `src/main/run-prework-seed.ts`.
