// Captions identify a destination; the href/QR always retains the original address.
// A printed address without either way to open it must remain complete and typeable.
export function displayWebAddress(raw, { qr = false, linked = false, maxLength = 56 } = {}) {
  const original = String(raw ?? '').trim();
  if (!qr && !linked) return original;
  const address = original.replace(/^https?:\/\//i, '').replace(/^\/\//, '').replace(/^www\./i, '');
  if (!/^[^/?#\s]+\.[^/?#\s]+(?:[/?#]|$)/u.test(address)) return original;
  const [, host, rawPath = ''] = address.match(/^([^/?#]+)([^?#]*)/u);
  if (qr) return host;
  const path = rawPath === '/' ? '' : rawPath;
  // Count Unicode code points so truncating a path never cuts a surrogate pair.
  const hostLength = [...host].length, pathCharacters = [...path];
  if (hostLength + pathCharacters.length <= maxLength) return host + path;
  const available = maxLength - hostLength - 1;
  if (available <= 1) return host + (path ? '/…' : '');
  const cut = pathCharacters.slice(0, available).join('');
  const boundary = Math.max(cut.lastIndexOf('/'), cut.lastIndexOf('-'));
  return host + (boundary > 0 ? cut.slice(0, boundary + (cut[boundary] === '-' ? 1 : 0)) : cut) + '…';
}
