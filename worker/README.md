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

All sockets receive `{"type":"session.closed"}` before a normal close. `protocol.ts` reserves typed
poll, question, and reaction event names for later parcels; this Worker does not execute them.

## Local verification

```sh
bun test worker/*.test.ts
bunx tsc -p worker/tsconfig.json --noEmit
bunx wrangler deploy --config worker/wrangler.jsonc --dry-run
npm run test:live-worker:integration
npm run test:shared-talk-worker:integration
```
