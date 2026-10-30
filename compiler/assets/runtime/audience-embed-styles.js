// Audience pages expand the existing frame, preserving its document and sandbox. Reset the
// positioning/clipping ancestors rather than reparenting the frame (which reloads it).
export const audienceEmbedStyles = `
@media screen {
  body.share-embed-expanded { overflow: hidden !important; }
  body.share-embed-expanded :has(.stage-fit .embed-stage-expanded),
  body.share-embed-expanded .stage-fit :has(.embed-stage-expanded) {
    transform: none !important; zoom: 1 !important; contain: none !important;
    container-type: normal !important; filter: none !important; overflow: visible !important;
  }
  body.share-embed-expanded .stage-fit {
    position: fixed !important; inset: 0 !important; z-index: 9000 !important;
    display: block !important; width: 100vw !important; height: 100dvh !important;
    max-width: none !important; max-height: none !important; margin: 0 !important;
    border: 0 !important; border-radius: 0 !important; padding: 0 !important;
  }
  body.share-embed-expanded .stage {
    position: absolute !important; inset: 0 !important; transform: none !important;
    width: 100% !important; height: 100% !important;
  }
  body.share-embed-expanded .slide.embed-full-screen {
    position: absolute !important; inset: 0 !important; padding: 0 !important;
  }
  body.share-embed-expanded .slide.embed-full-screen :has(.embed-stage-expanded) {
    position: static !important;
  }
  body.share-embed-expanded figure.slide-embed.embed-stage-expanded {
    position: absolute !important; inset: 0 !important; z-index: 20 !important;
    width: 100% !important; height: 100% !important; max-width: none !important;
    max-height: none !important; margin: 0 !important; padding: 0 !important;
    border: 0 !important; border-radius: 0 !important; background: white;
  }
  body.share-embed-expanded figure.slide-embed.embed-stage-expanded > iframe {
    display: block; width: 100% !important; height: 100% !important;
    min-height: 0 !important; max-height: none !important; border: 0 !important; border-radius: 0 !important;
  }
  #shareEmbedReturn { z-index: 9999; }
  #shareEmbedReturn:not([hidden]) { display: inline-flex; }
  #shareEmbedReturn[hidden] { display: none !important; }
}
@media print { #shareEmbedReturn { display: none !important; } }
`;
