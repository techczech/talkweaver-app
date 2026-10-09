// "Play as a step" (0.38 ticket 05): what a window does with a {play-on-next} file once the step
// says whether it plays. The order, the count and the state of each file at a step are
// runtime/emphasis-steps.js (mediaStepStates); this module is the playback, and it is the same
// source on the projector / plain deck (07-assembly, `<!--MEDIA_STEPS_RUNTIME-->`) and on the venue
// screen (09-output-builders), so the two start and stop a file from the same step the same way.
//
// A file is the element that carries `data-play-on-next`: the video's <figure> or the audio chip.
// The controller writes on it
//   data-media-step          "waiting" | "playing" | "played": the state last applied
//   data-media-step-started  while a start has been asked for at this step and not refused
//   data-media-step-muted    while the video plays without sound because the browser refused sound
// and acts only when the state CHANGES, so a re-render never restarts a file and the presenter's
// own Play / Pause on the file stands until the step moves.
//
//   → playing   from the start of the file, unless it is already playing (started by hand)
//   → played    paused where it is; the chip shows `finished`. A video that never played in this
//               window (the slide was entered backwards) is put on its last frame.
//   → waiting   paused and rewound to the start; the chip shows `ready`
//
// A refused start (the browser wants a gesture first): a video is tried again without sound and,
// if that plays, carries a "Tap for sound" control; an audio chip carries "Tap to play". The step
// is not marked started when nothing plays, so the next render of the slide tries again.
//
// Each function is inlined by toString() into a template literal: no backtick inside a function.
//
// A window that must stay silent (the presenter, a replay, a preview document, a handout or a
// phone) passes `canPlay: () => false`: nothing is written, loaded, played or paused there.

export function createMediaStepController(options) {
  const canPlay = (options && options.canPlay) || function () { return true; };
  const audioChips = (options && options.audioChips) || null;
  const playerOf = (options && options.playerOf) || function (file) { return file.querySelector('video, audio'); };
  let live = null;   // the slide whose files carry a state now

  function isChip(file) { return file.classList.contains('slide-audio'); }
  function attempt(player) {
    try { return Promise.resolve(player.play()); } catch (error) { return Promise.reject(error); }
  }
  function clearTap(file) {
    const tap = file.querySelector(':scope > .media-step-tap');
    if (tap) tap.remove();
    if (file.dataset.mediaStepMuted) {
      const player = playerOf(file);
      if (player) player.muted = false;
      delete file.dataset.mediaStepMuted;
    }
  }
  function showTap(file, label) {
    if (file.querySelector(':scope > .media-step-tap')) return;
    const tap = document.createElement('button');
    tap.type = 'button';
    tap.className = 'media-step-tap';
    tap.textContent = label;
    tap.addEventListener('click', function (event) { event.stopPropagation(); tapped(file); });
    // Space and Enter press the focused control (the browser turns them into its click). The deck
    // reads both as Next, so they stop here; every other key (arrows, Esc) goes on to the deck.
    const ownKey = function (event) { if (event.key === ' ' || event.key === 'Enter') event.stopPropagation(); };
    tap.addEventListener('keydown', ownKey);
    tap.addEventListener('keyup', ownKey);
    file.appendChild(tap);
  }
  // The tap is the gesture the browser asked for: sound on for a video, the first start for a chip.
  function tapped(file) {
    const player = playerOf(file);
    if (!player) return;
    clearTap(file);
    file.dataset.mediaStepStarted = '1';
    attempt(player).catch(function () { delete file.dataset.mediaStepStarted; });
  }
  function start(file) {
    const player = playerOf(file);
    if (!player) return;
    file.dataset.mediaStepStarted = '1';
    if (!player.paused && !player.ended) return;
    try { if (player.currentTime > 0) player.currentTime = 0; } catch (error) { /* not seekable yet */ }
    attempt(player).catch(function (error) {
      if (file.dataset.mediaStep !== 'playing') return;   // the step moved on while the start was pending
      const refused = Boolean(error) && error.name === 'NotAllowedError';
      if (refused && !isChip(file) && !player.muted) {
        player.muted = true;
        file.dataset.mediaStepMuted = '1';
        attempt(player).then(function () {
          if (file.dataset.mediaStep === 'playing') showTap(file, 'Tap for sound');
        }, function () {
          player.muted = false;
          delete file.dataset.mediaStepMuted;
          delete file.dataset.mediaStepStarted;
        });
        return;
      }
      delete file.dataset.mediaStepStarted;
      if (refused && isChip(file)) showTap(file, 'Tap to play');
    });
  }
  function pass(file) {
    delete file.dataset.mediaStepStarted;
    clearTap(file);
    const player = playerOf(file);
    if (isChip(file) && audioChips) { audioChips.finish(file); return; }
    if (!player) return;
    if (!player.paused) { player.pause(); return; }
    // Never started here: show the last frame, now or once the length is known. No load() and no
    // play(): the element fetches its own metadata.
    if (player.currentTime > 0 || isChip(file)) return;
    const toEnd = function () {
      if (file.dataset.mediaStep !== 'played' || !isFinite(player.duration) || player.duration <= 0) return;
      try { player.currentTime = player.duration; } catch (error) { /* not seekable yet */ }
    };
    if (isFinite(player.duration) && player.duration > 0) toEnd();
    else player.addEventListener('loadedmetadata', toEnd, { once: true });
  }
  function rewind(file) {
    delete file.dataset.mediaStepStarted;
    clearTap(file);
    const player = playerOf(file);
    if (isChip(file) && audioChips) { audioChips.stop(file); return; }
    if (!player) return;
    if (!player.paused) player.pause();
    try { if (player.currentTime > 0) player.currentTime = 0; } catch (error) { /* not seekable yet */ }
  }
  function set(file, next) {
    const was = file.dataset.mediaStep || 'waiting';
    if (next === 'playing') {
      file.dataset.mediaStep = 'playing';
      if (!file.dataset.mediaStepStarted) start(file);
      return;
    }
    file.dataset.mediaStep = next;
    if (next !== was) { if (next === 'played') pass(file); else rewind(file); }
  }
  function release(slide) {
    slide.querySelectorAll('[data-media-step]').forEach(function (file) {
      // Whatever its step: a file played by hand before its step is still 'waiting', and it too
      // goes back to its start, so the slide returns on the first frame.
      const player = playerOf(file);
      const touched = Boolean(player) && (!player.paused || player.currentTime > 0);
      if (file.dataset.mediaStep !== 'waiting' || touched) rewind(file);
      file.removeAttribute('data-media-step');
    });
  }
  return {
    /**
     * slide is the one on show; files[i] is a {play-on-next} file on it and states[i] its state
     * at the step ('waiting' | 'playing' | 'played'; a null entry in either is skipped).
     * Every other file on the slide is 'waiting', and the files of the slide shown before are
     * stopped and rewound.
     */
    apply(slide, files, states) {
      if (!canPlay()) return;
      if (live && live !== slide) { release(live); live = null; }
      if (!slide) return;
      const all = slide.querySelectorAll('[data-play-on-next]');
      if (all.length === 0) return;
      live = slide;
      const want = new Map();
      (files || []).forEach(function (file, i) { if (file && states[i]) want.set(file, states[i]); });
      // The chips' own events paint their state (runtime/audio-chip.js); nothing autoplays here.
      if (audioChips && slide.querySelector('.slide-audio[data-play-on-next]')) audioChips.enter(slide, false);
      all.forEach(function (file) { set(file, want.get(file) || 'waiting'); });
    }
  };
}

/**
 * The presenter's current-slide preview: the state of each file at the step, shown and silent.
 * Before its step a file carries a "plays on Next" mark; a video at its step reads "playing" (an
 * audio chip shows its own playing state, reported by the projector). `icon` builds the mark's
 * icon (null for none). Only ever called on the preview's clone: the audience never sees a mark.
 */
export function paintMediaStepMarks(files, states, icon) {
  (files || []).forEach(function (file, i) {
    const state = file ? states[i] : null;
    if (!state) return;
    file.setAttribute('data-media-step', state);
    const label = state === 'waiting' ? 'plays on Next' : state === 'playing' && !file.classList.contains('slide-audio') ? 'playing' : '';
    if (!label) return;
    const mark = document.createElement('span');
    mark.className = 'media-step-mark';
    const glyph = typeof icon === 'function' ? icon(state) : null;
    if (glyph) mark.appendChild(glyph);
    const text = document.createElement('span');
    text.textContent = label;
    mark.appendChild(text);
    file.appendChild(mark);
  });
}

export function mediaStepsRuntimeSource() {
  return [createMediaStepController, paintMediaStepMarks].map((fn) => fn.toString()).join('\n');
}
