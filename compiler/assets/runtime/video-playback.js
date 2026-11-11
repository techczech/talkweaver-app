// Presenter-owned local video transport. Inlined into the portable deck; no Electron API.
export function createVideoPlayback(options) {
  const now = options.now || Date.now;
  const bound = 0.25;
  const applied = new WeakMap();
  const seen = new Set();
  let revision = 0;
  let latest = null;
  const presenterId = options.presenterId || String(now()) + '-' + Math.random().toString(36).slice(2);
  let ownerId = null;
  let ownerAt = 0;
  const retiredOwners = new Set();
  function observeOwner(s) {
    if (!s || typeof s.presenterId !== 'string' || !s.presenterId || s.presenterId.length > 100
      || typeof s.at !== 'number' || !Number.isFinite(s.at) || Math.abs(now() - s.at) >= 5000
      || retiredOwners.has(s.presenterId)) return false;
    if (ownerId !== s.presenterId) {
      if (s.at < ownerAt) return false;
      if (ownerId) retiredOwners.add(ownerId);
      if (retiredOwners.size > 64) retiredOwners.delete(retiredOwners.values().next().value);
      ownerId = s.presenterId;
      latest = null;
    }
    ownerAt = Math.max(ownerAt, s.at);
    return true;
  }
  const validTime = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 86400;
  const validRate = n => typeof n === 'number' && Number.isFinite(n) && n >= 0.25 && n <= 4;
  function valid(s) {
    return s && typeof s.presenterId === 'string' && s.presenterId.length > 0 && s.presenterId.length <= 100 && Number.isSafeInteger(s.revision) && s.revision > 0 && Number.isSafeInteger(s.navSeq)
      && Number.isInteger(s.slide) && Number.isInteger(s.video) && s.video >= 0
      && typeof s.slideId === 'string' && validTime(s.time) && validRate(s.rate)
      && typeof s.paused === 'boolean' && typeof s.ended === 'boolean' && typeof s.loop === 'boolean'
      && typeof s.at === 'number' && Number.isFinite(s.at) && Math.abs(now() - s.at) < 5000
      && options.known(s);
  }
  function target(s) {
    const elapsed = s.paused || s.ended ? 0 : Math.max(0, now() - s.at) / 1000 * s.rate;
    return Math.min(86400, s.time + elapsed);
  }
  function decision(s, player) {
    let time = target(s);
    if (Number.isFinite(player.duration) && player.duration > 0) time = s.loop && !s.paused && !s.ended ? time % player.duration : Math.min(time, player.duration);
    return { time, seek: s.ended || Math.abs(player.currentTime - time) > bound, rate: s.rate, paused: s.paused || s.ended };
  }
  function snapshot(player, identity) {
    const s = { ...identity, presenterId, revision: ++revision, time: player.currentTime, rate: player.playbackRate,
      paused: player.paused, ended: player.ended, loop: player.loop, at: now() };
    return valid(s) ? s : null;
  }
  function apply(s, player, muted) {
    if (!valid(s) || !player || (ownerId && s.presenterId !== ownerId) || (options.playerMatches && !options.playerMatches(s, player))) return false;
    const d = decision(s, player);
    applied.set(player, { ...d, revision: s.revision });
    if (muted) { player.defaultMuted = true; player.muted = true; }
    player.loop = s.loop;
    if (player.playbackRate !== d.rate) player.playbackRate = d.rate;
    if (d.seek) { try { player.currentTime = d.time; } catch {} }
    if (d.paused) player.pause();
    else if (player.paused && !player.ended) { try { player.play()?.catch(() => {}); } catch {} }
    return true;
  }
  function echo(player) {
    const s = applied.get(player);
    return !!s && Math.abs(player.currentTime - s.time) <= bound && player.playbackRate === s.rate && player.paused === s.paused;
  }
  function accept(s) {
    if (!valid(s) || !observeOwner(s) || (latest && s.revision <= latest.revision)) return false;
    latest = s;
    return true;
  }
  function command(player, intent) {
    if (!player || !intent || typeof intent.nonce !== 'string' || intent.nonce.length > 100 || !intent.nonce || seen.has(intent.nonce)) return false;
    if (!['play', 'pause', 'seek', 'rate'].includes(intent.action)) return false;
    if (intent.action === 'seek' && !validTime(intent.value)) return false;
    if (intent.action === 'rate' && !validRate(intent.value)) return false;
    seen.add(intent.nonce); if (seen.size > 128) seen.delete(seen.values().next().value);
    if (intent.action === 'seek') player.currentTime = Math.min(intent.value, Number.isFinite(player.duration) ? player.duration : 86400);
    if (intent.action === 'rate') player.playbackRate = intent.value;
    if (intent.action === 'pause') player.pause();
    if (intent.action === 'play') { if (player.ended) player.currentTime = 0; try { player.play()?.catch(() => {}); } catch {} }
    return true;
  }
  return { snapshot, apply, accept, command, echo, decision, valid, observeOwner, presenterId, get latest() { return latest; } };
}

export function videoPlaybackRuntimeSource() { return createVideoPlayback.toString(); }
