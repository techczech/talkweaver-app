// How a media or embed reference is SHOWN in output (ADR-0036): the "Missing embed" placeholder, the
// phone text view, a player's file name. Output is published, so it must not spell out folders on
// the author's machine. Pure text, no node imports: safe wherever the compiler's renderers run.
//
//   - A plain relative reference that stays in the talk's folder (`assets/sim.html`) is shown as written.
//   - Anything else — an absolute path, a `..` climb out of the folder, a `file:` or other scheme, a
//     `//host` form, backslashes, or a percent-encoded spelling of any of these — is shown by its
//     file name alone.

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

function decoded(text) {
  try { return decodeURIComponent(text); } catch { return text; }
}

/** Does this relative path, read segment by segment, ever climb above where it started? */
function climbsOut(path) {
  let depth = 0;
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") { depth -= 1; if (depth < 0) return true; } else depth += 1;
  }
  return false;
}

function staysInTalkFolder(text) {
  if (!text || SCHEME_RE.test(text) || text.includes("\\") || text.startsWith("/") || /[\u0000-\u001f\u007f]/.test(text)) return false;
  return !climbsOut(text);
}

/** The last path segment, whichever slash is used and however it is encoded. Never a folder. */
export function referenceFileName(written) {
  const text = decoded(String(written ?? "")).replace(/[\u0000-\u001f\u007f]/g, "");
  const segments = text.split(/[\\/]+/).filter((segment) => segment && segment !== "." && segment !== "..");
  return segments.length ? segments[segments.length - 1] : "";
}

/** A local reference as it may be shown in output: as written inside the talk's folder, else its file name. */
export function shownReference(written) {
  const text = String(written ?? "");
  return staysInTalkFolder(text) && staysInTalkFolder(decoded(text)) ? text : referenceFileName(text);
}
