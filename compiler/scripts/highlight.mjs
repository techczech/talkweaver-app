// Build-time syntax highlighter — deterministic, dependency-free, OFFLINE.
//
// FOR ME (agent-facing). ADR-0014: the build is algorithmic and offline. Syntax colouring is
// part of the build, so it MUST run here at generation time and emit self-contained markup —
// token <span>s with stable classes — that the embedded stylesheet (presenter-popup-single-html
// .html) colours. There is NO runtime highlighter, NO CDN, NO network at build OR view time.
//
// Scope: a compact tokeniser for the languages Dominik listed — python, javascript/typescript,
// bash/shell, json, html/xml, css — plus a graceful no-op for unknown langs (escaped text, no
// spans). Correctness over completeness (the prompt's instruction): the goal is that keywords,
// strings, comments, numbers, and function/call names read as distinct colours on the dark code
// panel, not a full parser.
//
// Token classes (all colour-mapped in the template's "Code syntax theme" block):
//   tok-kw   keyword            tok-str  string / template literal
//   tok-com  comment            tok-num  number
//   tok-fn   function / call    tok-builtin  built-in / type / constant
//   tok-attr attribute / key    tok-tag  tag name / markup punctuation
//   tok-op   operator / punct (only emitted where it aids reading; otherwise left plain)
//
// Contract: highlightCode(text, lang) → HTML string safe to drop inside <code>…</code>. Every
// run of source text is HTML-escaped; spans only wrap escaped content. Unknown lang → escapeHtml
// (degrades gracefully, identical to the old plain panel).

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function span(cls, escapedText) {
  return `<span class="${cls}">${escapedText}</span>`;
}

// Normalise a fence tag to a known language family, or null for "unknown / no-op".
export function normaliseLang(lang) {
  const l = String(lang || "").trim().toLowerCase();
  if (!l) return null;
  const map = {
    py: "python", python: "python", python3: "python",
    js: "js", javascript: "js", jsx: "js", node: "js",
    ts: "js", typescript: "js", tsx: "js", // TS highlights well enough with the JS lexer
    sh: "shell", bash: "shell", shell: "shell", zsh: "shell", console: "shell", shellsession: "shell",
    json: "json", json5: "json", jsonc: "json",
    html: "markup", xml: "markup", svg: "markup", xhtml: "markup", vue: "markup",
    css: "css", scss: "css", less: "css",
  };
  return map[l] || null;
}

// ── Keyword / builtin tables ──────────────────────────────────────────────────────────────

const KEYWORDS = {
  python: new Set("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case".split(" ")),
  js: new Set("abstract any as async await break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in instanceof interface is keyof let new null of package private protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while with yield namespace module".split(" ")),
  shell: new Set("if then elif else fi for while until do done case esac function in select time coproc return break continue local export readonly declare set unset shift eval exec trap source alias".split(" ")),
};

const BUILTINS = {
  python: new Set("print len range int str float bool list dict set tuple type object Exception self super isinstance issubclass enumerate zip map filter open sorted sum min max abs all any input format repr getattr setattr hasattr".split(" ")),
  js: new Set("console window document Math JSON Object Array String Number Boolean Promise Map Set Symbol Date RegExp Error this require globalThis Infinity NaN".split(" ")),
  shell: new Set("echo cd ls cat grep sed awk cp mv rm mkdir rmdir touch chmod chown find sort uniq head tail wc curl wget git npm node python pip make sudo export env pwd kill ps tar gzip ssh scp".split(" ")),
};

// A run-based lexer for C-family-ish languages (python / js / shell). Walks the source once,
// emitting comment / string / number / keyword / builtin / function spans; everything else is
// escaped plaintext.
function lexCFamily(text, lang) {
  const kw = KEYWORDS[lang] || new Set();
  const bi = BUILTINS[lang] || new Set();
  const out = [];
  const n = text.length;
  let i = 0;

  // shell: a `#` only starts a comment at line start or after whitespace (not in $#, ${#a}).
  const lineCommentStart = lang === "python" ? "#" : lang === "shell" ? "#" : "//";

  function isIdentChar(c) { return /[A-Za-z0-9_$]/.test(c); }

  while (i < n) {
    const c = text[i];
    const rest = text.slice(i);

    // Comments
    if (lang === "js" && c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out.push(span("tok-com", escapeHtml(text.slice(i, stop))));
      i = stop;
      continue;
    }
    if (
      (lineCommentStart === "//" && c === "/" && text[i + 1] === "/") ||
      ((lineCommentStart === "#") && c === "#" && (i === 0 || /\s/.test(text[i - 1]) || text[i - 1] === ";"))
    ) {
      let end = text.indexOf("\n", i);
      if (end === -1) end = n;
      out.push(span("tok-com", escapeHtml(text.slice(i, end))));
      i = end;
      continue;
    }

    // Strings (single, double, backtick; python triple-quote)
    if (c === '"' || c === "'" || c === "`") {
      if ((c === '"' || c === "'") && text[i + 1] === c && text[i + 2] === c) {
        // triple-quoted (python) — runs to the matching triple
        const close = text.indexOf(c + c + c, i + 3);
        const stop = close === -1 ? n : close + 3;
        out.push(span("tok-str", escapeHtml(text.slice(i, stop))));
        i = stop;
        continue;
      }
      let j = i + 1;
      while (j < n && text[j] !== c) {
        if (text[j] === "\\") j += 2; else j += 1;
        // unterminated single/double string stops at newline (tolerant)
        if ((c === '"' || c === "'") && text[j] === "\n") break;
      }
      if (j < n && text[j] === c) j += 1;
      out.push(span("tok-str", escapeHtml(text.slice(i, j))));
      i = j;
      continue;
    }

    // Numbers
    if (/[0-9]/.test(c) && !(i > 0 && isIdentChar(text[i - 1]))) {
      const m = rest.match(/^(0[xXbBoO][0-9a-fA-F_]+|[0-9][0-9_]*\.?[0-9_]*(?:[eE][+-]?[0-9]+)?[jJlLfF]?)/);
      if (m) {
        out.push(span("tok-num", escapeHtml(m[0])));
        i += m[0].length;
        continue;
      }
    }

    // shell variables: $VAR, ${VAR}, $1
    if (lang === "shell" && c === "$") {
      const m = rest.match(/^\$\{[^}]*\}|^\$[A-Za-z_][A-Za-z0-9_]*|^\$[0-9@*#?$!-]/);
      if (m) {
        out.push(span("tok-builtin", escapeHtml(m[0])));
        i += m[0].length;
        continue;
      }
    }

    // Identifiers / keywords / builtins / function calls
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && isIdentChar(text[j])) j += 1;
      const word = text.slice(i, j);
      // is this a call? next non-space char is "("
      let k = j;
      while (k < n && (text[k] === " " || text[k] === "\t")) k += 1;
      const isCall = text[k] === "(";
      // python/js: a word after `def`/`function`/`class` is a definition name → function colour
      if (kw.has(word)) {
        out.push(span("tok-kw", escapeHtml(word)));
      } else if (bi.has(word)) {
        out.push(span("tok-builtin", escapeHtml(word)));
      } else if (isCall && lang !== "shell") {
        out.push(span("tok-fn", escapeHtml(word)));
      } else if (lang === "shell" && i === lineStartIndex(text, i) && isCall === false) {
        // first bare word on a shell line that isn't a keyword → treat as a command
        out.push(span("tok-fn", escapeHtml(word)));
      } else {
        out.push(escapeHtml(word));
      }
      i = j;
      continue;
    }

    // Default: a single character, escaped.
    out.push(escapeHtml(c));
    i += 1;
  }
  return out.join("");
}

// Index of the first non-space character on the line containing position `pos`.
function lineStartIndex(text, pos) {
  let ls = text.lastIndexOf("\n", pos - 1) + 1;
  while (ls < text.length && (text[ls] === " " || text[ls] === "\t")) ls += 1;
  return ls;
}

// ── JSON ────────────────────────────────────────────────────────────────────────────────────
// Keys (a string immediately followed by ':') get tok-attr; other strings tok-str.
function lexJson(text) {
  const out = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') { j += text[j] === "\\" ? 2 : 1; }
      if (j < n) j += 1;
      const strText = text.slice(i, j);
      let k = j;
      while (k < n && /\s/.test(text[k])) k += 1;
      out.push(span(text[k] === ":" ? "tok-attr" : "tok-str", escapeHtml(strText)));
      i = j;
      continue;
    }
    if (/[-0-9]/.test(c)) {
      const m = text.slice(i).match(/^-?[0-9][0-9.eE+\-]*/);
      if (m) { out.push(span("tok-num", escapeHtml(m[0]))); i += m[0].length; continue; }
    }
    const litMatch = text.slice(i).match(/^(true|false|null)\b/);
    if (litMatch) { out.push(span("tok-kw", litMatch[0])); i += litMatch[0].length; continue; }
    out.push(escapeHtml(c));
    i += 1;
  }
  return out.join("");
}

// ── HTML / XML markup ─────────────────────────────────────────────────────────────────────
function lexMarkup(text) {
  const out = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    // comment
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      const stop = end === -1 ? n : end + 3;
      out.push(span("tok-com", escapeHtml(text.slice(i, stop))));
      i = stop;
      continue;
    }
    if (text[i] === "<") {
      const end = text.indexOf(">", i);
      const stop = end === -1 ? n : end + 1;
      out.push(highlightTag(text.slice(i, stop)));
      i = stop;
      continue;
    }
    // text node up to the next tag
    let end = text.indexOf("<", i);
    if (end === -1) end = n;
    out.push(escapeHtml(text.slice(i, end)));
    i = end;
  }
  return out.join("");
}

function highlightTag(tag) {
  // tag is the raw "<...>" slice. Colour the angle brackets/slash, tag name, attributes, values.
  const inner = tag.replace(/^<\/?/, "").replace(/\/?>$/, "");
  const lead = tag.startsWith("</") ? "&lt;/" : "&lt;";
  const trail = tag.endsWith("/>") ? "/&gt;" : "&gt;";
  // split name + rest
  const m = inner.match(/^([A-Za-z][\w:-]*)([\s\S]*)$/);
  if (!m) return span("tok-tag", escapeHtml(tag));
  const name = m[1];
  let attrs = m[2];
  // attrs: name="value" pairs
  attrs = attrs.replace(/([\w:-]+)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)?/g, (whole, an, eq, av) => {
    const attrSpan = span("tok-attr", escapeHtml(an));
    if (av === undefined) return attrSpan;
    return `${attrSpan}${escapeHtml(eq)}${span("tok-str", escapeHtml(av))}`;
  });
  // any remaining stray text in attrs (whitespace) escape as-is
  return `${span("tok-tag", lead)}${span("tok-fn", escapeHtml(name))}${attrs ? " " + attrs.replace(/^\s+/, "") : ""}${span("tok-tag", trail)}`;
}

// ── CSS ──────────────────────────────────────────────────────────────────────────────────────
function lexCss(text) {
  const out = [];
  const n = text.length;
  let i = 0;
  let inBlock = false; // inside { } → property/value mode
  while (i < n) {
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out.push(span("tok-com", escapeHtml(text.slice(i, stop))));
      i = stop;
      continue;
    }
    const c = text[i];
    if (c === "{") { inBlock = true; out.push("{"); i += 1; continue; }
    if (c === "}") { inBlock = false; out.push("}"); i += 1; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c) { j += text[j] === "\\" ? 2 : 1; }
      if (j < n) j += 1;
      out.push(span("tok-str", escapeHtml(text.slice(i, j))));
      i = j;
      continue;
    }
    if (inBlock) {
      // property name up to ':'
      const propMatch = text.slice(i).match(/^([-A-Za-z]+)(\s*):/);
      if (propMatch && (i === lineStartIndex(text, i) || /[\s;{]/.test(text[i - 1] || ";"))) {
        out.push(span("tok-attr", escapeHtml(propMatch[1])) + escapeHtml(propMatch[2]) + ":");
        i += propMatch[0].length;
        continue;
      }
      const numMatch = text.slice(i).match(/^-?[0-9][0-9.]*(px|em|rem|%|vh|vw|s|ms|deg|fr|pt)?/);
      if (numMatch && /[0-9]/.test(numMatch[0])) {
        out.push(span("tok-num", escapeHtml(numMatch[0])));
        i += numMatch[0].length;
        continue;
      }
    } else {
      // selector context: at-rules and selectors
      if (c === "@") {
        const m = text.slice(i).match(/^@[\w-]+/);
        if (m) { out.push(span("tok-kw", escapeHtml(m[0]))); i += m[0].length; continue; }
      }
      const selMatch = text.slice(i).match(/^[.#]?[A-Za-z][\w-]*/);
      if (selMatch) { out.push(span("tok-fn", escapeHtml(selMatch[0]))); i += selMatch[0].length; continue; }
    }
    out.push(escapeHtml(c));
    i += 1;
  }
  return out.join("");
}

// Public entry point. Returns highlighted HTML (escaped + token spans). Unknown lang → plain
// escaped text (graceful degradation; identical to the old monospace panel).
export function highlightCode(text, lang) {
  const family = normaliseLang(lang);
  const src = String(text || "");
  if (!family) return escapeHtml(src);
  switch (family) {
    case "python":
    case "js":
    case "shell":
      return lexCFamily(src, family);
    case "json":
      return lexJson(src);
    case "markup":
      return lexMarkup(src);
    case "css":
      return lexCss(src);
    default:
      return escapeHtml(src);
  }
}
