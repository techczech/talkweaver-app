// ═══ Share and Stop for one talk (ticket 12) — THE DESIGN. Written before the code; the code below
// and the modules it lists after this header implement it (slotFor, settle: shared-talk-slots.ts;
// shareOp, closeStep: shared-talk-steps.ts; reconcile: shared-talk-reconcile.ts; notes and row
// removal: shared-talk-bookkeeping.ts). Each module's first line points here. Cases 1–7 are the
// ticket's (docs/plans/cloudflare-setup-in-app/tickets/12-…).
//
// ── 1. States of one talk's share ───────────────────────────────────────────────────────────────
//   N  not shared   no row for the talk, nothing queued.
//   C  creating     a Share's create step holds the talk's queue. Two sub-states, because the code has
//                   an await (deps.endpoint()) before the POST and case 1 needs "never created":
//                   C0 POST not sent yet · C1 POST sent, reply awaited. Between them, synchronously:
//                   the registry file is checked against what the step saw (k1', round 2 finding 5)
//                   and the create is NOTED in shared-talk-pending-creates.json (finding 8) — the
//                   Worker makes the id and owner token itself (no client token, no idempotency key),
//                   so the note is the only trace of a share whose reply this run never registers.
//   R  registered   row + stored token exist; the Share that made it has not settled its first push
//                   (QR, share_url, first build+PUT still running). Also a revision-0 row after a
//                   failed Stop or a restart, with no push running.
//   L  live         row + token, no Share waiting on it. Revision may be 0 (a failed first push: the
//                   share stands, lastError says so).
//   A row marked `ended` (the owner socket found its share stopped, retired or refusing the token)
//   is GONE (round 3): never offered as a link by inspect, status, update, setOptions or [R*]; no
//   pushes; inspect and the next Share remove it by name ([j]) and the Share creates afresh. The
//   sheet's view never offers Copy for an ended share it was sent in a broadcast.
//   One predicate, offerable(row) in shared-talk-slots.ts (round 4): not ended, not closedRemotely,
//   not stopping, not closeUncertain. Every reply path (inspect, status, update, setOptions, [R*]
//   and the currentState/settle guards) offers a link only through it; a closeUncertain row that
//   cannot be verified first answers with SHARE_UNVERIFIED, never its link or "stopped".
//   S  stopping     a Stop's close step is running for the row; no push may start or land.
//   Two marks on a row (round 2): `closeUncertain` (R|L after a close that got no answer: the
//   share may be closed; persisted) and `closedRemotely` (closed on the service, the file could not
//   be written to remove the row: memory only, token forgotten, ended='stopped', no link).
//   Refinement forced by the code: "token stored" and "registry row written" are ONE synchronous step
//   (registryFile.write stores, reads back, writes the file), run in the same tick as the create
//   reply, so no other request can observe a state between them.
//
// ── 2. The talk slot, the queue and the stop generation ("last request wins") ────────────────────
//   Slot   one per talk while anything is shared or pending: { id, key, realPath, stopGen,
//          pending?: { gen, promise } (the Share in flight), lastStop?: Promise, madeUrls: Set }.
//          `id` is an opaque counter and never changes. slotFor(outlinePath) resolves the identity
//          NOW and matches a slot whose key === identity.key OR realPath === identity.realPath (the
//          same rule recordFor already uses for rows), then re-keys the slot to the current identity.
//          A replaced outline (new inode, same path: case 4) therefore finds its slot by realPath; a
//          moved folder (same inode, new path) finds it by key. Both at once while a Share is pending
//          is a different talk as far as the app can tell (same limit as recordFor today).
//   Queue  createKeyedQueue() from owner-tokens.ts, keyed by slot.id (NOT the identity key, which is
//          what 2af5f546 keyed on). It holds only two kinds of step, each bounded by a 15 s request:
//          create (assertCanStore, endpoint, POST, store+register) and close (POST close, remove
//          row by name). Never a build, a push, QR, share_url or a save timer. Creates for one talk
//          are therefore serial on the Worker (it closes a talkSlug's previous share on create).
//   stopGen Stop increments slot.stopGen synchronously when pressed. A Share op records gen =
//          stopGen when it starts; it is SUPERSEDED once stopGen !== gen. A Share pressed while
//          another is pending JOINS it (same promise) only if pending.gen === stopGen; otherwise
//          it is a new op queued behind whatever is ahead.
//   Cancellation is checked at exactly these points:
//     k1 create step, after endpoint() resolves, synchronously before the POST: superseded → no POST.
//     k1' same tick, after k1: the file still holds what the step saw for this talk (no row under
//        slot.key, the unusable rows' ids unchanged, no new row for the talk) → else SHARE_RACED,
//        no POST (something else registered the talk: the Worker would close its share). Then
//        the create note is written; a note that cannot be written → SHARE_NOT_NOTED, no POST.
//        (A second TalkWeaver on the same user-data folder cannot exist: index.ts holds Electron's
//        single-instance lock, round 3. The check stays against any other writer of the file.)
//     —  NOT after the create reply: the share exists, so it is always registered (token kept first,
//        ticket 02 rule); the queued close step then closes it.
//     k2 Share op after register, after QR, after the share_url write, after the first push: the
//        resolution rule [R*] below; a superseded op does nothing further (no stamp, no push).
//     k3 push: live(key, record) after readOutline, build and PUT (as now), plus readOutline and
//        build raced against the push's AbortSignal, so Stop's abort settles the chain at once.
//     k4 save timer / enqueue: stopping or no row → skip (as now).
//     k5 share_url: the decision is taken inside the outline transformation (section 4).
//   Stop never awaits the push chain (today's `await chains.get(key)` is case 3's hang).
//   [R*] A Share op resolves, after its last await: if not superseded and its record is the slot's
//        row and not stopping → its own link. Otherwise loop { await slot.lastStop (settled) } until
//        no Stop is running, then: its record is still the slot's row → its own link (the Stop
//        failed, the link is open); else → stopped { shareId of its own record, or null }. It never
//        returns another share's state (42d94e77's fault). Joined callers get the same result.
//   [R*'] Every other reply (inspect, update, setOptions, status) follows the same rule through
//        currentState(slot, record): read AFTER the last await; a running Stop is waited out; the
//        record no longer the slot's row (or closedRemotely) → stopped{id} (update, setOptions),
//        inspect → { share: null, stopped: { shareId } } (a newer row is inspected instead), status
//        → null. No reply or broadcast carries a record captured before an await (round 2, 1–2).
//   registryFile.write gets `expect: { [slot.key]: null, …unusable rows' ids }` on register as a
//   backstop; a refusal is handled like a failed store: this create's own share is closed with the
//   token in hand and the Share fails (SHARE_NOT_KEPT, or SHARE_NOT_KEPT_OPEN when the close fails).
//   Nothing else is touched (round 3: the rival-row clean-up is gone with the instance lock).
//
// ── 3. The table. Rows: events; columns: states. [x] = note below. "ignored" = cannot change state.
//   │ event              │ N               │ C               │ R               │ L               │ S               │
//   │ e1 Share pressed   │ new op →C0 [a]  │ join/queued [b] │ join/push [c]   │ own link [n]    │ queued [d]      │
//   │ e2 Stop pressed    │ queued [e]      │ gen+1, queued[f]│ gen+1, abort →S │ gen+1, abort →S │ gen+1, queued[e]│
//   │ e3 create ok       │ ignored         │ C1 → e5 now     │ ignored         │ ignored         │ ignored         │
//   │ e4 create fails    │ ignored         │ →N [g]          │ ignored         │ ignored         │ ignored         │
//   │ e4x no reply       │ ignored         │ →N, noted [o]   │ ignored         │ ignored         │ ignored         │
//   │ e5 token+row kept  │ ignored         │ →R, emit        │ ignored         │ ignored         │ ignored         │
//   │ e5x keep fails     │ ignored         │ close →N [h]    │ ignored         │ ignored         │ ignored         │
//   │ e6 1st push ok     │ ignored         │ ignored         │ →L [R*]         │ ignored         │ ignored [i]     │
//   │ e7 1st push fails  │ ignored         │ ignored         │ →L +error [R*]  │ ignored         │ ignored [i]     │
//   │ e8 1st push hangs  │ ignored         │ ignored         │ stay R, waits   │ ignored         │ ignored [i]     │
//   │ e9 close ok        │ ignored         │ ignored         │ ignored         │ ignored         │ →N [j]          │
//   │ e9x row not removed│ ignored         │ ignored         │ ignored         │ ignored         │ →L closed [p]   │
//   │ e10 close refused  │ ignored         │ ignored         │ ignored         │ ignored         │ →R|L [k]        │
//   │ e10x close no reply│ ignored         │ ignored         │ ignored         │ ignored         │ →R|L uncert [q] │
//   │ e11 file replaced  │ none (no slot)  │ re-key slot [l] │ re-key [l]      │ re-key [l]      │ re-key [l]      │
//   │ e12 share_url done │ ignored         │ ignored         │ k2 check        │ ignored         │ k2 check        │
//   │ e13 QR made        │ ignored         │ ignored         │ k2 check        │ k2 check        │ k2 check        │
//   │ e14 save hook      │ ignored         │ ignored [m]     │ queued (push)   │ queued (push)   │ ignored         │
//   │ e15 app quits      │ quits           │ waits ≤5 s [r]  │ quits           │ quits           │ quits           │
//   │ e16 start, a note  │ report [s]      │ —               │ ignored         │ ignored         │ —               │
//   [a] slot made or found; op gen = stopGen; create step queued. Caller: [R*], or failure.
//   [b] pending.gen === stopGen → same promise; else a new op, its create step behind the queue.
//   [c] same join rule; with no pending Share: share_url reconciled (round 2 finding 4: a Share that
//       resolves to an existing row is a change of what the line must say), a revision-0 row's
//       first push enqueued, [R*]. A Share that ends with a live row after skipping its reconcile
//       (superseded by a Stop that then failed) reconciles before it returns.
//   [d] new op (gen = the bumped stopGen); its create step runs after the close: close succeeded →
//       creates afresh (C); close failed → finds the row and returns that link (it is open).
//   [e] close step queued; at its turn it closes whatever row the slot holds, or none → Stop caller:
//       { serverClosed: true } (nothing to close) / the first Stop's outcome repeated by a retry.
//       With no row and a create note left for the talk (not one this run is sending): failure,
//       stopInterruptedMessage, the note kept — never "stopped" while a share may stand without its
//       token, and nothing can close it from here (no admin secret is sent on a stop). [s]
//   [f] C0: k1 skips the POST → N; the create's op resolves stopped{null}. C1: the reply registers
//       (e5), then this close step closes it (case 1). Stop caller waits ≤ one create + one close.
//   [g] Share caller: failure (create's own message); stopped{null} when superseded. The Worker
//       answers an error only when it made no share (or discarded it): the note is dropped.
//   [h] closeRemote with the token in hand (as now). Caller: SHARE_NOT_KEPT, or stopped{id} if
//       superseded; SHARE_NOT_KEPT_OPEN is always a failure (an orphan the person must hear of).
//   [i] the in-flight PUT is aborted; a reply that lands anyway fails live() and is never confirmed;
//       confirm()'s persist() writes only held rows, so a removed row is never recreated.
//   [j] row removed by name (fileKeysOf) — written to the FILE first, memory after (removeRow,
//       round 2 finding 7) —, token forgotten, attempts cleared, emit(null), then a
//       share_url reconcile (section 4) awaited outside the queue. Stop caller: { serverClosed,
//       message } (401/403 = stopped locally, as now). Superseded Share callers: stopped{id}.
//   [k] stopping cleared, lastError set, emit. Stop caller: failure. The aborted first push is not
//       rerun: the row is R/revision 0 until the next Share, save or Update. Share callers: [R*].
//   [l] slotFor re-keys the slot; recordFor re-keys the row with one previousKey event (as now);
//       the queue key (slot.id) is unchanged, so a Stop reaches the pending Share (case 4).
//   [m] the first push reads the outline (readOutline flushes the editor) after registering, so the
//       save is included; nothing is queued for a share that does not exist yet.
//   [n] closeUncertain → talk.json first (in the create step): closed → row removed, creates
//       afresh (C); open → mark cleared, own link; unknown → SHARE_UNVERIFIED. closedRemotely →
//       the removal is tried again, then creates afresh, or the Share fails with its message.
//       inspect and status do the same check in the slot's queue before they answer; unknown →
//       they fail with SHARE_UNVERIFIED (round 3), never the link.
//   [o] the POST got no answer (or a 201 the app cannot use): a share may exist without its token
//       here. The note stays; the next Share's create closes it on the Worker (same slug) and its
//       registration drops every note for the slug. Until then it is reported ([s]).
//   [p] the file could not be written: the row stays in memory closedRemotely (ended 'stopped',
//       no pushes, no link, no share_url line — reconcile treats it as no row), its token is
//       forgotten (a restart finds a row with no token: unusable, never live; the next Share
//       replaces it by name), and every later write removes it. Stop caller: failure,
//       recordNotRemovedMessage (closed, record not removed). A later Stop only retries the removal.
//   [q] the close was sent and no answer came: closeUncertain set and persisted, lastError, emit.
//       Stop caller: failure. Next Share / inspect: [n]. (bad-token: never sent → [k].)
//   [r] will-quit waits for create steps under way, at most 5 s (drainCreates), then quits; a create
//       still unanswered keeps its note.
//   [s] a note left by an earlier run (or a lost reply) is REPORTED, never closed from here: no
//       request is sent for it (no admin bearer, no admin close). At start, interruptedCreates()
//       lists the earlier run's notes (the app logs "a share for <title> may still be open on the
//       sharing service; it will be replaced the next time you share this talk"). The talk's sheet
//       gets the same sentence from inspect (`interruptedShare`, no row for the talk) and asks
//       before sharing (phase confirm-replace, "Share here"). The note stays until the talk is next
//       shared: that create closes the slug's previous share on the Worker (create replaces), and
//       its registration drops every note for the slug ([o]). A Stop with no row reports it ([e]).
//
// ── 4. share_url: one transformation (case 5) ───────────────────────────────────────────────────
//   reconcile(slot) = writeTalkOutline(path, (text) => decide(text), 'share-for-comments'), where
//   decide() reads the slot's state WHEN THE WRITER RUNS IT, not when it was enqueued:
//     row held and not stopping   → share_url = linkOf(row)            (replaces a foreign line too)
//     stopping                    → text unchanged (the close may fail)
//     no row                      → remove share_url only if its value ∈ slot.madeUrls; else unchanged
//   Enqueued after every change of the slot's row: register (in the Share op, if not superseded at
//   k2), a Share that resolved to an existing row, a Share that ends with a live row whose reconcile
//   was skipped, close success, a close whose record could not be removed (e9x), an uncertain row
//   found closed ([n]) and an ended row removed. A closedRemotely or ended row counts as none. Routed writes run one at a time per file (talk-writer.ts route queue) and
//   the editor route re-runs a function `next` against a fresh buffer, so the LAST reconcile runs
//   after the last change and writes what the final state says. A stopped share's tidy-up cannot
//   remove a newer share's line: it never names a URL to remove, it reads the slot. A write failure
//   is logged, as now (the one way a live share can lack its line).
//   Needs: deps.stampShareUrl to take the decide function (today it takes a fixed url | null).
//
// ── 5. The share sheet reducer (src/shared/shared-talk.ts; case 7) ───────────────────────────────
//   New phase `stopped` (no link; Copy, Stop, switches off; status "This talk is no longer shared.";
//   Done stays). New event `share-stopped { shareId | null }` (the share() reply). share() replies:
//   { success: true, share } · { success: true, stopped: true, shareId } · { success: false, error }.
//   │ event            │ loading   │ confirm-repl. │ creating │ ready      │ stopping       │ error  │ stopped │
//   │ inspected        │ ready / confirm-replace / creating; inspected{stopped} → stopped (no new Share) │
//   │ changed(share)   │ unchanged │ unchanged     │ ready    │ ready      │ stopping, upd. │ ready  │ ready†  │
//   │ changed(null)    │ unchanged │ unchanged     │ stopped  │ stopped    │ stopped        │ unchgd │ unchgd  │
//   │ share-stopped{id}│ unchanged │ unchanged     │ stopped* │ stopped*   │ ignored        │ stopped│ unchgd  │
//   │ created          │ ready     │ ready         │ ready    │ ready      │ ignored        │ ready  │ ready   │
//   │ failed           │ error     │ error         │ error    │ ready+err  │ ready+err      │ error  │ stop+err│
//   │ creating/stopping│ as event  │ as event      │ as event │ as event   │ as event       │ as evt │ as event│
//   * ignored when model.share holds a different shareId (the sheet follows the newer share).
//   † round 2 finding 1: the model keeps `goneShareId` (set by changed(null) from the share it held,
//     by share-stopped{id} and by inspected{stopped}); a changed(share) or inspected carrying that id
//     is ignored in every phase — a share reported closed never comes back. A newer share is followed.
//   The Update and switch replies are stopped{id} when a Stop overtook them (→ share-stopped).
//   `stopping` + own Stop reply: success → the sheet closes (unchanged); failure → `failed` → ready
//   with the error line and controls on. A Share's stopped reply during `stopping` is ignored: the
//   Stop's own reply decides. ShareSheet.tsx: keyRef is taken from every matching non-null broadcast
//   (not only the reply), and a null broadcast matches on keyRef or previousKey (round 5 finding 1).
//   No longer assumed (round 2): main→window ordering. A reply is read after its last await ([R*']).
//   inspected{interruptedShare} (no share, a create note left from before: [s]) → confirm-replace,
//   the warning is that sentence (plus the foreign one when share_url is another Mac's); the sheet
//   does not share unasked, and its "Share here" replaces the share left open.
//
// ── 6. Cases 1–7 through the table ──────────────────────────────────────────────────────────────
//   1 Share pending, Stop. C0: k1 skips the POST → N; nothing made; Share → stopped{null}, Stop →
//     closed. C1: reply → e5 → R (token kept) → close step → N; Share [R*] → stopped{A}. At rest:
//     no open share, no row, no token.
//   2 Share, Stop, Share. Queue: create A, close, create B. A made+kept, closed, removed; B made by
//     the second op (gen unchanged, so not superseded) → link B; first op → stopped{A}. Last
//     reconcile sees B → share_url = B. Open: B only, row and token for B only.
//   3 Stop while the first build hangs. R → S: abort settles the push chain (k3); the queue is free
//     (create step ended at e5) → close sent → N; Stop returns. Share → stopped{A}. A later Share on
//     the same instance runs (nothing wedged in sharing; its first build waits behind the compiler
//     gate until the held compile settles — section 9).
//   4 Outline replaced while Share pending. Stop → slotFor matches by realPath, re-keys slot; close
//     step on the same slot.id runs after the create → closes A → N. Same end as case 1.
//   5 Share A (QR held), Stop A, Share B, QRs released. A's op is superseded at k2 → no stamp. Stop
//     A's reconcile and B's reconcile both read the slot: whichever runs last sees B → B's line.
//     Stop B → reconcile with no row removes B's url (∈ madeUrls). Live ⇒ line; stopped ⇒ none.
//   6 Share A (QR held), Stop A, Share B (QR held), release A, Stop B, release B. A: [R*] waits for
//     Stop A, row is B ≠ A → stopped{A}. B: superseded by Stop B → waits → no row → stopped{B}.
//     No link returned; both closed; no rows; no tokens.
//   7 Sheet creating, other window Stops: null broadcast (matched by key) or the stopped reply →
//     `stopped`; never "Creating…" forever, never a copyable closed link, no error line. Own Stop
//     fails → ready + error, controls on.
//   Invariants after every case: (I1) no share open on the service without its token stored and
//   read back; (I2) no registered row whose share is closed (close success removes the row in the
//   same step; e10 keeps a row only for a share the service did not close); (I3) no token in
//   neither registry nor store (a token is only ever dropped by naming its row after a close).
//
// ── 7. Why the withdrawn attempts failed ────────────────────────────────────────────────────────
//   2af5f546 queue keyed by identity key and held through the first build: a replaced outline
//     escaped it, a Share joined across a Stop, a hung build blocked Stop. → slot.id key (e11),
//     join only on equal gen (e1 in C), queue holds create/close only (e2 in R).
//   47280501 a stopped Share threw (the sheet showed an error and re-enabled during Stop) and its
//     tidy-up was a read-then-remove of share_url that wiped B's line. → stopped result (5, [R*]),
//     reconcile transformation (section 4).
//   42d94e77 a stopped Share resolved with "the talk's current state", which could be a replacement
//     stopped during its own QR wait, and the sheet dropped null replies. → [R*] returns only its
//     own share or stopped{id}; reducer row share-stopped.
//
// ── 8. Tests (one per case; each must fail on the code as merged by ticket 02) ──────────────────
//   scripts/test-shared-talk-service.mjs, new section 12, fake Worker with gates on POST /shares,
//   build, qrSvg and stampShareUrl (a decide-applying in-memory outline behind a one-at-a-time
//   queue), plus a check run after every test: open shares on the fake Worker == registry rows ==
//   tokens readable from memoryOwnerTokens, and share_url == the open share's link or absent.
//   12.1 Stop during endpoint() → no POST; Stop during the held POST reply → share closed, both
//        callers' results as in case 1.
//   12.2 Share, Stop, Share with the POST held → second caller gets B, first gets stopped{A}.
//   12.3 build never resolves → Stop resolves, close sent; a further share() on the same instance.
//   12.4 hold POST, replace the outline file (new inode), Stop → A closed, no row.
//   12.5 the round-4 sequence → share_url is B's; after Stop B, absent.
//   12.6 the round-5 sequence → both stopped, no link returned, nothing open.
//   12.7 shareSheetReducer: every cell of section 5's table, and at rest (after a reply event) the
//        phase is never creating or stopping.
//   e2e/diagnose-shared-talk-share.mjs: hold the first PUT at the stand-in Worker, press Stop in the
//   sheet → close request seen, sheet closes, talk not shared, outline has no share_url.
//   test-owner-tokens.mjs sections 7–8 run unchanged (results and pre-work untouched).
//   Round 2 (review of 0a3840d5), one case per finding, each failing on 0a3840d5:
//   12.8 Update held in its build, Stop elsewhere → reply stopped{A}; reducer: changed(A) after
//        changed(null) stays stopped. 12.9 inspect held at its QR code, Stop → stopped{A}.
//   12.10 the real single-flight gate (buildInGate): held compile, Stop returns while it is held;
//        once released the next Share completes; no two gated tasks ever overlap (round 3).
//        12.11 QR held, Stop answers 500, Share → share_url written.
//   12.12 a registry file changed under a create: B's row written while A's endpoint() is held → no
//        POST from A, B open; written while A's POST is on its way → A's own share closed, A fails,
//        nothing else touched. Ended rows are never offered (round 3). 12.13 lost close reply
//        → Share makes a new share, inspect reports stopped. 12.14 registry dir unwritable at close
//        → failure saying closed, restart loads nothing live. 12.15 quit with the POST reply held →
//        drain bounded; at the next start no admin call, the leftover is reported (start list,
//        inspect, Stop); the next Share clears the note and the old share ends closed (the
//        Worker's create replaces the slug's previous share).
//
// ── 9. Limitations (accepted, round 3) ───────────────────────────────────────────────────────────
//   - The compiler gate is released only when a compile SETTLES (the memory guarantee: one deck
//     inlined at a time). Stop never waits for it, but a compile that never settles blocks every
//     later compile, Shares included. That is a compiler defect, not a sharing one.
//   - Both durable stores failing at once after a successful close (the registry file cannot be
//     written AND the secure store cannot delete the token): the Stop fails saying the share is
//     closed on the service (recordNotRemovedMessage); the row is closedRemotely in memory, but a
//     restart loads the row and its token back and offers it until the owner socket reports the
//     share ended (then it is gone, above) or Stop sharing is pressed again. No machinery for it.
//   - A row whose share ended with a refused token may still be open on the service; removing it
//     drops a token that no longer works. The talk's next Share replaces the slug's share.
// ═══ end of the ticket 12 design ═══════════════════════════════════════════════════════════════
//
// Share for comments (ticket 03): the main-process shared-talk module. It owns the share registry
// (app data, beside handout-registry.json), creates and stops shares on the live Worker, and pushes
// the compiled talk — once on Share, then on every save while "Show my latest saves as I work" is on,
// or on an explicit "Update shared copy" when it is off.
//
// Invariants:
//   - A share belongs to a talk's IDENTITY (the outline writer's outlineIdentity), never its file
//     name: two talks named alike in different folders are two talks with two shares. The Worker's
//     talkSlug carries a hash of the real path for the same reason (the Worker replaces a slug's
//     previous share when a new one is created).
//   - Creates and closes for one talk run one at a time (the talk's slot queue, ticket 12): a second
//     Share while one is in flight gets the same result unless a Stop came between, so no window
//     ever shows a link the Worker has already replaced, and the last request wins.
//   - Every id the Worker returns passes the Worker's own id rule (worker/share-id.ts) before it
//     touches a path or a URL; registry rows that fail it are ignored.
//   - A push never blocks or fails a save: noteSaved() returns at once, and every failure lands on
//     the share's lastError instead of a throw. Pushes for one talk run one at a time; saves that
//     arrive while one runs collapse into ONE follow-up push of the newest text.
//   - revision is always the Worker's confirmed revision + 1; a 409 re-pushes from the revision the
//     Worker reports. A 409 reporting the revision of an attempt whose reply was lost confirms that
//     attempt: its slides are kept as that revision.
//   - Each confirmed revision's slide text (and the outline text it was built from) is written
//     atomically to <talk>/feedback/<share-id>-revisions/<n>.json, so Compare (ticket 06) can show
//     a slide at an item's base revision; the Worker keeps only the current one.
//   - Stop sharing cancels queued and running pushes (nothing is pushed after it), and talks only to
//     the origin the share was created on, with the share's own owner token. No admin secret is ever
//     sent on a stop.
//   - The owner token stays in this process and the secrets store (owner-tokens.ts: the registry
//     file carries none; each row gets its token back when the registry is read); it is never in a
//     state object sent to a window. Every request that carries it goes through ownerFetch, whose
//     failure is a fixed sentence and never the transport's own error.
//   - A row whose token could not be read (secure storage locked) is not a share this module can
//     use, but it stays in the registry file untouched: a write here adds or changes the rows this
//     module holds and removes only a row it names (Stop sharing, a re-keyed talk). Such a row is
//     taken up again once the store can be read, and no second share is made for its talk meanwhile.
//   - A new share's owner token is stored and read back before anything is pushed to it; when it
//     cannot be stored the share is closed again with the token still in hand.
import { parseFrontmatterPairs } from '../shared/frontmatter-editor.ts'
import type { SharedTalkStopResult } from '../shared/shared-talk.ts'
import { describe, interruptedShareMessage, RecordNotRemoved, SHARE_UNVERIFIED, type Shared, type SharedTalkDeps, type SharedTalkRecord, type SharedTalks } from './shared-talk-model.ts'
import { createShareCore } from './shared-talk-state.ts'
import { createSlots, type Slot } from './shared-talk-slots.ts'
import { createReconcile } from './shared-talk-reconcile.ts'
import { createPush } from './shared-talk-push.ts'
import { createNotes, createRowBookkeeping } from './shared-talk-bookkeeping.ts'
import { createShareSteps } from './shared-talk-steps.ts'

export {
  feedbackDirFor, readRevisionSlides, readRevisionSnapshot, recordNotRemovedMessage, revisionSnapshotPath, workerTalkSlug,
  interruptedShareMessage, stopInterruptedMessage,
  SHARE_LOCKED, SHARE_NOT_KEPT, SHARE_NOT_KEPT_OPEN, SHARE_NOT_NOTED, SHARE_RACED, SHARE_UNVERIFIED,
} from './shared-talk-model.ts'
export type {
  InterruptedCreate, OutlineIdentityLike, RevisionSnapshot, SharedTalkDeps, SharedTalkOwner, SharedTalkRecord, SharedTalks,
} from './shared-talk-model.ts'

// The modules behind this facade, along the design's seams:
//   shared-talk-model.ts        the record, the interfaces, messages, error kinds, revision files
//   shared-talk-state.ts        the registry (rows, file, tokens) and the in-memory push state
//   shared-talk-slots.ts        the talk slot, the keyed create/close queue, stopGen, [R*] / [R*']
//   shared-talk-reconcile.ts    share_url as one transformation (section 4)
//   shared-talk-push.ts         the push (k3, k4)
//   shared-talk-bookkeeping.ts  create notes ([o], [s]), uncertain closes ([n], [q]), row removal ([j], [p]), ended rows
//   shared-talk-steps.ts        the create and close steps and the Share op around a create
export function createSharedTalks(deps: SharedTalkDeps): SharedTalks {
  const core = createShareCore(deps)
  const { registry, stopping, inFlight, timers, pendingSave, chains, background, creating, debounceMs, recordFor, recover, stateOf, linkOf, persist, emit, stoppingKey, cancelPending, log } = core
  const slots = createSlots(core)
  const { steps, slotFor, rowOf, currentState } = slots
  const reconcile = createReconcile(core, slots)
  const { enqueue } = createPush(core)
  const notes = createNotes(core)
  const rows = createRowBookkeeping(core, slots, reconcile)
  const { shareOp, closeStep } = createShareSteps(core, slots, notes, rows, reconcile, enqueue)

  /**
   * Before inspect or status answers about a row ([n], round 3): a row whose last close got no
   * answer is asked about on the service, and when the service cannot be reached the answer is the
   * SHARE_UNVERIFIED failure, never the link. An ended row is gone (currentState never offers it);
   * inspect also removes it in the slot's queue, so the sheet's next look shares afresh. status
   * leaves it (the status bar and the feedback rail read it often; the next look or Share removes it).
   */
  async function checkRow(slot: Slot, record: SharedTalkRecord, removeEnded: boolean): Promise<void> {
    if (record.closeUncertain) {
      let status: 'open' | 'closed' | 'unknown' = 'open'
      try { status = await steps.run(slot.id, () => rows.verifyUncertain(slot, record)) } catch { return /* closed, row kept closed */ }
      if (status === 'unknown' && rowOf(slot) === record && record.closeUncertain) throw new Error(SHARE_UNVERIFIED)
    }
    if (removeEnded && record.ended) {
      try { await steps.run(slot.id, () => rows.dropEnded(slot, record)) } catch { /* not removed: closedRemotely, offered as gone */ }
    }
  }

  return {
    async inspect(outlinePath) {
      // The talk's state when the answer is given, never a record captured before an await
      // (finding 2): a share closed meanwhile is reported stopped, and a newer one is looked at again.
      let seen: SharedTalkRecord | null = null
      for (;;) {
        const record = recordFor(outlinePath)
        if (!record) break
        seen = record
        const slot = slotFor(outlinePath)
        await checkRow(slot, record, true)
        const share = await currentState(slot, record)
        if (share) return { share, foreignShareUrl: null }
        const now = rowOf(slot)
        if (now && now !== record && !now.closedRemotely) continue
        break
      }
      if (seen) return { share: null, foreignShareUrl: null, stopped: { shareId: seen.shareId } }
      let foreign: string | null = null
      try {
        foreign = parseFrontmatterPairs(deps.peekOutline(outlinePath)).find((pair) => pair.key === 'share_url')?.value || null
      } catch { /* unreadable: nothing to warn about */ }
      // A create from before that was never registered (design note [s]): reported, so the sheet
      // asks before sharing (which replaces that share on the service).
      let interrupted: string | null = null
      try {
        const [left] = notes.leftoverFor(deps.identityOf(outlinePath).realPath)
        if (left) interrupted = interruptedShareMessage(notes.titleOf(left))
      } catch { /* no identity: nothing to report */ }
      return interrupted ? { share: null, foreignShareUrl: foreign, interruptedShare: interrupted } : { share: null, foreignShareUrl: foreign }
    },

    share(outlinePath, title) {
      let slot: Slot
      try { slot = slotFor(outlinePath) } catch (error) { return Promise.reject(error) }
      // Joined only while no Stop came between (equal gen); otherwise a new op behind the queue.
      if (slot.pending && slot.pending.gen === slot.stopGen) return slot.pending.promise
      const gen = slot.stopGen
      const promise: Promise<Shared> = shareOp(slot, outlinePath, title, gen)
        .finally(() => { if (slot.pending?.promise === promise) slot.pending = undefined })
      slot.pending = { gen, promise }
      return promise
    },

    async status(outlinePath) {
      const record = recordFor(outlinePath)
      if (!record) return null
      const slot = slotFor(outlinePath)
      await checkRow(slot, record, false)
      return currentState(slot, record)
    },

    list() {
      recover()
      return Object.values(registry.shares).map(stateOf)
    },

    async setOptions(outlinePath, options) {
      const record = recordFor(outlinePath)
      if (!record || record.closedRemotely) throw new Error('This talk is not shared.')
      const slot = slotFor(outlinePath)
      const proposalsChanged = typeof options.proposals === 'boolean' && options.proposals !== record.proposals
      if (typeof options.liveUpdates === 'boolean') record.liveUpdates = options.liveUpdates
      if (typeof options.proposals === 'boolean') record.proposals = options.proposals
      if (!record.liveUpdates) cancelPending(record.key)
      persist()
      emit(record.key)
      // Their page's permissions are baked into the pushed page, so a proposals change is pushed at
      // once — from the text they already have when switch 1 is off.
      if (proposalsChanged && record.revision > 0) {
        await enqueue(record.key, record.liveUpdates ? { kind: 'current' } : { kind: 'confirmed' }).catch(() => {})
      }
      // Read after the last await (finding 1): a Stop meanwhile → stopped, never the closed link.
      return await currentState(slot, record) ?? { stopped: true, shareId: record.shareId }
    },

    async update(outlinePath) {
      const record = recordFor(outlinePath)
      if (!record || record.closedRemotely) throw new Error('This talk is not shared.')
      const slot = slotFor(outlinePath)
      cancelPending(record.key)
      await enqueue(record.key, { kind: 'current' }).catch(() => {})
      // Read after the last await (finding 1): a Stop meanwhile → stopped, never the closed link.
      return await currentState(slot, record) ?? { stopped: true, shareId: record.shareId }
    },

    noteSaved(outlinePath, content) {
      try {
        const record = recordFor(outlinePath)
        if (!record || !record.liveUpdates || record.ended || stopping.has(record.shareId)) return
        const key = record.key
        pendingSave.set(key, content)
        const existing = timers.get(key)
        if (existing) clearTimeout(existing)
        const timer = setTimeout(() => {
          timers.delete(key)
          if (!registry.shares[key] || stoppingKey(key)) return
          void enqueue(key, { kind: 'save' })
        }, debounceMs)
        timers.set(key, timer)
        if (!existing) emit(key)
      } catch (error) {
        log(`[shared-talk] save hook failed: ${describe(error)}`)
      }
    },

    stop(outlinePath) {
      let slot: Slot
      try {
        slot = slotFor(outlinePath)
        recordFor(outlinePath) // the row follows the talk too (one re-key event)
      } catch (error) { return Promise.reject(error) }
      // Last request wins: every Share started before this is superseded from now on.
      slot.stopGen += 1
      const row = rowOf(slot)
      if (row) {
        // R or L → S at once: nothing is pushed from here on, and the running push is aborted. Stop
        // never waits for the push chain.
        stopping.add(row.shareId)
        cancelPending(row.key)
        inFlight.get(row.shareId)?.abort()
      }
      slot.closesPending += 1
      const run: Promise<SharedTalkStopResult> = steps.run(slot.id, () => closeStep(slot)).then(async ({ closed, result }) => {
        if (closed) await reconcile(slot) // outside the queue
        return result
      }, async (error) => {
        // Closed on the service, its record not removed (finding 7): the line goes all the same.
        if (error instanceof RecordNotRemoved) await reconcile(slot)
        throw error
      })
      const settled: Promise<void> = run.then(() => {}, () => {}).finally(() => { slot.stops.delete(settled) })
      slot.stops.add(settled)
      return run
    },

    owners() {
      recover()
      return Object.values(registry.shares).map((record) => ({
        key: record.key, outlinePath: record.outlinePath, shareId: record.shareId,
        ownerToken: record.ownerToken, workerBaseUrl: record.workerBaseUrl, url: linkOf(record),
        ended: record.ended ?? null,
      }))
    },

    markEnded(shareId, reason) {
      const record = Object.values(registry.shares).find((row) => row.shareId === shareId)
      if (!record || record.ended) return
      record.ended = reason
      cancelPending(record.key)
      inFlight.get(record.shareId)?.abort()
      persist()
      emit(record.key)
    },

    createsPending() {
      return creating.size > 0
    },

    async drainCreates(ms) {
      if (!creating.size) return
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.allSettled([...creating]),
        new Promise((resolve) => { timer = setTimeout(resolve, ms) }),
      ])
      if (timer) clearTimeout(timer)
    },

    interruptedCreates() {
      const found = notes.interruptedAtStart()
      for (const create of found) log(`[shared-talk] ${create.message}`)
      return found
    },

    async idle() {
      for (;;) {
        const pending: Promise<unknown>[] = [...chains.values(), ...background]
        for (const slot of slots.slots.values()) {
          if (slot.pending) pending.push(slot.pending.promise)
          pending.push(...slot.stops)
        }
        if (!pending.length && !timers.size) return
        if (!pending.length) { await new Promise((resolve) => setTimeout(resolve, Math.min(debounceMs, 50))); continue }
        await Promise.all(pending.map((p) => Promise.resolve(p).catch(() => {})))
      }
    },
  }
}
