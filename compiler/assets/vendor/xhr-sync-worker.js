'use strict'

// The packaged compiler's SVG sanitiser never performs network I/O. jsdom
// resolves this worker eagerly, so keep a shipped fail-closed target for that
// optional code path rather than allowing resolution to escape compiler/.
throw new Error('Synchronous XHR is unavailable in the packaged SVG sanitiser')
