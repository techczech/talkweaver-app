# TalkWeaver Live sessions Worker

This standalone Cloudflare Worker provides the Stage 1 Live-session channel. It does not contain
Electron, handout, poll, question, reaction, or bookmark wiring.

## Durable Objects

- `LiveSession` stores one session's lifecycle and latest `{slideId, reveal}` state in SQLite. It
  accepts hibernating presenter and audience WebSockets. Only an authenticated presenter can
  publish. An audience socket receives the latest state immediately when it joins and receives each
  later update.
- `SessionRegistry` stores the active session for each talk slug. `GET /session/<slug>` returns
  `{live:true,sessionId}` while the entry is active and `{live:false}` otherwise. SQLite records and
  alarms enforce the 12-hour TTL.

## Required secrets

Set both values with `wrangler secret put` or through the deployment environment. Never put their
values in `wrangler.jsonc`.

- `ADMIN_SECRET`: bearer secret required by `POST /sessions`. The later Electron deployment bridge
  will hold this credential.
- `SESSION_SIGNING_SECRET`: high-entropy HMAC key used to mint and verify presenter tokens.

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
```
