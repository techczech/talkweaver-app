import assert from 'node:assert/strict'
import { createAudienceFollowClient } from '../compiler/assets/runtime/live-follow.js'

function storage() {
  const values = new Map()
  return { getItem: (k) => values.get(k) ?? null, setItem: (k,v) => values.set(k,String(v)), removeItem: (k) => values.delete(k),
    key: (i) => [...values.keys()][i] ?? null, get length() { return values.size } }
}
function harness(sharedStorage = storage()) {
  let now = 0, id = 0
  const sockets = [], timers = new Map(), receipts = [], states = []
  const client = createAudienceFollowClient({
    baseUrl: 'https://live.example.test', sessionId: 'session-test', storage: sharedStorage,
    participantId: 'participant-test', random: () => 0.5,
    schedule: (fn, delay) => { const key = ++id; timers.set(key,{at:now+delay,fn}); return key },
    cancelSchedule: (key) => timers.delete(key),
    createSocket: (url) => { const socket = {url,readyState:0,sent:[],
      send(text) { this.sent.push(JSON.parse(text)) }, close() { this.readyState=3 },
      open() { this.readyState=1; this.onopen?.() },
      receive(message) { this.onmessage?.({data:JSON.stringify(message)}) },
      drop() { this.readyState=3; this.onclose?.() },
    }; sockets.push(socket); return socket },
    onVoteStatus: (receipt) => receipts.push(receipt), onSlideState: (s) => states.push(s),
  })
  function advance(ms) {
    const until=now+ms
    while(true) {
      const next=[...timers].filter(([,t])=>t.at<=until).sort((a,b)=>a[1].at-b[1].at)[0]
      if(!next) break
      now=next[1].at; timers.delete(next[0]); next[1].fn()
    }
    now=until
  }
  function synchronise(extra={}) {
    const socket=sockets.at(-1)
    socket.open()
    socket.receive({type:'session.hello',protocol:2,expiresAt:Date.now()+60_000})
    assert.notEqual(client.status(),'live','opening alone is not synchronisation')
    const sync=socket.sent.findLast(m=>m.type==='session.sync')
    assert.ok(sync,'client requests a fresh snapshot')
    socket.receive({type:'session.snapshot',protocol:2,sessionId:'session-test',syncId:sync.syncId,
      expiresAt:Date.now()+60_000,slideState:null,polls:[],receipts:[],...extra})
  }
  return {client,sockets,timers,receipts,states,advance,synchronise,storage:sharedStorage}
}

{
  const h=harness()
  h.synchronise()
  assert.equal(h.client.status(),'live')
  h.advance(15_000)
  assert.equal(h.sockets[0].sent.at(-1).type,'session.ping')
  h.advance(10_000)
  assert.equal(h.client.status(),'paused-reconnecting')
  h.advance(750)
  h.synchronise()
  assert.equal(h.sockets.length,2)
  h.client.end()
}
{
  const h=harness()
  h.synchronise()
  const id=h.client.sendVote('poll-test','a')
  assert.equal(typeof id,'string')
  assert.equal(h.receipts.some(r=>r.status==='confirmed'),false,'send is not confirmation')
  const original=h.sockets[0].sent.find(m=>m.type==='vote.submit')
  assert.equal(original.submissionId,id)
  h.sockets[0].drop(); h.advance(750); h.synchronise()
  assert.deepEqual(h.sockets[1].sent.find(m=>m.type==='vote.submit'),original,'retry reuses submission ID')
  h.sockets[1].receive({type:'vote.ack',submissionId:id,pollId:'poll-test',status:'confirmed',choice:'a'})
  assert.equal(h.receipts.at(-1).status,'confirmed')
  h.client.end()
  const reopened=harness(h.storage)
  reopened.synchronise({receipts:[{type:'vote.ack',submissionId:id,pollId:'poll-test',status:'confirmed',choice:'a'}]})
  assert.equal(reopened.sockets[0].sent.some(m=>m.type==='vote.submit'),false)
  assert.equal(reopened.receipts.at(-1).choice,'a')
  reopened.client.end()
}
{
  const h=harness()
  h.synchronise()
  const id=h.client.sendVote('poll-test','a')
  h.client.end()
  const reloaded=harness(h.storage)
  reloaded.synchronise()
  assert.equal(reloaded.sockets[0].sent.find(m=>m.type==='vote.submit').submissionId,id,'reload preserves pending ID')
  reloaded.sockets[0].receive({type:'vote.ack',submissionId:id,pollId:'poll-test',status:'rejected',error:'Poll is closed.'})
  assert.equal(reloaded.receipts.at(-1).status,'rejected')
  reloaded.client.end()
}
{
  const h=harness()
  h.sockets[0].open(); h.advance(10_000)
  assert.equal(h.client.status(),'paused-reconnecting')
  h.client.end()
}
console.log('audience recovery: handshake, silent stall, acknowledgement, retry identity and reload passed')

for (const choice of [['c', 'a', 'b'], { rowA: 'often', rowB: 'never' }]) {
  const h = harness()
  h.synchronise()
  const submissionId = h.client.sendVote('poll-extended', choice)
  const original = h.sockets[0].sent.find(m => m.type === 'vote.submit')
  h.sockets[0].drop(); h.advance(750); h.synchronise()
  assert.deepEqual(h.sockets[1].sent.find(m => m.type === 'vote.submit'), original)
  h.sockets[1].receive({ type: 'vote.ack', submissionId, pollId: 'poll-extended', status: 'confirmed', choice })
  assert.deepEqual(h.receipts.at(-1).choice, choice, 'extended receipt preserves rank order or row labels')
  h.client.end()
  const reloaded = harness(h.storage)
  reloaded.synchronise({ receipts: [{ type: 'vote.ack', submissionId, pollId: 'poll-extended', status: 'confirmed', choice }] })
  assert.equal(reloaded.sockets[0].sent.some(m => m.type === 'vote.submit'), false)
  assert.deepEqual(reloaded.receipts.at(-1).choice, choice)
  reloaded.client.end()
}
console.log('extended audience recovery: rank order and matrix receipts survive reconnect and reload')
