// Media references stay inside the talk's vault (ADR-0036).
//
// A talk names files: images, video, audio, the title logo, a video's poster, a local embed. The
// compiler puts those files' bytes into output that is published, shared and backed up, so a talk
// received from someone else must not be able to name a file elsewhere on this Mac. This module is
// the one place that decides whether a named file may be read.
//
// The rule is about where the file REALLY is, not how the reference is written: an absolute path
// inside an allowed root is fine (pooled `_assets` media is referenced that way); a relative path
// that climbs out with `..`, or reaches out through a symlink, is not.
//
// Semantics, exactly:
//   - Both sides are canonicalised with realpath(3) (`fs.promises.realpath`): each allowed root,
//     and the candidate. Every symlink on the way — the file itself, a folder in the middle, the
//     root — is followed before anything is compared.
//   - "Inside" is the root itself or a descendant, compared by whole path segments on the two
//     canonical strings, EXACTLY (no case folding, no Unicode folding). On a case-insensitive
//     volume the OS has already answered "is this the same file" by resolving the path; comparing
//     its canonical answers exactly can only ever refuse too much, never allow too much.
//   - Only an existing REGULAR FILE resolves. A folder, FIFO, socket or device inside a root is
//     `missing`; outside a root it is `outside`.
//   - A path that does not exist is `missing` when it would land inside a root (judged from its
//     nearest existing ancestor's real path, so a symlinked parent cannot hide where it lands) and
//     `outside` otherwise. A dangling or looping symlink is `outside`: its target cannot be shown
//     to be inside. So `outside` never tells the reader whether an outside file exists.
//   - A root that does not exist, is not absolute or is not a string allows nothing. No roots: nothing.
//   - The result's `path` is the REAL path. Read that, not the reference: the bytes then come from
//     the file that was checked.
//
// Not covered: a file swapped for a symlink between this check and the read (that needs write
// access to the vault during the compile).

import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

// ── What a browser would make of a reference ─────────────────────────────────────────────────────
// The compiler reads a local reference as a file name; a browser reads the same text as a URL, and
// its parser is more permissive than `path.resolve` (`file:` URLs, `\` as `/`, tabs and newlines
// dropped, surrounding spaces dropped). So "is this reference remote?" is never answered by looking
// for `file:` or any other bad spelling. It is answered by an allow-list on the PARSED URL: the
// reference is parsed the way a page loaded from a local folder would parse it (WHATWG URL, a
// `file:` base), and it is remote only when the scheme that comes out is exactly http or https.
// Everything else — relative, absolute, `file:`, `//host`, `blob:`, `javascript:`, anything new —
// is a local reference, to be resolved inside the allowed roots or left out of the page.
const BROWSER_BASE = "file:///tw-talk-folder/talk.html";
// A reference written the plain way is emitted as written; any other spelling the parser accepts
// (capitals, missing slashes, backslashes, stray spaces) is emitted in its parsed form, so every
// later check and every renderer sees `http://` or `https://` at the start.
const PLAIN_REMOTE_RE = /^https?:\/\/[^\s\\\u0000-\u001f\u007f]*$/;

/** The URL to emit for a remote (http/https) reference, or null when the reference is not remote. */
export function remoteReferenceUrl(written) {
  if (typeof written !== "string" || !written) return null;
  let url;
  try { url = new URL(written, BROWSER_BASE); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  return PLAIN_REMOTE_RE.test(written) ? written : url.href;
}

/** Is canonical path `real` the canonical root `realRoot` or below it? Whole segments, exact. */
export function isInsideRealRoot(realRoot, real) {
  if (typeof realRoot !== "string" || typeof real !== "string" || !realRoot || !real) return false;
  if (real === realRoot) return true;
  const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep; // "/" stays "/", "/vault" → "/vault/"
  return real.startsWith(prefix);
}

async function realRoots(allowedRoots) {
  const out = [];
  for (const root of Array.isArray(allowedRoots) ? allowedRoots : []) {
    if (typeof root !== "string" || !root || root.includes("\0") || !isAbsolute(root)) continue;
    try {
      const real = await realpath(root);
      if (!out.includes(real)) out.push(real);
    } catch { /* a root that is not there allows nothing */ }
  }
  return out;
}

async function refusalFor(roots, candidate) {
  // Walk up to the nearest ancestor that resolves; where the path would land is that ancestor's
  // real path plus the rest. An entry that exists but does not resolve is a dangling/looping link.
  let probe = candidate;
  const rest = [];
  for (;;) {
    let exists = false;
    try { await lstat(probe); exists = true; } catch { /* not there */ }
    if (exists) {
      let real;
      try { real = await realpath(probe); } catch { return "outside"; }
      const landing = rest.length ? join(real, ...rest) : real;
      return roots.some((root) => isInsideRealRoot(root, landing)) ? "missing" : "outside";
    }
    const parent = dirname(probe);
    if (parent === probe) return "outside";
    rest.unshift(basename(probe));
    probe = parent;
  }
}

async function check(roots, candidate) {
  if (typeof candidate !== "string" || !candidate || candidate.includes("\0") || !isAbsolute(candidate)) {
    return { ok: false, reason: "outside" };
  }
  const lexical = resolve(candidate);
  let real;
  try { real = await realpath(lexical); } catch {
    try { return { ok: false, reason: await refusalFor(roots, lexical) }; } catch { return { ok: false, reason: "outside" }; }
  }
  if (!roots.some((root) => isInsideRealRoot(root, real))) return { ok: false, reason: "outside" };
  try {
    if (!(await stat(real)).isFile()) return { ok: false, reason: "missing" };
  } catch { return { ok: false, reason: "missing" }; }
  return { ok: true, path: real };
}

/**
 * May the file at absolute path `candidate` be read for a talk whose media may come from
 * `allowedRoots` (absolute folder paths)?
 *   → { ok: true, path }                         `path` is the file's real path: read that.
 *   → { ok: false, reason: "missing" | "outside" }
 * Never throws.
 */
export async function resolveContainedFile(allowedRoots, candidate) {
  return check(await realRoots(allowedRoots), candidate);
}

/**
 * The same check for one compile: the roots are canonicalised once. Returns
 * `{ file(candidate), reference(baseDir, reference), label(reference) }`.
 *
 * `reference` resolves a reference as written in a talk against `baseDir` (the talk's folder): the
 * text as written first, then its percent-decoded form (editors write `Pasted%20image.png` for a
 * name with spaces). Both forms pass through the same check, so `%2e%2e%2f` gains nothing.
 *   → { ok: true, path, lexical }   `lexical` is the unresolved absolute path (its name and
 *                                    extension are the ones the author wrote).
 *   → { ok: false, reason }         "outside" if either form lands outside, else "missing".
 */
export function createAssetContainment(allowedRoots) {
  const roots = realRoots(allowedRoots);
  const file = async (candidate) => check(await roots, candidate);
  const reference = async (baseDir, written) => {
    if (typeof written !== "string" || typeof baseDir !== "string" || !isAbsolute(baseDir) || written.includes("\0")) {
      return { ok: false, reason: "outside" };
    }
    const forms = [written];
    try {
      const decoded = decodeURIComponent(written);
      if (decoded !== written && !decoded.includes("\0")) forms.push(decoded);
    } catch { /* not percent-encoded text: the written form only */ }
    let reason = "missing";
    for (const form of forms) {
      const lexical = resolve(baseDir, form);
      const result = await file(lexical);
      if (result.ok) return { ok: true, path: result.path, lexical };
      if (result.reason === "outside") reason = "outside";
    }
    return { ok: false, reason };
  };
  // How a refused reference is NAMED in a warning. A relative reference is shown as the author
  // wrote it. An ABSOLUTE path never is, in full: a warning travels with a shared build log, and an
  // absolute path spells out folders on this Mac (the app itself writes one in place of a pooled
  // id, `<vault>/_assets/img-….png`). Under an allowed root it is shown from that root
  // (`_assets/img-….png`); under no root, by its file name alone. Lexical only; nothing is looked up.
  const lexicalRoots = (Array.isArray(allowedRoots) ? allowedRoots : [])
    .filter((root) => typeof root === "string" && isAbsolute(root))
    .map((root) => resolve(root));
  const label = (written) => {
    const text = String(written ?? "");
    if (!isAbsolute(text)) return text;
    const lexical = resolve(text);
    for (const root of lexicalRoots) {
      if (lexical !== root && isInsideRealRoot(root, lexical)) return lexical.slice(root.endsWith(sep) ? root.length : root.length + 1);
    }
    return basename(lexical);
  };
  return { file, reference, label };
}
