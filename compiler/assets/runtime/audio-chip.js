// The audio chip's runtime (0.38 ticket 04). The compiler renders `![Title](clip.mp3)` as
//   <div class="slide-audio" data-audio-state="ready"> icon, title, bars, time, <audio preload="none"> </div>
// and this module is the only thing that changes it. Three states: ready, playing (bars and elapsed
// time), finished. `setAudioChipState` is the one DOM write: the projector drives it from the real
// <audio> events, and the presenter's current-slide preview drives it from the projector's reports,
// on a clone that carries NO <audio> element, so the preview shows the state and stays silent.
//
// Every function here is self-contained: `audioChipRuntimeSource()` serialises them into the deck
// template (07-assembly, `<!--AUDIO_RUNTIME-->`), and the DOM test loads the same source.

export function formatAudioClock(seconds) {
  const whole = Math.max(0, Math.floor(Number(seconds) || 0));
  return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
}

/** Paint one chip. Returns true when the visible state or time changed. */
export function setAudioChipState(chip, state, seconds) {
  if (!chip || !chip.dataset) return false;
  const next = state === 'playing' || state === 'finished' ? state : 'ready';
  const text = formatAudioClock(next === 'ready' ? 0 : seconds);
  const time = chip.querySelector('.slide-audio-time');
  const timeChanged = Boolean(time) && time.textContent !== text;
  const stateChanged = chip.dataset.audioState !== next;
  if (stateChanged) chip.dataset.audioState = next;
  if (timeChanged) time.textContent = text;
  return stateChanged || timeChanged;
}

/**
 * Controller for the chips on the projector (and the plain deck). `onChange(chip, state, seconds)`
 * fires whenever a chip's visible state or whole-second time changes, so the caller can report it
 * to the presenter.
 */
export function createAudioChipController(options) {
  const onChange = (options && options.onChange) || function () {};
  const audioOf = (chip) => chip.querySelector('audio');
  function apply(chip, state, seconds) {
    if (setAudioChipState(chip, state, seconds)) onChange(chip, chip.dataset.audioState, seconds);
  }
  function bind(chip) {
    const audio = audioOf(chip);
    if (!audio || chip.dataset.audioBound) return audio;
    chip.dataset.audioBound = '1';
    audio.addEventListener('playing', () => apply(chip, 'playing', audio.currentTime));
    audio.addEventListener('timeupdate', () => { if (!audio.paused) apply(chip, 'playing', audio.currentTime); });
    // A clip that ran to its end pauses first and then fires `ended`: only a real pause is "ready".
    // finish() below pauses a clip the step has moved past: that chip is already `finished`.
    audio.addEventListener('pause', () => { if (!audio.ended && chip.dataset.audioState !== 'finished') apply(chip, 'ready', 0); });
    audio.addEventListener('ended', () => apply(chip, 'finished', audio.currentTime));
    return audio;
  }
  function play(chip) {
    const audio = bind(chip);
    if (!audio) return Promise.resolve(false);
    if (chip.dataset.audioState === 'finished') { try { audio.currentTime = 0; } catch (e) { /* not seekable yet */ } }
    // Resolves true once playback has begun. A blocked autoplay, or an undecodable or missing
    // source, rejects: the chip stays as it was (ready) and the promise resolves false.
    let result;
    try { result = audio.play(); } catch (e) { return Promise.resolve(false); }
    return Promise.resolve(result).then(() => true, () => false);
  }
  function pause(chip) {
    const audio = audioOf(chip);
    if (audio) audio.pause();
  }
  function stop(chip) {
    const audio = audioOf(chip);
    if (audio) {
      audio.pause();
      try { audio.currentTime = 0; } catch (e) { /* not seekable yet */ }
    }
    delete chip.dataset.audioAutoplayed;
    apply(chip, 'ready', 0);
  }
  // "Play as a step" (ticket 05): the step has moved past the file. It stops where it is and the
  // chip shows `finished`, as it does after a clip that ran to its end.
  function finish(chip) {
    const audio = audioOf(chip);
    const at = audio ? audio.currentTime : 0;
    if (audio && !audio.paused) audio.pause();
    apply(chip, 'finished', at);
  }
  return {
    play, pause, stop, finish,
    /** The slide became the live one: bind its chips and start the {autoplay} ones, once.
     *  `canAutoplay` is false on every surface but the live projector / plain deck display. */
    enter(slide, canAutoplay) {
      slide.querySelectorAll('.slide-audio').forEach((chip) => {
        bind(chip);
        if (canAutoplay && chip.hasAttribute('data-audio-autoplay') && !chip.dataset.audioAutoplayed) {
          // The marker stops a re-render restarting a clip that is starting or has played; a
          // rejected start clears it, so the next render of the live slide tries again.
          chip.dataset.audioAutoplayed = '1';
          play(chip).then((started) => { if (!started) delete chip.dataset.audioAutoplayed; });
        }
      });
    },
    /** The slide is no longer live: every chip stops, rewinds to 0 and returns to ready, whatever its state. */
    leave(slide) {
      slide.querySelectorAll('.slide-audio').forEach((chip) => {
        // Whatever its state: a paused clip (state ready, position kept) is rewound too, so coming
        // back starts from the top. Chips never touched are skipped: leave runs on every render.
        const audio = audioOf(chip);
        const touched = chip.dataset.audioState !== 'ready' || chip.dataset.audioAutoplayed || (audio && (!audio.paused || audio.currentTime > 0));
        if (touched) stop(chip);
      });
    }
  };
}

export function audioChipRuntimeSource() {
  return [formatAudioClock, setAudioChipState, createAudioChipController].map((fn) => fn.toString()).join('\n');
}
