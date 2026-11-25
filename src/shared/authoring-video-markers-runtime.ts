// Installed only on authoring documents. The parent holds the outline; this frame holds playback.
export const AUTHORING_MARKER_BRIDGE = `<script data-tw-video-marker-bridge>
(() => {
  if (window.parent === window || !new URLSearchParams(location.search).has('tw-marker-preview')) return;
  const events = ['loadedmetadata', 'durationchange', 'seeking', 'timeupdate', 'emptied', 'play', 'pause'];
  const slide = () => document.querySelector('.stage > .slide.active');
  const videos = () => [...(slide()?.querySelectorAll('video') ?? [])].filter(video => {
    const card = video.closest('.carousel-subslide');
    return !card || card.classList.contains('active-card');
  });
  const send = () => {
    const id = slide()?.dataset.id;
    if (!id) return;
    window.parent.postMessage({
      type: 'tw-marker-preview-state', url: location.href, slideId: id,
      videos: videos().map(video => ({
        ref: video.dataset.videoRef ?? (video.getAttribute('src')?.startsWith('http') ? video.getAttribute('src') : null),
        t: Math.floor(video.currentTime),
        duration: Number.isFinite(video.duration) ? video.duration : null,
      })),
    }, '*');
  };
  for (const event of events) document.addEventListener(event, e => {
    if (videos().includes(e.target)) send();
  }, true);
  window.addEventListener('message', event => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (data?.url !== location.href) return;
    if (data.type === 'tw-marker-preview-read') send();
    if (data.type === 'tw-marker-preview-markers' && typeof data.markers === 'string') {
      let sets;
      try { sets = JSON.parse(data.markers); } catch { return; }
      if (!Array.isArray(sets)) return;
      videos().forEach((video, index) => {
        const markers = sets.find(item => item?.index === index)?.markers;
        video.dataset.videoMarkers = Array.isArray(markers) ? JSON.stringify(markers) : '[]';
        video.dispatchEvent(new Event('tw-video-markers-change'));
      });
      return;
    }
    if (data.type !== 'tw-marker-preview-seek' || !Number.isSafeInteger(data.index) ||
        !Number.isFinite(data.t) || data.t < 0 || data.t > 86400) return;
    const video = videos()[data.index];
    if (!video || (Number.isFinite(video.duration) && data.t > video.duration)) return;
    video.currentTime = data.t;
    send();
  });
  window.addEventListener('hashchange', () => requestAnimationFrame(send));
  requestAnimationFrame(send);
})();
</script>`
