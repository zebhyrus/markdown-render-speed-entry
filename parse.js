// A fast CommonMark 0.31.2 + GFM 0.29 parser whose parse(markdown) returns
// exactly the HTML marked 18.1.3 renders with its defaults.
// Dependency-free ES module. Written from the CommonMark/GFM specifications.

const SP = 32, TAB = 9, LF = 10, CR = 13, VT = 11, FF = 12;

// Document-level "inside a link" state, mirroring marked's Lexer state:
// an inline <a ...> opening tag sets it and a </a> clears it, and it
// persists across blocks for the whole document. While set, extended
// autolinks (scheme, www, email) do not fire; regular [...](...) links
// and <...> autolinks are unaffected. An <a> tag that is a standalone
// HTML block never reaches the inline tokenizer, so it does not set it.
let docInLink = false;

// ---------- character classes ----------
function isSpace(c) { return c === SP || c === TAB || c === LF || c === CR || c === VT || c === FF; }
function isDigit(c) { return c >= 48 && c <= 57; }
function isAlpha(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isAlnum(c) { return isAlpha(c) || isDigit(c); }
function isPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
         (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
// Unicode whitespace (for flanking checks): space, tab, LF, VT, FF, CR,
// NBSP and the Unicode space separators.
function isUnicodeSpace(c) {
  return isSpace(c) || c === 0x00a0 || (c >= 0x2000 && c <= 0x200a) ||
         c === 0x202f || c === 0x205f || c === 0x3000;
}
// Unicode punctuation (approximation used for flanking): ASCII punctuation
// plus the general punctuation ranges.
function isUnicodePunct(c) {
  if (isPunct(c)) return true;
  // Currency symbols (Unicode Sc) count as punctuation for flanking.
  if ((c >= 0x00a2 && c <= 0x00a5) || (c >= 0x20a0 && c <= 0x20cf)) return true;
  return (c >= 0x2000 && c <= 0x206f) || (c >= 0x2e00 && c <= 0x2e7f) ||
         (c >= 0x3001 && c <= 0x3003) || (c >= 0x3008 && c <= 0x3011) ||
         (c >= 0x3014 && c <= 0x301f) || (c >= 0xfe10 && c <= 0xfe1f) ||
         (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff01 && c <= 0xff0f) ||
         (c >= 0xff1a && c <= 0xff20) || (c >= 0xff3b && c <= 0xff40) ||
         (c >= 0xff5b && c <= 0xff65);
}
// Is the code unit an alphanumeric in the Unicode sense (approximation:
// ASCII alnum plus any non-ASCII letter/digit, which the spec counts as
// alphanumeric for flanking). Non-ASCII marks and symbols are not alnum.
function isUnicodeAlnum(c) {
  if (isAlnum(c)) return true;
  if (c < 128) return false;
  // Letters: most non-ASCII letters live in these ranges; combining marks
  // and symbols are excluded by treating only letter ranges as alnum.
  return (c >= 0x00aa && c <= 0x00aa) || (c >= 0x00b5 && c <= 0x00b5) ||
         (c >= 0x00ba && c <= 0x00ba) || (c >= 0x00bc && c <= 0x00ff && c !== 0x00d7 && c !== 0x00f7) ||
         (c >= 0x0100 && c <= 0x02ff && c !== 0x02c2 && c !== 0x02c3 && c !== 0x02c4 && c !== 0x02c5) ||
         (c >= 0x0370 && c <= 0x167f) || (c >= 0x1681 && c <= 0x180d) ||
         (c >= 0x18b0 && c <= 0x1fff) || (c >= 0x2000 && c <= 0x2fff && false) ||
         (c >= 0x3041 && c <= 0x309f) || (c >= 0x30a0 && c <= 0x30ff) ||
         (c >= 0x3100 && c <= 0x312f) || (c >= 0x3130 && c <= 0x318f) ||
         (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) ||
         (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) ||
         (c >= 0x20000 && c <= 0x2fa1f);
}

// ---------- HTML escaping ----------
function escapeText(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 && s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (i > start) out += s.slice(start, i);
      out += c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
      start = i + 1;
    }
  }
  if (start < s.length) out += s.slice(start);
  return out;
}

function escapeAttr(s) {
  if (s.indexOf('&') === -1 && s.indexOf('"') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      // A valid entity reference stays literal in an attribute value.
      if (decodeEntityAt(s, i)) continue;
      if (i > start) out += s.slice(start, i);
      out += '&amp;';
      start = i + 1;
    } else if (c === 34 || c === 60 || c === 62) {
      if (i > start) out += s.slice(start, i);
      out += c === 34 ? '&quot;' : c === 60 ? '&lt;' : '&gt;';
      start = i + 1;
    }
  }
  if (start < s.length) out += s.slice(start);
  return out;
}

// Percent-encode a URL the way a browser's encodeURI does, keeping a
// literal % as % (so 98% stays 98% and an already-encoded %20 stays %20).
function cleanUrl(url) {
  let u;
  try { u = encodeURI(url).replace(/%25/g, '%'); } catch { return ''; }
  return escapeAttr(u);
}

// ---------- entities ----------
// Named character references (HTML5). A subset covering the names the
// CommonMark/GFM examples and generated documents use, plus the common
// Latin, Greek, punctuation and math names.
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  iexcl: '¡', cent: '¢', pound: '£', curren: '¤', yen: '¥', brvbar: '¦',
  sect: '§', uml: '¨', copy: '©', ordf: 'ª', laquo: '«', not: '¬',
  shy: '­', reg: '®', macr: '¯', deg: '°', plusmn: '±', sup2: '²',
  sup3: '³', acute: '´', micro: 'µ', para: '¶', middot: '·', cedil: '¸',
  sup1: '¹', ordm: 'º', raquo: '»', frac14: '¼', frac12: '½', frac34: '¾',
  iquest: '¿', Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä',
  Aring: 'Å', AElig: 'Æ', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É', Ecirc: 'Ê',
  Euml: 'Ë', Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï', ETH: 'Ð',
  Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö',
  times: '×', Oslash: 'Ø', Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü',
  Yacute: 'Ý', THORN: 'Þ', szlig: 'ß', agrave: 'à', aacute: 'á', acirc: 'â',
  atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç', egrave: 'è',
  eacute: 'é', ecirc: 'ê', euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î',
  iuml: 'ï', eth: 'ð', ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô',
  otilde: 'õ', ouml: 'ö', divide: '÷', oslash: 'ø', ugrave: 'ù', uacute: 'ú',
  ucirc: 'û', uuml: 'ü', yacute: 'ý', thorn: 'þ', yuml: 'ÿ',
  Amacr: 'Ā', amacr: 'ā', Abreve: 'Ă', abreve: 'ă', Aogon: 'Ą', aogon: 'ą',
  Cacute: 'Ć', cacute: 'ć', Ccaron: 'Č', ccaron: 'č', Dcaron: 'Ď', dcaron: 'ď',
  Emacr: 'Ē', emacr: 'ē', Edot: 'Ė', edot: 'ė', Eogon: 'Ę', eogon: 'ę',
  Ecaron: 'Ě', ecaron: 'ě', Gbreve: 'Ğ', gbreve: 'ğ', Gdot: 'Ġ', gdot: 'ġ',
  Hcirc: 'Ĥ', hcirc: 'ĥ', Hstrok: 'Ħ', hstrok: 'ħ', Idot: 'İ', imacr: 'ī',
  Imacr: 'Ī', imath: 'ı', Iogon: 'Į', iogon: 'į', Jcirc: 'Ĵ', jcirc: 'ĵ',
  Kcedil: 'Ķ', kcedil: 'ķ', Lacute: 'Ĺ', lacute: 'ĺ', Lcaron: 'Ľ', lcaron: 'ľ',
  Lmidot: 'Ŀ', lmidot: 'ŀ', Lstrok: 'Ł', lstrok: 'ł', Nacute: 'Ń', nacute: 'ń',
  Ncaron: 'Ň', ncaron: 'ň', Ncedil: 'Ņ', ncedil: 'ņ', Omacr: 'Ō', omacr: 'ō',
  Odblac: 'Ő', odblac: 'ő', OElig: 'Œ', oelig: 'œ', Racute: 'Ŕ', racute: 'ŕ',
  Rcaron: 'Ř', rcaron: 'ř', Rcedil: 'Ŗ', rcedil: 'ŗ', Sacute: 'Ś', sacute: 'ś',
  Scirc: 'Ŝ', scirc: 'ŝ', Scedil: 'Ş', scedil: 'ş', Scaron: 'Š', scaron: 'š',
  Tcaron: 'Ť', tcaron: 'ť', Tcedil: 'Ţ', tcedil: 'ţ', Tstrok: 'Ŧ', tstrok: 'ŧ',
  Ubreve: 'Ŭ', ubreve: 'ŭ', Uring: 'Ů', uring: 'ů', Umacr: 'Ū', umacr: 'ū',
  Uogon: 'Ų', uogon: 'ų', Wcirc: 'Ŵ', wcirc: 'ŵ', Ycirc: 'Ŷ', ycirc: 'ŷ',
  Yuml: 'Ÿ', Zacute: 'Ź', zacute: 'ź', Zdot: 'Ż', zdot: 'ż', Zcaron: 'Ž',
  zcaron: 'ž', fnof: 'ƒ', circ: 'ˆ', tilde: '˜',
  Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Epsilon: 'Ε', Zeta: 'Ζ',
  Eta: 'Η', Theta: 'Θ', Iota: 'Ι', Kappa: 'Κ', Lambda: 'Λ', Mu: 'Μ',
  Nu: 'Ν', Xi: 'Ξ', Omicron: 'Ο', Pi: 'Π', Rho: 'Ρ', Sigma: 'Σ', Tau: 'Τ',
  Upsilon: 'Υ', Phi: 'Φ', Chi: 'Χ', Psi: 'Ψ', Omega: 'Ω',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ',
  eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ',
  nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ', sigmaf: 'ς',
  sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ',
  omega: 'ω', thetasym: 'ϑ', upsih: 'ϒ', piv: 'ϖ',
  ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '‌', zwj: '‍', lrm: '‎',
  rlm: '‏', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', sbquo: '‚',
  ldquo: '“', rdquo: '”', bdquo: '„', dagger: '†', Dagger: '‡', bull: '•',
  hellip: '…', permil: '‰', prime: '′', Prime: '″', lsaquo: '‹', rsaquo: '›',
  oline: '‾', frasl: '⁄', euro: '€', image: 'ℑ', weierp: '℘', real: 'ℜ',
  trade: '™', alefsym: 'ℵ', larr: '←', uarr: '↑', rarr: '→', darr: '↓',
  harr: '↔', crarr: '↵', lArr: '⇐', uArr: '⇑', rArr: '⇒', dArr: '⇓',
  hArr: '⇔', forall: '∀', part: '∂', exist: '∃', empty: '∅', nabla: '∇',
  isin: '∈', notin: '∉', ni: '∋', prod: '∏', sum: '∑', minus: '−',
  lowast: '∗', radic: '√', prop: '∝', infin: '∞', ang: '∠', and: '∧',
  or: '∨', cap: '∩', cup: '∪', int: '∫', there4: '∴', sim: '∼',
  cong: '≅', asymp: '≈', ne: '≠', equiv: '≡', le: '≤', ge: '≥', sub: '⊂',
  sup: '⊃', nsub: '⊄', sube: '⊆', supe: '⊇', oplus: '⊕', otimes: '⊗',
  perp: '⊥', sdot: '⋅', lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋',
  lang: '〈', rang: '〉', loz: '◊', spades: '♠', clubs: '♣', hearts: '♥',
  diams: '♦', HilbertSpace: 'ℋ', DifferentialD: 'ⅆ', ClockwiseContourIntegral: '∲',
  ngE: '≧̸', Tab: '\t', NewLine: '\n', colon: ':', comma: ',', period: '.',
  sol: '/', bsol: '\\', semi: ';', equals: '=', quest: '?', commat: '@',
  period2: '.', check: '✓', cross: '✗',
};

// ---------- entity decoding ----------
// Try to decode an entity reference starting at s[i] ('&').
// Returns [decoded, nextIndex] or null when s[i] is not a valid reference.
function decodeEntityAt(s, i) {
  const n = s.length;
  if (i + 1 >= n) return null;
  const c1 = s.charCodeAt(i + 1);
  if (c1 === 35) { // '#'
    let j = i + 2;
    let hex = false;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
    const start = j;
    let code = 0;
    let digits = 0;
    while (j < n) {
      const c = s.charCodeAt(j);
      let d = -1;
      if (c >= 48 && c <= 57) d = c - 48;
      else if (hex && c >= 97 && c <= 102) d = c - 87;
      else if (hex && c >= 65 && c <= 70) d = c - 55;
      else break;
      code = code * (hex ? 16 : 10) + d;
      if (code > 0x10ffff) { /* keep scanning to find the ';' */ }
      digits++;
      j++;
    }
    if (digits === 0 || j >= n || s.charCodeAt(j) !== 59) return null;
    if ((hex && digits > 6) || (!hex && digits > 7)) return null;
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) code = 0xfffd;
    return [String.fromCodePoint(code), j + 1];
  }
  if (!isAlpha(c1)) return null;
  let j = i + 1;
  while (j < n && j < i + 33) {
    const c = s.charCodeAt(j);
    if (c === 59) {
      const name = s.slice(i + 1, j);
      const v = ENTITIES[name];
      if (v !== undefined) return [v, j + 1];
      return null;
    }
    if (!isAlnum(c)) return null;
    j++;
  }
  return null;
}

// Decode entities and backslash escapes in a raw string (used for link
// destinations and titles, which are collected raw and decoded at use).
function decodeRaw(s) {
  if (s.indexOf('&') === -1 && s.indexOf('\\') === -1) return s;
  let out = '';
  let start = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      // A named reference (&name;) passes through literally; only numeric
      // references are decoded here.
      if (i + 1 < n && isAlpha(s.charCodeAt(i + 1))) {
        let k = i + 1;
        while (k < n && isAlnum(s.charCodeAt(k))) k++;
        if (k < n && s.charCodeAt(k) === 59) { i = k + 1; continue; }
      }
      const d = decodeEntityAt(s, i);
      if (d) {
        if (i > start) out += s.slice(start, i);
        out += d[0];
        i = d[1];
        start = i;
        continue;
      }
      i++;
    } else if (c === 92 && i + 1 < n && isPunct(s.charCodeAt(i + 1))) {
      if (i > start) out += s.slice(start, i);
      out += s[i + 1];
      i += 2;
      start = i;
    } else {
      i++;
    }
  }
  if (start < n) out += s.slice(start);
  return out;
}

// Normalize a link label: collapse internal whitespace (including line
// endings) to single spaces, trim, and case-fold.
function normalizeLabel(s) {
  let out = '';
  let pendingSpace = false;
  let started = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isSpace(c)) {
      if (started) pendingSpace = true;
    } else {
      if (pendingSpace) { out += ' '; pendingSpace = false; }
      // Unicode case folding: sharp s folds to "ss".
      if (c === 223 || c === 7838) out += 'ss';
      else out += s[i];
      started = true;
    }
  }
  return out.toLowerCase();
}

// ---------- inline parsing ----------
// The inline parser scans a paragraph's text once, building an array of
// output parts (strings) and a list of emphasis delimiters. Links, code
// spans, autolinks and raw HTML are resolved during the scan; emphasis
// and strikethrough are resolved afterwards over the delimiter list.

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'meta', 'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param',
  'section', 'source', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'title', 'tr', 'track', 'ul',
]);

// Parse a link destination starting at s[i] (after '(' or after ':' in a
// definition). Returns [rawDest, nextIndex] or null. Whitespace before the
// destination must already be skipped by the caller.
function parseDestination(s, i) {
  const n = s.length;
  if (i >= n) return null;
  if (s.charCodeAt(i) === 60) { // '<'
    let j = i + 1;
    let out = '';
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 62) return [out, j + 1]; // '>'
      if (c === 10 || c === 60) return null; // newline or '<' not allowed
      if (c === 92 && j + 1 < n && isPunct(s.charCodeAt(j + 1))) { out += s[j + 1]; j += 2; continue; }
      out += s[j];
      j++;
    }
    return null;
  }
  // Bare destination: no spaces or control chars, balanced parens.
  let j = i;
  let out = '';
  let depth = 0;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 13) break;
    if (c < 32) return null;
    if (c === 40) { depth++; out += s[j]; j++; continue; } // '('
    if (c === 41) { // ')'
      if (depth === 0) break;
      depth--; out += s[j]; j++; continue;
    }
    if (c === 92 && j + 1 < n && isPunct(s.charCodeAt(j + 1))) { out += s[j + 1]; j += 2; continue; }
    out += s[j];
    j++;
  }
  if (j === i) return null; // empty destination
  if (depth !== 0) return null; // unbalanced parens
  return [out, j];
}

// Parse a link title starting at s[i] (after the destination and spaces).
// Returns [rawTitle, nextIndex] or null when there is no title here.
function parseTitle(s, i) {
  const n = s.length;
  if (i >= n) return null;
  const c = s.charCodeAt(i);
  let close;
  if (c === 34) close = 34; // '"'
  else if (c === 39) close = 39; // "'"
  else if (c === 40) close = 41; // '(' ... ')'
  else return null;
  let j = i + 1;
  let out = '';
  while (j < n) {
    const ch = s.charCodeAt(j);
    if (ch === close) {
      if (close === 41 && ch === 41) return [out, j + 1];
      if (close !== 41) return [out, j + 1];
    }
    if (close === 41 && ch === 40) return null; // '(' not allowed inside (title)
    if (ch === 92 && j + 1 < n && isPunct(s.charCodeAt(j + 1))) { out += s[j + 1]; j += 2; continue; }
    out += s[j];
    j++;
  }
  return null;
}

// Skip spaces/tabs/newlines; returns the first index at or after i that
// is not whitespace, or n.
function skipSpace(s, i) {
  const n = s.length;
  while (i < n && isSpace(s.charCodeAt(i))) i++;
  return i;
}

// Try to parse a link label starting at s[i] ('['). Returns
// [label, nextIndex] where nextIndex is just past the closing ']', or null.
// The label may contain balanced brackets and runs of whitespace (which
// are kept raw here; normalization happens at lookup).
function parseLabel(s, i) {
  const n = s.length;
  let j = i + 1;
  let out = '';
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 93) { // ']': a label ends at the first unescaped ']'
      if (out.length > 999) return null;
      return [out, j + 1];
    }
    if (c === 91) return null; // an unescaped '[' cannot appear in a label
    if (c === 92 && j + 1 < n && isPunct(s.charCodeAt(j + 1))) { out += s[j] + s[j + 1]; j += 2; continue; }
    if (c === 10) { out += s[j]; j++; continue; }
    out += s[j];
    j++;
  }
  return null;
}

// ---------- the inline scanner ----------
const INLINE_SPECIAL = /[*_`\[\]<>&\\!~\nw@:]/g;

// Extract the plain text of parts[from..to) for an image's alt attribute:
// HTML tags are dropped, the remaining entities are decoded.
function plainTextOfParts(parts, from, to, delims) {
  let s = '';
  const skip = new Set();
  if (delims) for (const d of delims) if (d.part >= from && d.part < to) skip.add(d.part);
  for (let k = from; k < to; k++) {
    if (!skip.has(k)) s += parts[k];
  }
  if (s.indexOf('<') === -1 && s.indexOf('&') === -1) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 60) { // '<': skip a tag, honouring quoted attribute values
      // A nested image contributes its alt text.
      if (s.slice(i, i + 4).toLowerCase() === '<img') {
        const m = /alt="([^"]*)"|alt='([^']*)'/.exec(s.slice(i, i + 200));
        if (m) out += decodeRaw(m[1] !== undefined ? m[1] : m[2]);
      }
      let j = i + 1;
      let quote = 0;
      while (j < n) {
        const d = s.charCodeAt(j);
        if (quote === 0 && (d === 34 || d === 39)) quote = d;
        else if (quote !== 0 && d === quote) quote = 0;
        else if (quote === 0 && d === 62) break;
        j++;
      }
      i = j < n ? j + 1 : n;
      continue;
    }
    if (c === 38) {
      const d = decodeEntityAt(s, i);
      if (d) { out += d[0]; i = d[1]; continue; }
      out += '&';
      i++;
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

// Opener-driven forward scan, mirroring how marked counts delimiters
// from an opener toward a closer. The opener must cover its own length
// plus every inner opener-only delimiter (each adds its length), while
// inner plain closers subtract theirs; an inner delimiter that can both
// open and close is skipped into the odd-match accumulation when
// (openerLen + itsLen) is a multiple of 3 (it then does not reduce the
// count). When the count is still positive after the closer, the closer
// cannot cover the opener, so the emphasis does not form (this is why
// "*a **b**c*" stays literal: the inner "**" opener adds 2, its closer
// is odd-matched away, and the final single "*" cannot cover 3).
function openerCanClose(delims, oi, ci) {
  const opener = delims[oi];
  const y = opener.len;
  let m = y;
  for (let j = oi + 1; j <= ci; j++) {
    const d = delims[j];
    if (d.ch !== opener.ch) continue;
    if (d.link !== opener.link) continue;
    const b = d.len;
    if (d.canOpen && !d.canClose) {
      m += b;
    } else if (d.canOpen && d.canClose) {
      if (y % 3 !== 0 && (y + b) % 3 === 0) continue;
      m -= b;
    } else if (!d.canOpen && d.canClose) {
      m -= b;
    } else {
      continue;
    }
    if (m <= 0) return true;
  }
  return false;
}

function resolveEmphasis(parts, delims) {
  // Delimiters inside a formed emphasis span are tagged with a fresh link
  // id, so they can only match each other, never a delimiter outside the
  // span (this is what keeps '_bar' literal in '*foo _bar* baz_').
  let linkSeq = 1000000;
  // The last delimiter consumed as a closer to form emphasis; when it
  // could also open, a following single closer does not steal one
  // delimiter from a '**' opener (so '**a *b*c* d**' forms <strong>,
  // while '**a *b* c* d**' nests <em>s).
  let lastCloserCanOpen = false;
  let lastCloserUsed = false;
  for (let ci = 0; ci < delims.length; ci++) {
    const closer = delims[ci];
    if (!closer.active || !closer.canClose) continue;
    for (let oi = ci - 1; oi >= 0; oi--) {
      const opener = delims[oi];
      if (!opener.active || !opener.canOpen) continue;
      if (opener.ch !== closer.ch) continue;
      if (opener.link !== closer.link) continue;
      if (opener.canClose || closer.canOpen) {
        const sum = opener.len + closer.len;
        if (sum % 3 === 0 && (opener.len % 3 !== 0 || closer.len % 3 !== 0)) continue;
      }
      // Opener-driven counting: when an inner opener-only delimiter
      // sits between this opener and closer, the closer must cover
      // the opener plus those inner openers; otherwise the emphasis
      // does not form.
      {
        let innerOpener = false;
        for (let k = oi + 1; k < ci; k++) {
          const d = delims[k];
          if (d.ch === closer.ch && d.canOpen && !d.canClose) { innerOpener = true; break; }
        }
        if (innerOpener && !openerCanClose(delims, oi, ci)) continue;
      }
      const oLeft = opener.len - opener.used;
      const cLeft = closer.len - closer.used;
      // Do not let a single closer take one delimiter from a '**'
      // opener when the last inner closer could also open: the later
      // '**' closer should form <strong> with it instead.
      if (oLeft === 2 && cLeft === 1 && lastCloserUsed && lastCloserCanOpen) {
        let laterStrong = false;
        for (let k = ci + 1; k < delims.length; k++) {
          if (delims[k].active && delims[k].canClose && delims[k].ch === closer.ch && delims[k].len - delims[k].used >= 2) { laterStrong = true; break; }
        }
        if (laterStrong) continue;
      }
      const use = oLeft >= 2 && cLeft >= 2 ? 2 : 1;
      if (opener.ch === 126) {
        opener.openTags.push('<del>');
        closer.closeTags.push('</del>');
      } else if (use === 2) {
        opener.openTags.push('<strong>');
        closer.closeTags.push('</strong>');
      } else {
        opener.openTags.push('<em>');
        closer.closeTags.push('</em>');
      }
      opener.used += use;
      closer.used += use;
      lastCloserCanOpen = closer.canOpen;
      lastCloserUsed = true;
      const lid = linkSeq++;
      for (let d = oi + 1; d < ci; d++) delims[d].link = lid;
      if (opener.used >= opener.len) opener.active = false;
      if (closer.used >= closer.len) { closer.active = false; break; }
      // If both still have delimiters left, retry the same opener (a run
      // like *** can form <em><strong> with one closer).
      if (opener.used < opener.len && closer.used < closer.len) oi++;
    }
  }
  for (const d of delims) {
    if (d.used === 0) continue;
    const ch = String.fromCharCode(d.ch);
    let s = '';
    for (let k = 0; k < d.closeTags.length; k++) s += d.closeTags[k];
    const left = d.len - d.used;
    for (let k = 0; k < left; k++) s += ch;
    for (let k = d.openTags.length - 1; k >= 0; k--) s += d.openTags[k];
    parts[d.part] = s;
  }
}

// Returns true when the innermost active '[' opener cannot form a link,
// so an autolink inside its label text may still fire. A link forms only
// when the label's ']' is followed by a valid inline destination or by a
// reference label defined in refs; otherwise the bracketed text stays
// literal and any URL inside it is autolinked.
function openerCannotLink(s, openers, refs) {
  let op = null;
  for (let k = openers.length - 1; k >= 0; k--) {
    if (openers[k].active) { op = openers[k]; break; }
  }
  if (!op || op.image) return false;
  const n = s.length;
  let j = op.src;
  while (j < n) {
    const ch = s.charCodeAt(j);
    if (ch === 96) {
      let k = j;
      while (k < n && s.charCodeAt(k) === 96) k++;
      const run = k - j;
      let p = k, found = -1;
      while (p < n) {
        if (s.charCodeAt(p) === 96) {
          let q = p;
          while (q < n && s.charCodeAt(q) === 96) q++;
          if (q - p === run) { found = q; break; }
          p = q;
        } else p++;
      }
      if (found === -1) return false;
      j = found;
      continue;
    }
    if (ch === 92 && j + 1 < n) { j += 2; continue; }
    if (ch === 93) break;
    j++;
  }
  if (j >= n) return false;
  const after = j + 1;
  if (after < n && s.charCodeAt(after) === 40) return false;
  if (after < n && s.charCodeAt(after) === 91) {
    const lab = parseLabel(s, after);
    if (!lab) return true;
    const key = lab[0].length === 0
      ? normalizeLabel(s.slice(op.src, j))
      : normalizeLabel(lab[0]);
    return !refs.get(key);
  }
  return !refs.get(normalizeLabel(s.slice(op.src, j)));
}

// Parse the inline content of one block (a paragraph, heading or table
// cell). refs maps normalized labels to {href, title}.
function inlineParse(s, refs) {
  const n = s.length;
  if (!INLINE_SPECIAL.test(s) && s.indexOf(' \n') === -1 && s.indexOf('\t\n') === -1) {
    return escapeText(s);
  }
  INLINE_SPECIAL.lastIndex = 0;
  const parts = [];
  const delims = [];
  const openers = [];
  let linkSeq = 0;
  let i = 0;
  let textStart = 0;

  function flushText(to) {
    if (to > textStart) parts.push(escapeText(s.slice(textStart, to)));
  }

  let m;
  while ((m = INLINE_SPECIAL.exec(s)) !== null) {
    i = m.index;
    const c = s.charCodeAt(i);
    if (c === 10) { // line ending: soft break, or hard break on 2+ spaces
      let k = i;
      let spaces = 0;
      while (k > textStart && s.charCodeAt(k - 1) === 32) { k--; spaces++; }
      if (spaces >= 2) {
        flushText(k);
        parts.push('<br>');
        // A hard break starts a fresh line: leading spaces are stripped.
        i++;
        while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
        textStart = i;
      } else {
        // A soft break keeps a single trailing space before the newline.
        flushText(i);
        parts.push('\n');
        i++;
        textStart = i;
      }
      INLINE_SPECIAL.lastIndex = i;
      continue;
    }
    if (c === 92) { // backslash
      if (i + 1 < n) {
        const d = s.charCodeAt(i + 1);
        if (d === 10) {
          flushText(i);
          parts.push('<br>');
          i += 2;
          while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
          textStart = i;
          INLINE_SPECIAL.lastIndex = i;
          continue;
        }
        if (isPunct(d)) {
          flushText(i);
          parts.push(escapeText(s[i + 1]));
          i += 2;
          textStart = i;
          INLINE_SPECIAL.lastIndex = i;
          continue;
        }
      }
      i++;
      INLINE_SPECIAL.lastIndex = i;
      continue;
    }
    if (c === 96) { // code span
      let k = i;
      while (k < n && s.charCodeAt(k) === 96) k++;
      const runLen = k - i;
      let found = -1;
      let j = s.indexOf('`', k);
      while (j !== -1) {
        let e = j;
        while (e < n && s.charCodeAt(e) === 96) e++;
        if (e - j === runLen) { found = j; break; }
        j = s.indexOf('`', e);
      }
      if (found !== -1) {
        // A backtick run that closes a label code span (an earlier
        // backtick run + non-backtick content + this run, as in the
        // reference's link-label pattern) is a closer, not a new code
        // span opener: when a link opener is active and the unflushed
        // text already holds a backtick run, this run only closes that
        // span, so the link's ']' stays reachable. Likewise, a run that
        // opens such a label span (its same-length closer lies past the
        // link's ']', while a different-length backtick run sits before
        // that ']') is a label opener, not a real code span opener.
        let hasOpener = false;
        for (let q = 0; q < openers.length; q++) if (openers[q].active) { hasOpener = true; break; }
        if (hasOpener && s.indexOf('`', textStart) !== -1 && s.indexOf('`', textStart) < i) found = -1;
        if (found !== -1 && hasOpener) {
          const closeBracket = s.indexOf(']', k);
          if (closeBracket !== -1 && closeBracket < found &&
              s.indexOf('`', k) !== -1 && s.indexOf('`', k) < closeBracket) found = -1;
        }
      }
      if (found === -1) { i = k; INLINE_SPECIAL.lastIndex = i; continue; }
      let content = s.slice(k, found);
      if (content.indexOf('\n') !== -1) content = content.split('\n').join(' ');
      if (content.length >= 2 && content.charCodeAt(0) === 32 &&
          content.charCodeAt(content.length - 1) === 32 && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      flushText(i);
      parts.push('<code>' + escapeText(content) + '</code>');
      i = found + runLen;
      textStart = i;
      INLINE_SPECIAL.lastIndex = i;
      continue;
    }
    if (c === 42 || c === 95 || c === 126) { // *, _, ~ delimiter runs
      let k = i;
      while (k < n && s.charCodeAt(k) === c) k++;
      const runLen = k - i;
      if (c === 126 && runLen > 2) { i = k; INLINE_SPECIAL.lastIndex = i; continue; }
      const before = i > 0 ? s.charCodeAt(i - 1) : 32;
      const after = k < n ? s.charCodeAt(k) : 32;
      const beforeSpace = isUnicodeSpace(before);
      const afterSpace = isUnicodeSpace(after);
      const beforePunct = isUnicodePunct(before);
      const afterPunct = isUnicodePunct(after);
      const leftFlanking = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
      const rightFlanking = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
      let canOpen, canClose;
      if (c === 95) {
        canOpen = leftFlanking && (!rightFlanking || beforePunct);
        canClose = rightFlanking && (!leftFlanking || afterPunct);
      } else {
        canOpen = leftFlanking;
        canClose = rightFlanking;
      }
      if (!canOpen && !canClose) { i = k; INLINE_SPECIAL.lastIndex = i; continue; }
      flushText(i);
      parts.push(s.slice(i, k));
      delims.push({
        ch: c, part: parts.length - 1, len: runLen, canOpen, canClose,
        link: 0, active: true, tags: [], openTags: [], closeTags: [], used: 0,
      });
      i = k;
      textStart = i;
      INLINE_SPECIAL.lastIndex = i;
      continue;
    }
    if (c === 38) { // entity
      // A named reference (&name;) passes through literally, whether or
      // not the name is defined; only numeric references are decoded.
      if (i + 1 < n && isAlpha(s.charCodeAt(i + 1))) {
        let k = i + 1;
        while (k < n && isAlnum(s.charCodeAt(k))) k++;
        if (k < n && s.charCodeAt(k) === 59) {
          flushText(i);
          parts.push(s.slice(i, k + 1));
          i = k + 1;
          textStart = i;
          INLINE_SPECIAL.lastIndex = i;
          continue;
        }
      }
      const d = decodeEntityAt(s, i);
      if (d) {
        flushText(i);
        parts.push(escapeText(d[0]));
        i = d[1];
        textStart = i;
        INLINE_SPECIAL.lastIndex = i;
        continue;
      }
      i++;
      INLINE_SPECIAL.lastIndex = i;
      continue;
    }
    if (c === 60) { // '<': autolink or raw HTML
      const tagEnd = parseHtmlTag(s, i);
      if (tagEnd !== -1) {
        // An inline <a ...> opening tag sets the document-level inLink
        // state (marked's startATag is /^<a /i); a </a> clears it
        // (endATag is /^<\/a>/i). The state persists across blocks.
        const a0 = s.charCodeAt(i + 1);
        if ((a0 === 97 || a0 === 65) && i + 2 < tagEnd && s.charCodeAt(i + 2) === 32) docInLink = true;
        else if (a0 === 47 && i + 3 < tagEnd &&
                 (s.charCodeAt(i + 2) === 97 || s.charCodeAt(i + 2) === 65) &&
                 s.charCodeAt(i + 3) === 62) docInLink = false;
        flushText(i);
        parts.push(s.slice(i, tagEnd));
        i = tagEnd;
        textStart = i;
        INLINE_SPECIAL.lastIndex = i;
        continue;
      }
      const gt = s.indexOf('>', i + 1);
      if (gt !== -1 && gt > i + 1) {
        const inner = s.slice(i + 1, gt);
        let ok = true;
        for (let p = 0; p < inner.length; p++) {
          const ch = inner.charCodeAt(p);
          if (ch === 32 || ch === 9 || ch === 10 || ch === 60 || ch < 32) { ok = false; break; }
        }
        if (ok) {
          const sm = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.exec(inner);
          if (sm) {
            flushText(i);
            parts.push('<a href="' + cleanUrl(inner) + '">' + escapeText(inner) + '</a>');
            i = gt + 1;
            textStart = i;
            INLINE_SPECIAL.lastIndex = i;
            continue;
          }
          if (EMAIL_RE.test(inner)) {
            flushText(i);
            parts.push('<a href="mailto:' + escapeAttr(inner) + '">' + escapeText(inner) + '</a>');
            i = gt + 1;
            textStart = i;
            INLINE_SPECIAL.lastIndex = i;
            continue;
          }
        }
      }
      i++;
      INLINE_SPECIAL.lastIndex = i;
      continue;
    }
    if (c === 33 && i + 1 < n && s.charCodeAt(i + 1) === 91) { // '!['
      flushText(i);
      parts.push('![');
      openers.push({ part: parts.length - 1, image: true, active: true, d0: delims.length, src: i + 2 });
      i += 2;
      textStart = i;
      INLINE_SPECIAL.lastIndex = i;
      continue;
    }
    if (c === 91) { // '['
      flushText(i);
      parts.push('[');
      openers.push({ part: parts.length - 1, image: false, active: true, d0: delims.length, src: i + 1 });
      i++;
      textStart = i;
      INLINE_SPECIAL.lastIndex = i;
      continue;
    }
    if (c === 93) { // ']' : try to close a link or image
      // The nearest opener that is active or blocked owns this ']'. An
      // opener blocked by a link formed inside it consumes the ']' as
      // literal text; an inactive-but-unblocked opener is skipped.
      let oi = -1;
      for (let k = openers.length - 1; k >= 0; k--) {
        if (openers[k].active || openers[k].blocked) { oi = k; break; }
      }
      if (oi === -1) { i++; INLINE_SPECIAL.lastIndex = i; continue; }
      const op = openers[oi];
      if (op.blocked) {
        openers.splice(oi, 1);
        i++;
        INLINE_SPECIAL.lastIndex = i;
        continue;
      }
      const partsBefore = parts.length;
      const textStartBefore = textStart;
      flushText(i);
      const formed = tryCloseLink(s, i, op, parts, delims, openers, refs, () => ++linkSeq);
      if (formed !== -1) {
        i = formed;
        textStart = i;
        INLINE_SPECIAL.lastIndex = i;
        openers.splice(oi, 1);
        continue;
      }
      // No link: undo the flush so the text is not duplicated.
      parts.length = partsBefore;
      textStart = textStartBefore;
      op.active = false;
      i++;
      INLINE_SPECIAL.lastIndex = i;
      continue;
    }
    if (c === 119) { // 'w': extended www autolink
      // No autolink inside link text (local openers or the document-level
      // inLink state set by an inline <a> tag), unless the innermost
      // opener cannot form a link, in which case the URL still autolinks.
      let inLink = docInLink;
      for (let k = 0; k < openers.length; k++) if (openers[k].active) { inLink = true; break; }
      if (inLink && !docInLink && openerCannotLink(s, openers, refs)) inLink = false;
      if (!inLink && s.startsWith('www.', i)) {
        const before = i > 0 ? s.charCodeAt(i - 1) : 32;
        if (i === 0 || isSpace(before) || before === 42 || before === 95 ||
            before === 126 || before === 40) {
          const end = parseWwwAutolink(s, i);
          if (end !== -1) {
            const url = s.slice(i, end);
            flushText(i);
            parts.push('<a href="' + cleanUrl('http://' + url) + '">' + escapeText(url) + '</a>');
            i = end;
            textStart = i;
            INLINE_SPECIAL.lastIndex = i;
            continue;
          }
        }
      }
      i++;
      INLINE_SPECIAL.lastIndex = i;
      continue;
    }
    if (c === 64) { // '@': extended email autolink
      // No autolink inside link text (local openers or the document-level
      // inLink state set by an inline <a> tag), unless the innermost
      // opener cannot form a link, in which case the email still autolinks.
      let inLink = docInLink;
      for (let k = 0; k < openers.length; k++) if (openers[k].active) { inLink = true; break; }
      if (inLink && !docInLink && openerCannotLink(s, openers, refs)) inLink = false;
      const em = inLink ? null : parseEmailAutolink(s, i, textStart, delims);
      if (em) {
        const addr = s.slice(em[0], em[1]);
        flushText(em[0]);
        parts.push('<a href="mailto:' + escapeAttr(addr) + '">' + escapeText(addr) + '</a>');
        i = em[1];
        textStart = i;
        INLINE_SPECIAL.lastIndex = i;
        continue;
      }
      i++;
      INLINE_SPECIAL.lastIndex = i;
      continue;
    }
    if (c === 58) { // ':': extended scheme autolink (http:, mailto:, xmpp: ...)
      // No autolink inside link text (local openers or the document-level
      // inLink state set by an inline <a> tag), unless the innermost
      // opener cannot form a link, in which case the URL still autolinks.
      let inLink = docInLink;
      for (let k = 0; k < openers.length; k++) if (openers[k].active) { inLink = true; break; }
      if (inLink && !docInLink && openerCannotLink(s, openers, refs)) inLink = false;
      const sc = inLink ? null : parseSchemeAutolink(s, i, textStart);
      if (sc) {
        const url = s.slice(sc[0], sc[1]);
        flushText(sc[0]);
        parts.push('<a href="' + cleanUrl(url) + '">' + escapeText(url) + '</a>');
        i = sc[1];
        textStart = i;
        INLINE_SPECIAL.lastIndex = i;
        continue;
      }
      i++;
      INLINE_SPECIAL.lastIndex = i;
      continue;
    }
    i++;
    INLINE_SPECIAL.lastIndex = i;
  }
  flushText(n);
  resolveEmphasis(parts, delims);
  return parts.join('');
}

// ---------- autolinks, raw HTML, link closing ----------
// The CommonMark email address pattern, for <...> autolinks.
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

// Parse an HTML tag (comment, processing instruction, declaration, CDATA
// section, open or close tag) starting at s[i] ('<').
// Returns the index just past the tag, or -1 when s[i] starts no tag.
function parseHtmlTag(s, i) {
  const n = s.length;
  if (i + 1 >= n) return -1;
  const c1 = s.charCodeAt(i + 1);
  if (c1 === 33) { // '!'
    if (s.startsWith('<!--', i)) {
      // <!--> and <!---> are complete (empty) comments on their own.
      if (s.charCodeAt(i + 4) === 62) return i + 5;
      if (s.charCodeAt(i + 4) === 45 && s.charCodeAt(i + 5) === 62) return i + 6;
      const e = s.indexOf('-->', i + 4);
      return e === -1 ? -1 : e + 3;
    }
    if (s.startsWith('<![CDATA[', i)) {
      const e = s.indexOf(']]>', i + 9);
      return e === -1 ? -1 : e + 3;
    }
    if (i + 2 < n && isAlpha(s.charCodeAt(i + 2))) {
      const e = s.indexOf('>', i + 2);
      return e === -1 ? -1 : e + 1;
    }
    return -1;
  }
  if (c1 === 63) { // '?'
    const e = s.indexOf('?>', i + 2);
    return e === -1 ? -1 : e + 2;
  }
  let j = i + 1;
  let closing = false;
  if (j < n && s.charCodeAt(j) === 47) { closing = true; j++; } // '/'
  if (j >= n || !isAlpha(s.charCodeAt(j))) return -1;
  while (j < n && (isAlnum(s.charCodeAt(j)) || s.charCodeAt(j) === 45)) j++;
  if (closing) {
    while (j < n && isSpace(s.charCodeAt(j))) j++;
    return j < n && s.charCodeAt(j) === 62 ? j + 1 : -1;
  }
  // After the tag name, only whitespace, '>' or '/>' may follow; every
  // attribute must be preceded by whitespace.
  let sp = false;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 62) return j + 1; // '>'
    if (c === 47 && j + 1 < n && s.charCodeAt(j + 1) === 62) return j + 2; // '/>'
    if (isSpace(c)) { sp = true; j++; continue; }
    if (!sp) return -1; // an attribute name with no whitespace before it
    if (!isAlnum(c) && c !== 95 && c !== 58 && c !== 46 && c !== 45) return -1;
    sp = false;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (isAlnum(d) || d === 95 || d === 58 || d === 46 || d === 45) j++;
      else break;
    }
    let k = j;
    while (k < n && isSpace(s.charCodeAt(k))) k++;
    if (k < n && s.charCodeAt(k) === 61) { // '='
      k++;
      while (k < n && isSpace(s.charCodeAt(k))) k++;
      if (k >= n) return -1;
      const q = s.charCodeAt(k);
      if (q === 34 || q === 39) {
        const e = s.indexOf(String.fromCharCode(q), k + 1);
        if (e === -1) return -1;
        j = e + 1;
      } else {
        let e = k;
        while (e < n) {
          const d = s.charCodeAt(e);
          if (d === 32 || d === 9 || d === 10 || d === 34 || d === 39 || d === 61 ||
              d === 60 || d === 62 || d === 96) break;
          e++;
        }
        if (e === k) return -1;
        j = e;
      }
    } else {
      // No '=' value: the whitespace skipped above is the separator before
      // the next attribute, so remember it.
      sp = k > j;
      j = k;
    }
  }
  return -1;
}

// Trim the end of an extended autolink spanning s[start..end) the way
// marked's _backpedal does: repeatedly keep the longest prefix made of
// runs of safe characters, balanced "(...)" groups, "&" not starting an
// entity reference at the very end, and punctuation that is not the last
// character. A trailing ')' is kept only when it closes a '(' group;
// ']' and '}' are ordinary characters and are kept; a trailing "&name;"
// entity reference is not part of the link.
function stripAutolinkTrail(s, start, end) {
  function isPunct(c) {
    return c === 63 || c === 33 || c === 46 || c === 44 || c === 58 ||
      c === 59 || c === 42 || c === 95 || c === 39 || c === 34 ||
      c === 126 || c === 41;
  }
  function isSafe(c) {
    return !(c === 63 || c === 33 || c === 46 || c === 44 || c === 58 ||
      c === 59 || c === 42 || c === 95 || c === 39 || c === 34 ||
      c === 126 || c === 40 || c === 41 || c === 38);
  }
  let cur = end;
  for (;;) {
    let p = start;
    while (p < cur) {
      const c = s.charCodeAt(p);
      if (isSafe(c)) {
        while (p < cur && isSafe(s.charCodeAt(p))) p++;
      } else if (c === 40) { // '(' — a balanced group "(...)" with no ')' inside
        let q = p + 1;
        while (q < cur && s.charCodeAt(q) !== 41) q++;
        if (q >= cur) break; // no closing ')' before the end
        p = q + 1;
      } else if (c === 38) { // '&' — not consumed if it starts an entity ending at cur
        let q = p + 1;
        while (q < cur && isAlnum(s.charCodeAt(q))) q++;
        if (q > p + 1 && q < cur && s.charCodeAt(q) === 59 && q === cur - 1) break;
        p++;
      } else if (isPunct(c)) {
        let q = p;
        while (q < cur && isPunct(s.charCodeAt(q))) q++;
        if (q >= cur) { // run reaches the end: keep all but the last char
          if (q - 1 === p) break; // single trailing punct char: stop
          p = q - 1;
        } else {
          p = q;
        }
      } else {
        break;
      }
    }
    if (p === cur) return cur;
    cur = p;
  }
}

// Parse the domain part of an extended autolink starting at s[i].
// Returns {end, labels, lastLen} or null when no label follows.
function parseDomain(s, i) {
  const n = s.length;
  let j = i;
  let labels = 0;
  let lastLen = 0;
  let end = j;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (!isAlnum(c) && c !== 45) break;
    let k = j;
    while (k < n && (isAlnum(s.charCodeAt(k)) || s.charCodeAt(k) === 45)) k++;
    labels++;
    lastLen = k - j;
    end = k;
    j = k;
    if (j < n && s.charCodeAt(j) === 46 && j + 1 < n &&
        (isAlnum(s.charCodeAt(j + 1)) || s.charCodeAt(j + 1) === 45)) {
      j++;
    } else break;
  }
  if (labels === 0) return null;
  return { end, labels, lastLen };
}

// Try to parse an extended scheme autolink with ':' at s[i]. The scheme is
// scanned back to runStart. Returns [start, end] or null.
function parseSchemeAutolink(s, i, runStart) {
  const n = s.length;
  let start = i;
  while (start > runStart) {
    const c = s.charCodeAt(start - 1);
    if (isAlnum(c) || c === 43 || c === 46 || c === 45) start--;
    else break;
  }
  const schemeLen = i - start;
  if (schemeLen < 2 || schemeLen > 32) return null;
  if (!isAlpha(s.charCodeAt(start))) return null;
  const before = start > 0 ? s.charCodeAt(start - 1) : 32;
  if (!(start === 0 || isSpace(before) || before === 42 || before === 95 ||
        before === 126 || before === 40 || before === 60)) return null;
  // The URL after ':' runs to whitespace or '<'; it must be non-empty.
  // A backslash is part of the URL (doc-10 keeps a trailing '.\'), but a
  // URL with no alphanumeric after the scheme is not a link at all
  // (doc-03 'removes:\' and doc-15 'config:.\' are hard breaks, not URLs).
  let end = i + 1;
  while (end < n) {
    const c = s.charCodeAt(end);
    if (c === 32 || c === 9 || c === 10 || c === 60 || c < 32) break;
    end++;
  }
  if (end === i + 1) return null;
  let hasAlnum = false;
  for (let k = i + 1; k < end; k++) if (isAlnum(s.charCodeAt(k))) { hasAlnum = true; break; }
  if (!hasAlnum) return null;
  // An '@' before any '/' makes this an email-like URL (mailto:, xmpp:):
  // parse the address, validate it like a bare email, and allow at most
  // one path segment after the domain.
  let at = -1;
  for (let k = i + 1; k < end; k++) {
    const c = s.charCodeAt(k);
    if (c === 64) { at = k; break; } // '@'
    if (c === 47) break; // '/'
  }
  if (at !== -1) {
    if (at === i + 1) return null;
    let ok = true;
    for (let k = i + 1; k < at; k++) {
      const c = s.charCodeAt(k);
      if (!(isAlnum(c) || c === 46 || c === 33 || c === 35 || c === 36 || c === 37 ||
            c === 38 || c === 39 || c === 42 || c === 43 || c === 61 ||
            c === 63 || c === 94 || c === 95 || c === 96 || c === 123 || c === 124 ||
            c === 125 || c === 126 || c === 45)) { ok = false; break; }
    }
    if (!ok) return null;
    const d = parseDomain(s, at + 1);
    if (!d || d.labels < 2) return null;
    if (s.charCodeAt(d.end - 1) === 45) return null;
    if (d.end < n && (s.charCodeAt(d.end) === 95 || s.charCodeAt(d.end) === 45)) return null;
    let linkEnd = d.end;
    if (linkEnd < end && s.charCodeAt(linkEnd) === 47) {
      let segEnd = linkEnd + 1;
      while (segEnd < end && s.charCodeAt(segEnd) !== 47) segEnd++;
      const stripped = stripAutolinkTrail(s, start, segEnd);
      if (stripped > linkEnd + 1) linkEnd = stripped;
    }
    return [start, linkEnd];
  }
  end = stripAutolinkTrail(s, start, end);
  if (end <= i + 1) return null;
  return [start, end];
}

// Try to parse an extended www autolink starting at s[i] ('www.').
// Returns the end index (exclusive) or -1.
function parseWwwAutolink(s, i) {
  const n = s.length;
  const d = parseDomain(s, i + 4);
  if (!d || d.labels < 1 || d.lastLen < 2) return -1;
  let end = d.end;
  while (end < n) {
    const c = s.charCodeAt(end);
    if (c === 32 || c === 9 || c === 10 || c === 60) break;
    end++;
  }
  end = stripAutolinkTrail(s, i, end);
  if (end <= i + 4) return -1;
  return end;
}

// Try to parse an extended email autolink with '@' at s[i]. The local part
// is scanned back to runStart (the start of the current text run).
// Returns [start, end] or null.
function parseEmailAutolink(s, i, runStart, delims) {
  const n = s.length;
  let start = i;
  while (start > runStart) {
    const c = s.charCodeAt(start - 1);
    if (isAlnum(c) || c === 46 || c === 33 || c === 35 || c === 36 || c === 37 ||
        c === 38 || c === 39 || c === 42 || c === 43 || c === 47 || c === 61 ||
        c === 63 || c === 94 || c === 95 || c === 96 || c === 123 || c === 124 ||
        c === 125 || c === 126 || c === 45) {
      start--;
    } else break;
  }
  if (start === i) return null;
  const d = parseDomain(s, i + 1);
  if (!d || d.labels < 2) return null;
  // The domain must not end with '-' and must not be followed by '_' or
  // '-' that continues the word. A '_' that opens a '__' strong delimiter
  // run does not disqualify it, and neither does a '_' that closes an
  // open '_' emphasis delimiter (the reference autolinks an email inside
  // _..._ even though the closing '_' follows the domain).
  if (s.charCodeAt(d.end - 1) === 45) return null;
  if (d.end < n && (s.charCodeAt(d.end) === 95 || s.charCodeAt(d.end) === 45)) {
    const isStrong = s.charCodeAt(d.end) === 95 && d.end + 1 < n && s.charCodeAt(d.end + 1) === 95;
    let closesEm = false;
    if (s.charCodeAt(d.end) === 95 && delims) {
      for (let k = delims.length - 1; k >= 0; k--) {
        const dm = delims[k];
        if (dm.ch === 95 && dm.canOpen && dm.active) { closesEm = true; break; }
      }
    }
    if (!isStrong && !closesEm) return null;
  }
  return [start, d.end];
}

// Try to form a link or image when ']' is seen at s[i], with opener op.
// The caller has already flushed the text run up to i, so the link text
// is parts[op.part + 1 .. parts.length). Returns the index just past the
// link, or -1 when no link forms.

// A link does not form when its text contains a code span delimited by
// two or more backticks whose content itself contains a backtick, AND
// there is more link text after that code span (marked fails to resolve
// such link text; the code span still renders, but the link and any
// emphasis spanning it stay literal). When the code span is the last
// thing in the link text, the link forms.
function hasBadCodeSpan(s, start, end) {
  for (let p = start; p < end; p++) {
    if (s.charCodeAt(p) !== 96) continue;
    let q = p;
    while (q < end && s.charCodeAt(q) === 96) q++;
    const len = q - p;
    if (len < 2) { p = q - 1; continue; }
    // Find the closing run of exactly len backticks.
    let r = q;
    let closeEnd = -1;
    while (r < end) {
      if (s.charCodeAt(r) === 96) {
        let r2 = r;
        while (r2 < end && s.charCodeAt(r2) === 96) r2++;
        if (r2 - r === len) { closeEnd = r2; break; }
        r = r2;
      } else r++;
    }
    if (closeEnd === -1) return false;
    // Content is s[q..r]; bad if it holds a backtick and text follows.
    let bad = false;
    for (let c = q; c < closeEnd - len; c++) if (s.charCodeAt(c) === 96) { bad = true; break; }
    if (bad && closeEnd < end) return true;
    p = closeEnd - 1;
  }
  return false;
}

function tryCloseLink(s, i, op, parts, delims, openers, refs, nextLinkId) {
  const n = s.length;
  if (hasBadCodeSpan(s, op.src, i)) {
    // The link stays literal, and so does any emphasis inside its text.
    for (let k = op.d0; k < delims.length; k++) delims[k].active = false;
    return -1;
  }
  let j = i + 1;
  let href = null;
  let title = null;
  let end = -1;
  if (j < n && s.charCodeAt(j) === 40) { // '(' : inline link
    const k = skipSpace(s, j + 1);
    let dest = parseDestination(s, k);
    if (!dest && k < n && s.charCodeAt(k) === 41) dest = ['', k]; // empty destination
    if (dest) {
      let m = skipSpace(s, dest[1]);
      const t = parseTitle(s, m);
      if (t) { title = t[0]; m = skipSpace(s, t[1]); }
      if (m < n && s.charCodeAt(m) === 41) {
        href = dest[0];
        end = m + 1;
      }
    }
    if (end === -1) {
      // Not a valid inline link: fall back to a shortcut reference.
      const key = normalizeLabel(s.slice(op.src, i));
      const ref = refs.get(key);
      if (!ref) return -1;
      href = ref.href;
      title = ref.title;
      end = i + 1;
    }
  } else if (j < n && s.charCodeAt(j) === 91) { // '[' : full/collapsed reference
    const lab = parseLabel(s, j);
    if (!lab) return -1;
    const key = lab[0].length === 0
      ? normalizeLabel(s.slice(op.src, i))
      : normalizeLabel(lab[0]);
    const ref = refs.get(key);
    if (!ref) return -1;
    href = ref.href;
    title = ref.title;
    end = lab[1];
  } else { // shortcut reference
    const key = normalizeLabel(s.slice(op.src, i));
    const ref = refs.get(key);
    if (!ref) return -1;
    href = ref.href;
    title = ref.title;
    end = i + 1;
  }
  // Destinations keep entities literal (backslash escapes were already
  // resolved by parseDestination); titles are fully decoded.
  title = title === null || title === undefined ? null : decodeRaw(title);
  if (op.image) {
    const alt = plainTextOfParts(parts, op.part + 1, parts.length, delims);
    parts[op.part] = '<img src="' + cleanUrl(href) + '" alt="' + escapeAttr(alt) + '"' +
      (title !== null ? ' title="' + escapeAttr(title) + '"' : '') + '>';
    for (let k = op.part + 1; k < parts.length; k++) parts[k] = '';
    for (let d = op.d0; d < delims.length; d++) delims[d].active = false;
    return end;
  }
  const lid = nextLinkId();
  parts[op.part] = '<a href="' + cleanUrl(href) + '"' +
    (title !== null ? ' title="' + escapeAttr(title) + '"' : '') + '>';
  parts.push('</a>');
  for (let d = op.d0; d < delims.length; d++) {
    if (delims[d].link === 0) delims[d].link = lid;
  }
  // Links cannot contain links, but an image may contain a link in its alt.
  // An opener deactivated this way *blocks* a later ']' (it owns it);
  // one deactivated by a failed close does not.
  for (const o of openers) if (!o.image) { o.active = false; o.blocked = true; }
  return end;
}

// ---------- block parsing ----------
// Block nodes:
//  doc {children} | para {lines, text, empty} | heading {level, text}
//  code {lang, lines, fenced} | html {lines} | quote {children}
//  list {ordered, start, delim, bullet, tight, children, _blank}
//  item {children, indent, task} | hr | table {align, header, rows}

function indentInfo(line, pos) {
  let cols = 0;
  let j = pos;
  const n = line.length;
  while (j < n) {
    const c = line.charCodeAt(j);
    if (c === 32) { cols++; j++; }
    else if (c === 9) { cols += 4 - (cols % 4); j++; }
    else break;
  }
  return { cols, next: j };
}

function isBlankFrom(line, pos) {
  for (let j = pos; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// For an HTML block's trailing newline, a following line swallows the
// newline. Types 1-5 end at a closing marker, so only a completely empty
// line swallows it; a line holding only spaces (or a tab) does not.
// Types 6-7 end at a blank line, and any whitespace-only line is blank,
// so it swallows.
function swallowsHtmlNL(line, type) {
  if (type >= 6) return line.trim() === '';
  return line.length === 0;
}

// Advance `cols` columns from pos (tabs advance to the next multiple of 4).
// Returns the index after the indentation.
// Absolute column of character position `pos` in `line` (tab stops every
// 4 columns from the line start). Every character counts as one column
// except a tab, which advances to the next multiple of 4.
function colAt(line, pos) {
  let col = 0;
  for (let j = 0; j < pos && j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c === 9) col += 4 - (col % 4);
    else col++;
  }
  return col;
}

// Advance `cols` columns from pos (tabs advance to the next multiple of 4,
// measured from the line start). Returns [newPos, virtualSpaces]: when a
// tab straddles the target column, the tab is consumed whole but the
// overshoot columns come back as virtual spaces that the caller must
// prepend to the content.
function advanceColsV(line, pos, cols) {
  let have = 0;
  let abs = colAt(line, pos);
  let j = pos;
  const n = line.length;
  while (j < n && have < cols) {
    const c = line.charCodeAt(j);
    if (c === 32) { have++; abs++; j++; }
    else if (c === 9) {
      const w = 4 - (abs % 4);
      have += w;
      abs += w;
      j++;
      if (have > cols) return [j, have - cols];
    }
    else break;
  }
  return [j, 0];
}

// Strip up to `chars` leading whitespace CHARACTERS from a fenced code
// content line starting at `curPos` (the fence line's leading whitespace
// string length, counted in characters, not columns). The remainder is
// kept literally: a tab in fenced code content is never expanded, and a
// tab counts as a single character when it is stripped. This strip only
// applies to backtick fences; a tilde fence keeps its content verbatim
// (marked does not remove a tilde fence's indent from its content).
function fenceContent(line, curPos, chars, fenceChar) {
  if (fenceChar !== 96) return line.slice(curPos);
  let p = curPos;
  let n = 0;
  while (p < line.length && n < chars) {
    const c = line.charCodeAt(p);
    if (c === 32 || c === 9) { p++; n++; }
    else break;
  }
  return line.slice(p);
}

// Strip an indented code block's indent from a line starting at `curPos`:
// either up to three spaces plus a tab, or one to four spaces. The
// remainder is kept literally, so a tab left after the strip stays a tab.
function indentedContent(line, curPos) {
  let p = curPos;
  let spaces = 0;
  while (p < line.length && line.charCodeAt(p) === 32 && spaces < 3) { p++; spaces++; }
  if (p < line.length && line.charCodeAt(p) === 9) return line.slice(p + 1);
  p = curPos;
  let n = 0;
  while (p < line.length && line.charCodeAt(p) === 32 && n < 4) { p++; n++; }
  return line.slice(p);
}

function advanceCols(line, pos, cols) {
  let have = 0;
  let j = pos;
  const n = line.length;
  while (j < n && have < cols) {
    const c = line.charCodeAt(j);
    if (c === 32) { have++; j++; }
    else if (c === 9) { have += 4 - (have % 4); j++; }
    else break;
  }
  return j;
}

// Parse a list marker at line[pos] (pos is the first non-space char, at
// most 3 columns of indent). Returns null or
// {ordered, bullet, delim, start, markerLen, contentIndent, contentStart}.
function parseListMarker(line, pos, indentCols) {
  const n = line.length;
  const c = line.charCodeAt(pos);
  let ordered = false, bullet = '', delim = '', start = 0, markerLen = 0;
  if (c === 45 || c === 43 || c === 42) {
    bullet = line[pos];
    markerLen = 1;
  } else if (isDigit(c)) {
    let j = pos;
    while (j < n && isDigit(line.charCodeAt(j)) && j - pos < 9) j++;
    if (j === pos) return null;
    const d = line.charCodeAt(j);
    if (d !== 46 && d !== 41) return null;
    start = 0;
    for (let k = pos; k < j; k++) start = start * 10 + (line.charCodeAt(k) - 48);
    delim = String.fromCharCode(d);
    markerLen = j - pos + 1;
    ordered = true;
  } else return null;
  const after = pos + markerLen;
  if (after < n) {
    const a = line.charCodeAt(after);
    if (a !== 32 && a !== 9) return null;
  }
  // Columns of whitespace after the marker.
  let col = indentCols + markerLen;
  let k = after;
  while (k < n) {
    const ch = line.charCodeAt(k);
    if (ch === 32) { col++; k++; }
    else if (ch === 9) { col += 4 - (col % 4); k++; }
    else break;
  }
  const spacesAfter = col - (indentCols + markerLen);
  if (k >= n) {
    // Empty item: content indent is marker width + 1.
    return { ordered, bullet, delim, start, markerLen, indent: indentCols,
             contentIndent: indentCols + markerLen + 1, contentStart: k };
  }
  if (spacesAfter >= 5) {
    return { ordered, bullet, delim, start, markerLen, indent: indentCols,
             contentIndent: indentCols + markerLen + 1, contentStart: after + 1 };
  }
  return { ordered, bullet, delim, start, markerLen, indent: indentCols,
           contentIndent: indentCols + markerLen + spacesAfter, contentStart: k };
}

// Split a table row line into cells on unescaped '|', keeping code spans
// whole (a '|' inside one does not split) and backslash escapes intact.
function splitTableRow(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 92 && i + 1 < n) {
      // \| is an escaped pipe: it stays in the cell as | (the backslash is
      // consumed by the table parser). Other escapes are left for inline.
      if (line.charCodeAt(i + 1) === 124) { cur += '|'; i += 2; continue; }
      cur += line[i] + line[i + 1]; i += 2; continue;
    }
    if (c === 96) {
      let k = i;
      while (k < n && line.charCodeAt(k) === 96) k++;
      const runLen = k - i;
      // Find a same-length closer run, but a code span cannot cross an
      // unescaped '|' (that is a cell boundary, not span content).
      let found = -1;
      let j = k;
      while (j < n) {
        const cj = line.charCodeAt(j);
        if (cj === 92 && j + 1 < n) { j += 2; continue; }
        if (cj === 124) break;
        if (cj === 96) {
          let e = j;
          while (e < n && line.charCodeAt(e) === 96) e++;
          if (e - j === runLen) { found = j; break; }
          j = e;
          continue;
        }
        j++;
      }
      if (found === -1) { cur += line.slice(i, k); i = k; continue; }
      // Copy the code span, consuming \| escapes inside it as well.
      let q = i;
      while (q < found + runLen) {
        if (line.charCodeAt(q) === 92 && q + 1 < found + runLen && line.charCodeAt(q + 1) === 124) { cur += '|'; q += 2; }
        else { cur += line[q]; q++; }
      }
      i = found + runLen;
      continue;
    }
    if (c === 124) { cells.push(cur); cur = ''; i++; continue; }
    cur += line[i];
    i++;
  }
  cells.push(cur);
  return cells;
}

// Parse a table delimiter row. Returns the alignment array or null.
function parseDelimiterRow(content) {
  const cells = splitTableRow(content);
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  if (cells.length === 0) return null;
  const align = [];
  for (const cell of cells) {
    const t = cell.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    if (t.charCodeAt(0) === 58 && t.charCodeAt(t.length - 1) === 58) align.push('center');
    else if (t.charCodeAt(0) === 58) align.push('left');
    else if (t.charCodeAt(t.length - 1) === 58) align.push('right');
    else align.push(null);
  }
  return align;
}

function splitRowCells(line) {
  const cells = splitTableRow(line);
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

// Extract leading link reference definitions from a paragraph's text.
// Returns the remaining text ('' when the paragraph was only definitions).
function stripLinkDefs(text, refs) {
  let pos = 0;
  const n = text.length;
  while (pos < n) {
    let j = pos;
    let spaces = 0;
    while (j < n && text.charCodeAt(j) === 32 && spaces < 3) { j++; spaces++; }
    if (j >= n || text.charCodeAt(j) !== 91) break;
    const lab = parseLabel(text, j);
    if (!lab) break;
    let k = lab[1];
    if (k >= n || text.charCodeAt(k) !== 58) break;
    k++;
    k = skipSpace(text, k);
    const dest = parseDestination(text, k);
    if (!dest) break;
    // After the destination, only spaces/tabs on the same line. A title
    // needs whitespace before it; a title on the same line must be followed
    // by only whitespace to the end of the line, or the definition fails.
    // A title on the next line that is followed by junk is simply ignored.
    let m = dest[1];
    let e = m;
    while (e < n && (text.charCodeAt(e) === 32 || text.charCodeAt(e) === 9)) e++;
    let title = null;
    let endPos = e;
    if (e < n && text.charCodeAt(e) !== 10) {
      if (e === m) break;
      const t = parseTitle(text, e);
      if (!t) break;
      let f = t[1];
      while (f < n && (text.charCodeAt(f) === 32 || text.charCodeAt(f) === 9)) f++;
      if (f < n && text.charCodeAt(f) !== 10) break;
      title = t[0];
      endPos = f < n ? f + 1 : f;
    } else if (e < n && text.charCodeAt(e) === 10) {
      let g = e + 1;
      while (g < n && (text.charCodeAt(g) === 32 || text.charCodeAt(g) === 9)) g++;
      const t = parseTitle(text, g);
      if (t) {
        let f = t[1];
        while (f < n && (text.charCodeAt(f) === 32 || text.charCodeAt(f) === 9)) f++;
        if (f >= n || text.charCodeAt(f) === 10) {
          title = t[0];
          endPos = f < n ? f + 1 : f;
        } else endPos = e + 1;
      } else endPos = e + 1;
    }
    const key = normalizeLabel(lab[0]);
    if (key === '') break; // a label must contain a non-whitespace character
    if (!refs.has(key)) refs.set(key, { href: dest[0], title });
    pos = endPos;
  }
  return text.slice(pos);
}

// ---------- block-start detection ----------

// Return the HTML block type (1-7) for a line whose content starts with
// '<', or 0 when the line does not start an HTML block. `content` is the
// line after container markers and up to 3 columns of indent.
function htmlBlockStart(content) {
  if (content.charCodeAt(0) !== 60) return 0;
  if (content.startsWith('<!--')) return 2;
  if (content.startsWith('<?')) return 3;
  if (content.startsWith('<![CDATA[')) return 5;
  if (content.startsWith('<!') && content.length > 2 && isAlpha(content.charCodeAt(2))) return 4;
  let i = 1;
  let closing = false;
  if (content.charCodeAt(1) === 47) { closing = true; i = 2; }
  if (i >= content.length || !isAlpha(content.charCodeAt(i))) return 0;
  let j = i;
  while (j < content.length) {
    const c = content.charCodeAt(j);
    if (!isAlpha(c) && !isDigit(c) && c !== 45) break;
    j++;
  }
  const tag = content.slice(i, j).toLowerCase();
  const after = j < content.length ? content.charCodeAt(j) : -1;
  if (after !== -1 && after !== 32 && after !== 9 && after !== 62 && after !== 47) return 0;
  if (!closing && (tag === 'script' || tag === 'pre' || tag === 'style' || tag === 'textarea')) return 1;
  if (BLOCK_TAGS.has(tag)) return 6;
  // Type 7: a complete open tag (any tag name except the type-1 ones) or a
  // complete closing tag, alone on the line (only whitespace after it).
  // A closing tag takes no attributes; an open tag's attributes must be
  // valid (name, optional = value) and separated by whitespace.
  let p = j;
  const n = content.length;
  if (closing) {
    while (p < n && (content.charCodeAt(p) === 32 || content.charCodeAt(p) === 9)) p++;
    if (p >= n || content.charCodeAt(p) !== 62) return 0;
    p++;
  } else {
    let closed = false;
    let attrs = 0;
    while (p < n) {
      let sp = 0;
      while (p < n && (content.charCodeAt(p) === 32 || content.charCodeAt(p) === 9)) { p++; sp++; }
      if (p >= n) break;
      const c = content.charCodeAt(p);
      if (c === 62) { p++; closed = true; break; }
      if (c === 47) {
        if (p + 1 < n && content.charCodeAt(p + 1) === 62) { p += 2; closed = true; break; }
        return 0;
      }
      // Attributes after the first must be separated by whitespace.
      if (attrs > 0 && sp === 0) return 0;
      // Attribute name: letter, _, : then letters, digits, _, :, ., -.
      if (!isAlpha(c) && c !== 95 && c !== 58) return 0;
      p++;
      while (p < n) {
        const d = content.charCodeAt(p);
        if (!isAlpha(d) && !isDigit(d) && d !== 95 && d !== 58 && d !== 46 && d !== 45) break;
        p++;
      }
      attrs++;
      while (p < n && (content.charCodeAt(p) === 32 || content.charCodeAt(p) === 9)) p++;
      if (p < n && content.charCodeAt(p) === 61) {
        p++;
        while (p < n && (content.charCodeAt(p) === 32 || content.charCodeAt(p) === 9)) p++;
        if (p >= n) return 0;
        const q = content.charCodeAt(p);
        if (q === 34 || q === 39) {
          p++;
          while (p < n && content.charCodeAt(p) !== q) p++;
          if (p >= n) return 0;
          p++;
        } else {
          // Unquoted value: no space, ", ', =, <, >, `.
          while (p < n) {
            const d = content.charCodeAt(p);
            if (d === 32 || d === 9 || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
            p++;
          }
          if (p >= n) return 0;
        }
      }
    }
    if (!closed) return 0;
  }
  while (p < n && (content.charCodeAt(p) === 32 || content.charCodeAt(p) === 9)) p++;
  if (p !== n) return 0;
  return 7;
}

// 1 for a setext level-1 underline, 2 for level-2, 0 otherwise.
function isSetextLine(content) {
  let i = 0;
  const n = content.length;
  while (i < n && (content.charCodeAt(i) === 32 || content.charCodeAt(i) === 9)) i++;
  if (i >= n) return 0;
  const c = content.charCodeAt(i);
  if (c !== 61 && c !== 45) return 0;
  let j = i;
  while (j < n && content.charCodeAt(j) === c) j++;
  while (j < n && (content.charCodeAt(j) === 32 || content.charCodeAt(j) === 9)) j++;
  if (j < n) return 0;
  return c === 61 ? 1 : 2;
}

function isThematicBreak(content) {
  let i = 0;
  const n = content.length;
  while (i < n && (content.charCodeAt(i) === 32 || content.charCodeAt(i) === 9)) i++;
  if (i >= n) return false;
  const c = content.charCodeAt(i);
  if (c !== 45 && c !== 95 && c !== 42) return false;
  let count = 0;
  let j = i;
  while (j < n) {
    const ch = content.charCodeAt(j);
    if (ch === c) { count++; j++; }
    else if (ch === 32 || ch === 9) j++;
    else return false;
  }
  return count >= 3;
}

// Strip the leading space and the trailing closing sequence of '#'s from an
// ATX heading's text.
function stripAtxClosing(text) {
  let start = 0;
  while (start < text.length && (text.charCodeAt(start) === 32 || text.charCodeAt(start) === 9)) start++;
  let end = text.length;
  while (end > start && (text.charCodeAt(end - 1) === 32 || text.charCodeAt(end - 1) === 9)) end--;
  let hashEnd = end;
  while (hashEnd > start && text.charCodeAt(hashEnd - 1) === 35) hashEnd--;
  if (hashEnd < end && (hashEnd === start ||
      (text.charCodeAt(hashEnd - 1) === 32 || text.charCodeAt(hashEnd - 1) === 9))) {
    if (hashEnd === start) return '';
    let e2 = hashEnd;
    while (e2 > start && (text.charCodeAt(e2 - 1) === 32 || text.charCodeAt(e2 - 1) === 9)) e2--;
    return text.slice(start, e2);
  }
  return text.slice(start, end);
}

// Detect the block a line starts. `pos` is the position after the container
// markers. `paraTip` is true when the open tip is a paragraph (only
// interrupting blocks may start). Returns a descriptor or null (paragraph).
function detectBlock(line, pos, paraTip) {
  const inf = indentInfo(line, pos);
  if (inf.cols >= 4) {
    if (!paraTip) return { kind: 'indented', contentStart: inf.next };
    return null;
  }
  const content = line.slice(inf.next);
  const c0 = content.charCodeAt(0);
  // Block quote.
  if (c0 === 62) {
    let cs = inf.next + 1;
    if (cs < line.length && (line.charCodeAt(cs) === 32 || line.charCodeAt(cs) === 9)) cs++;
    return { kind: 'quote', contentStart: cs };
  }
  // Fenced code.
  if (c0 === 96 || c0 === 126) {
    let run = 0;
    while (run < content.length && content.charCodeAt(run) === c0) run++;
    if (run >= 3) {
      if (c0 === 96 && content.indexOf('`', run) !== -1) {
        // Backtick fence with a backtick in the info string: not a fence.
      } else {
        return { kind: 'fenced', fenceChar: c0, fenceLen: run, indentCols: inf.cols, indentChars: inf.next - pos, infoText: content.slice(run) };
      }
    }
  }
  // ATX heading.
  if (c0 === 35) {
    let run = 0;
    while (run < content.length && content.charCodeAt(run) === 35) run++;
    if (run >= 1 && run <= 6) {
      if (run === content.length || content.charCodeAt(run) === 32 || content.charCodeAt(run) === 9) {
        return { kind: 'atx', level: run, text: stripAtxClosing(content.slice(run)) };
      }
    }
  }
  // HTML block (types 1-6 interrupt a paragraph; type 7 does not).
  if (c0 === 60) {
    const ht = htmlBlockStart(content);
    if (ht > 0 && (ht <= 6 || !paraTip)) {
      return { kind: 'html', type: ht, firstLine: line.slice(pos) };
    }
  }
  // Thematic break.
  if (isThematicBreak(content)) return { kind: 'hr' };
  // List (bullet always interrupts; ordered only when it starts at 1).
  const marker = parseListMarker(line, inf.next, inf.cols);
  if (marker && (!paraTip || !marker.ordered || marker.start === 1)) {
    return { kind: 'list', marker };
  }
  return null;
}

// ---------- block parser ----------

// Does `line` end an HTML block of `type` whose first line is `firstLine`?
function htmlEndsOnLine(type, firstLine, line) {
  if (type === 1) {
    const fl = firstLine.toLowerCase();
    const close = fl.indexOf('<pre') !== -1 ? '</pre>'
      : fl.indexOf('<script') !== -1 ? '</script>'
      : fl.indexOf('<style') !== -1 ? '</style>' : '</textarea>';
    return line.toLowerCase().indexOf(close) !== -1;
  }
  if (type === 2) return line.indexOf('-->') !== -1;
  if (type === 3) return line.indexOf('?>') !== -1;
  if (type === 4) return line.indexOf('>') !== -1;
  if (type === 5) return line.indexOf(']]>') !== -1;
  return false;
}

// Expand tabs in the leading whitespace of a line to spaces (tab stops
// every 4 columns, from the line start), but only while the column is
// under 4: tabs at or beyond column 4 are content (e.g. indented code)
// and stay literal. Used for structural lines only.
function expandLeadingTabs(ln) {
  let col = 0;
  let k = 0;
  let out = '';
  while (k < ln.length && col < 4) {
    const ch = ln.charCodeAt(k);
    if (ch === 32) { col++; out += ' '; k++; }
    else if (ch === 9) { const w = 4 - (col % 4); out += '    '.slice(0, w); col += w; k++; }
    else break;
  }
  if (k === 0 || out.length === k) return ln;
  return out + ln.slice(k);
}

// Strip a blockquote marker the way the reference does: expand the
// tabs in the whitespace run after '>' (tab stops counted from the
// marker's column in the current view, whose column 0 is viewStart),
// then drop the marker plus one whitespace character. Returns the
// rewritten line; the content starts at viewStart in it.
function quoteContentLine(line, viewStart, qpos) {
  let r = qpos + 1;
  while (r < line.length && (line.charCodeAt(r) === 32 || line.charCodeAt(r) === 9)) r++;
  const run = line.slice(qpos + 1, r);
  let expanded = '';
  let col = qpos - viewStart + 1;
  for (let k = 0; k < run.length; k++) {
    const ch = run.charCodeAt(k);
    if (ch === 9) { const w = 4 - (col % 4); expanded += ' '.repeat(w); col += w; }
    else { expanded += ' '; col++; }
  }
  return line.slice(0, viewStart) + (expanded.length > 0 ? expanded.slice(1) : '') + line.slice(r);
}

// A list marker followed by 5+ columns of whitespace has its content
// indent capped at marker width + 1, so contentStart points inside the
// whitespace run. Expand the whole run (tab stops counted from the
// marker's end column in the current view) and keep one column of it as
// the marker's trailing space; the rest is content indent. Returns the
// rewritten line (or the line unchanged when contentStart is not inside
// the run) and moves marker.contentStart to the index right after the
// marker in the rewritten line.
function expandCappedMarker(line, marker) {
  const cs = marker.contentStart;
  if (cs <= 0 || cs >= line.length) return line;
  const c = line.charCodeAt(cs);
  if (c !== 32 && c !== 9) return line;
  const after = cs - 1;
  let k = after;
  while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
  const run = line.slice(after, k);
  let expanded = '';
  let col = marker.indent + marker.markerLen;
  for (let t = 0; t < run.length; t++) {
    const ch = run.charCodeAt(t);
    if (ch === 9) { const w = 4 - (col % 4); expanded += ' '.repeat(w); col += w; }
    else { expanded += ' '; col++; }
  }
  marker.contentStart = after;
  return line.slice(0, after) + expanded.slice(1) + line.slice(k);
}

function parseBlocks(lines, endsWithNewline) {
  const refs = new Map();
  const root = { t: 'doc', children: [] };
  const stack = [root];
  const N = lines.length;
  let i = 0;
  let sawBlank = false;

  function closeTop() {
    const b = stack.pop();
    if (b.t === 'html') {
      // A trailing newline follows the block only when the line after its
      // last line is not blank (or it is the last line and the input ends
      // with a newline); a blank line after the block swallows it.
      if (b.lastLine === N - 1) b.trailingNL = endsWithNewline;
      else b.trailingNL = !swallowsHtmlNL(lines[b.lastLine + 1], b.type);
    }
    if (b.t === 'para') {
      b.text = stripLinkDefs(b.lines.join('\n'), refs);
      if (b.text.trim() === '') {
        const parent = stack[stack.length - 1];
        if (parent.children.length > 0 && parent.children[parent.children.length - 1] === b) parent.children.pop();
      }
    } else if (b.t === 'code' && !b.fenced) {
      while (b.lines.length > 0 && isBlankFrom(b.lines[b.lines.length - 1], 0)) b.lines.pop();
    }
  }

  // Add a block to the current container. A blank line seen since the last
  // block makes the enclosing list loose when this block is a second block
  // of the same list item.
  function addNode(node) {
    const parent = stack[stack.length - 1];
    if (sawBlank && parent.t === 'item' && parent.children.length > 0) {
      const list = stack[stack.length - 2];
      if (list && list.t === 'list') list._blank = true;
    }
    parent.children.push(node);
    sawBlank = false;
  }

  function startBlock(d, line, pos) {
    if (d.kind === 'fenced') {
      let lang = '';
      const info = d.infoText.trim();
      if (info.length > 0) {
        const sp = info.search(/[ \t]/);
        lang = decodeRaw(sp === -1 ? info : info.slice(0, sp));
      }
      const node = { t: 'code', lang, lines: [], fenced: true, fenceChar: d.fenceChar, fenceLen: d.fenceLen, indentCols: d.indentCols, indentChars: d.indentChars };
      addNode(node);
      stack.push(node);
      return;
    }
    if (d.kind === 'indented') {
      const node = { t: 'code', lang: '', lines: [], fenced: false };
      node.lines.push(indentedContent(line, pos));
      addNode(node);
      stack.push(node);
      return;
    }
    if (d.kind === 'atx') {
      addNode({ t: 'heading', level: d.level, text: d.text });
      return;
    }
    if (d.kind === 'html') {
      const node = { t: 'html', type: d.type, lines: [d.firstLine], openAtEOF: false, trailingNL: false, lastLine: i };
      addNode(node);
      // Types 1-5 can end on the first line itself.
      if (d.type > 5 || !htmlEndsOnLine(d.type, d.firstLine, d.firstLine)) stack.push(node);
      else node.trailingNL = i === N - 1 ? endsWithNewline : !swallowsHtmlNL(lines[i + 1], d.type);
      return;
    }
    if (d.kind === 'hr') {
      addNode({ t: 'hr' });
      return;
    }
  }

  // Create (or reuse) a list for `marker` and push a fresh item onto it.
  // Returns the item. Adjusts marker.contentStart past a task checkbox.
  function createListItem(marker, line) {
    // When this is reached, the tip is the container the marker belongs
    // to: a list (a sibling item) or an item (a nested sublist, since the
    // item matched during container matching). Never close the item here.
    const tip = stack[stack.length - 1];
    let list = null;
    if (tip.t === 'list') {
      const sameType = marker.ordered
        ? (tip.ordered && tip.delim === marker.delim)
        : (!tip.ordered && tip.bullet === marker.bullet);
      if (sameType) list = tip;
    }
    if (!list) {
      if (tip.t === 'list') stack.pop();
      list = { t: 'list', ordered: marker.ordered, start: marker.start, delim: marker.delim, bullet: marker.bullet, tight: true, children: [], _blank: false };
      addNode(list);
      stack.push(list);
    }
    if (sawBlank && list.children.length > 0) list._blank = true;
    sawBlank = false;
    const item = { t: 'item', children: [], indent: marker.contentIndent, task: 0 };
    list.children.push(item);
    stack.push(item);
    // Task list checkbox at the start of the item's first line.
    let contentStart = marker.contentStart;
    const firstContent = line.slice(contentStart);
    if (firstContent.length >= 3 && firstContent.charCodeAt(0) === 91) {
      const c1 = firstContent.charCodeAt(1);
      const c2 = firstContent.charCodeAt(2);
      if ((c1 === 32 && c2 === 93) || ((c1 === 120 || c1 === 88) && c2 === 93)) {
        const after = firstContent.length === 3 ? -1 : firstContent.charCodeAt(3);
        if (after === -1 || after === 32 || after === 9) {
          // Not a task when the rest starts a fenced code block or heading.
          let rest = firstContent.slice(3);
          let r = 0;
          while (r < rest.length && (rest.charCodeAt(r) === 32 || rest.charCodeAt(r) === 9)) r++;
          const rc = r < rest.length ? rest.charCodeAt(r) : -1;
          let isBlock = false;
          if (rc === 35) isBlock = true;
          if (rc === 96 || rc === 126) {
            let run = 0;
            while (r + run < rest.length && rest.charCodeAt(r + run) === rc) run++;
            if (run >= 3) isBlock = true;
          }
          if (!isBlock) {
            item.task = c1 === 32 ? 1 : 2;
            contentStart += 3;
            if (contentStart < line.length && (line.charCodeAt(contentStart) === 32 || line.charCodeAt(contentStart) === 9)) contentStart++;
            marker.contentStart = contentStart;
          }
        }
      }
    }
    return item;
  }

  while (i < N) {
    // Expand leading tabs (only within the first 4 columns) for structural
    // lines; a line inside a code block or an HTML block keeps its tabs
    // literal (both are raw content, not structure).
    let line = lines[i];
    const tip0 = stack[stack.length - 1];
    // A whitespace-only line keeps its tabs (a tab-only line is a table
    // row, while a spaces-only line ends the table); only expand tabs on
    // lines that have non-whitespace content.
    if (tip0.t !== 'code' && tip0.t !== 'html' && line.indexOf('\t') !== -1 && line.trim() !== '') {
      line = expandLeadingTabs(line);
      lines[i] = line;
    }
    // A fenced code block's content lines are raw content: they belong to
    // the block even when they do not match the enclosing containers'
    // indent or markers, so the containers must not close on such a line.
    const tipIsFencedCode = tip0.t === 'code' && tip0.fenced;
    // ---- match open containers ----
    let pos = 0;
    let matched = 1;
    let quoteMatched = false;
    for (let j = 1; j < stack.length; j++) {
      const b = stack[j];
      if (b.t === 'quote') {
        const inf = indentInfo(line, pos);
        if (inf.cols > 3 || inf.next >= line.length || line.charCodeAt(inf.next) !== 62) break;
        quoteMatched = true;
        // Strip the marker the way the reference does: expand the tabs
        // in the whitespace run after '>' (tab stops counted from the
        // marker's own column in this container's view), then drop the
        // marker plus one whitespace character. The rest of the line is
        // re-read from the rewritten line, so a tab that follows the
        // marker lands at the column it has inside the quote, not at its
        // absolute column in the raw line.
        const qpos = inf.next;
        let r = qpos + 1;
        while (r < line.length && (line.charCodeAt(r) === 32 || line.charCodeAt(r) === 9)) r++;
        const run = line.slice(qpos + 1, r);
        let expanded = '';
        let col = qpos - pos + 1;
        for (let k = 0; k < run.length; k++) {
          const ch = run.charCodeAt(k);
          if (ch === 9) { const w = 4 - (col % 4); expanded += ' '.repeat(w); col += w; }
          else { expanded += ' '; col++; }
        }
        line = line.slice(0, pos) + (expanded.length > 0 ? expanded.slice(1) : '') + line.slice(r);
        lines[i] = line;
        matched = j + 1;
      } else if (b.t === 'item') {
        if (isBlankFrom(line, pos)) matched = j + 1;
        else {
          const inf = indentInfo(line, pos);
          if (inf.cols >= b.indent) {
            // Expand the tabs in the leading whitespace run (tab stops
            // counted from the current view, i.e. from pos), then strip
            // the item indent columns. A tab that straddles the indent
            // leaves its overshoot as spaces instead of being swallowed
            // whole (the reference expands leading tabs before it strips
            // the item's indent, so a tab just past the indent still
            // contributes its remaining columns as content indent).
            let r = pos;
            while (r < line.length && (line.charCodeAt(r) === 32 || line.charCodeAt(r) === 9)) r++;
            const run = line.slice(pos, r);
            let expanded = '';
            let col = 0;
            for (let k = 0; k < run.length; k++) {
              const ch = run.charCodeAt(k);
              if (ch === 9) { const w = 4 - (col % 4); expanded += ' '.repeat(w); col += w; }
              else { expanded += ' '; col++; }
            }
            line = line.slice(0, pos) + expanded.slice(b.indent) + line.slice(r);
            lines[i] = line;
            matched = j + 1;
          }
          else if (tipIsFencedCode && tip0.lines.length > 0) { matched = j + 1; }
          else break;
        }
      } else if (b.t === 'list') matched = j + 1;
      else break;
    }
    const tip = stack[stack.length - 1];
    const isLeaf = tip.t === 'para' || tip.t === 'code' || tip.t === 'html' || tip.t === 'table';
    let tipCurrent = isLeaf ? matched === stack.length - 1 : matched === stack.length;
    // A tab-only line is a table row, not the end of the table: keep the
    // table open so the blank handler below can add it as a row.
    if (!tipCurrent && tip.t === 'table' && line.indexOf('\t') !== -1 && line.trim() === '') tipCurrent = true;
    const blankAfter = isBlankFrom(line, pos);

    // ---- lazy paragraph continuation (containers did not match) ----
    if (tip.t === 'para' && !tipCurrent && !blankAfter) {
      const linf = indentInfo(line, pos);
      const lcontent = line.slice(linf.next);
      // A setext underline cannot be a lazy continuation, but a line that
      // is only a setext underline (not a thematic break) is still literal
      // paragraph text; a thematic break starts a new block instead.
      if (!isThematicBreak(lcontent)) {
        // A list marker at the level of the currently open list is not a
        // lazy continuation, whether it joins that list or starts a new
        // one (e.g. a different ordered delimiter), even when an ordered
        // list would not otherwise interrupt a paragraph.
        let listMarkerAtList = false;
        if (linf.cols <= 3 && matched >= 2) {
          const marker = parseListMarker(line, linf.next, linf.cols);
          const maybeList = stack[matched - 1];
          if (marker && maybeList && maybeList.t === 'list') listMarkerAtList = true;
        }
        if (!listMarkerAtList && !detectBlock(line, pos, true)) {
          // A lazy continuation line keeps its leading whitespace, except
          // that a line indented 4+ columns is dedented by exactly 4 (the
          // reference treats the extra indent as indented-code indent even
          // inside a paragraph continuation).
          const linf2 = indentInfo(line, pos);
          const lazyText = line.slice(linf2.next);
          if (isSetextLine(lazyText)) {
            // A lazy setext underline cannot convert the paragraph, so it
            // stays as literal text, indented by 4 spaces (marked quirk).
            tip.lines.push('    ' + lazyText);
          } else if (linf2.cols >= 4) {
            tip.lines.push(indentedContent(line, pos));
          } else {
            tip.lines.push(line.slice(pos));
          }
          i++;
          continue;
        }
      }
    }
    // ---- close containers the line does not belong to ----
    // When the tip is current, nothing closes here; otherwise close down to
    // the matched containers (the leaf and any non-matching containers go).
    // A blank line seen inside a quote does not count at the outer level:
    // once the quote closes, it can no longer separate two blocks of the
    // enclosing list item, so it must not make the list loose.
    const closeTarget = tipCurrent ? stack.length : matched;
    while (stack.length > closeTarget) {
      if (stack[stack.length - 1].t === 'quote') sawBlank = false;
      closeTop();
    }

    // ---- process the line's content (loops again for a list item's first line) ----
    let curPos = pos;
    let handled = false;
    while (!handled) {
      const cur = stack[stack.length - 1];
      const blank = isBlankFrom(line, curPos);
      if (blank) {
        if (cur.t === 'para') {
          const rest = line.slice(curPos);
          if ((!isBlankFrom(line, 0) || quoteMatched) && rest.length > 0) {
            // A marker-only line with trailing spaces (e.g. '>  ') is a
            // paragraph continuation carrying those spaces, not a blank
            // line; a bare marker ('>') still ends the paragraph. The
            // marker may already be stripped from the line (quoteMatched),
            // so a whitespace-only remainder still counts as a continuation.
            cur.lines.push(rest);
            handled = true;
            continue;
          }
          closeTop();
          sawBlank = true;
        } else if (cur.t === 'table') {
          // A tab-only line is a row of empty cells, not the end of the
          // table; a truly empty line (or spaces-only) ends it.
          if (line.indexOf('\t') !== -1 && line.trim() === '') {
            cur.rows.push(splitRowCells(line.slice(curPos)));
            handled = true;
            continue;
          }
          closeTop();
          sawBlank = true;
        } else if (cur.t === 'code' && cur.fenced) {
          cur.lines.push(fenceContent(line, curPos, cur.indentChars, cur.fenceChar));
        } else if (cur.t === 'code' && !cur.fenced) {
          cur.lines.push(indentedContent(line, curPos));
        } else if (cur.t === 'html') {
          if (cur.type <= 5) {
            // Types 1-5 run to their closing marker, blank lines included.
            cur.lines.push(line.slice(curPos));
            cur.lastLine = i;
          } else {
            closeTop();
            sawBlank = true;
          }
        } else if (cur.t === 'item' && cur.children.length === 0 && curPos === pos) {
          // An empty item followed by a (genuine) blank line is closed; the
          // content after it belongs outside the list.
          closeTop();
          sawBlank = true;
        } else if (curPos === pos && isBlankFrom(line, 0)) {
          // A genuine blank line (not the empty tail of a marker line):
          // the whole line must be whitespace, so a marker-only line
          // like '>' does not count as blank.
          sawBlank = true;
        }
        handled = true;
        continue;
      }
      if (cur.t === 'code' && cur.fenced) {
        // Closing fence: same char, at least as long, at most 3 indent,
        // only spaces after.
        const inf = indentInfo(line, curPos);
        if (inf.cols <= 3) {
          let k = inf.next;
          let run = 0;
          while (k < line.length && line.charCodeAt(k) === cur.fenceChar) { run++; k++; }
          if (run >= cur.fenceLen && isBlankFrom(line, k)) {
            closeTop();
            handled = true;
            continue;
          }
        }
        cur.lines.push(fenceContent(line, curPos, cur.indentChars, cur.fenceChar));
        handled = true;
        continue;
      }
      if (cur.t === 'code' && !cur.fenced) {
        // Indented code continues on blank lines or lines indented 4+.
        const inf = indentInfo(line, curPos);
        if (inf.cols >= 4) {
          cur.lines.push(indentedContent(line, curPos));
          handled = true;
          continue;
        }
        closeTop();
        continue;
      }
      if (cur.t === 'html') {
        cur.lines.push(line.slice(curPos));
        cur.lastLine = i;
        if (cur.type <= 5 && htmlEndsOnLine(cur.type, cur.lines[0], line)) closeTop();
        handled = true;
        continue;
      }
      if (cur.t === 'table') {
        // A body row need not contain a pipe (a line without one is a
        // single-cell row), unless it starts a new block, which ends the
        // table instead. A whitespace-only line is a row of empty cells,
        // not a new block (a tab-only line does not end the table).
        if (line.indexOf('|', curPos) === -1 && line.slice(curPos).trim() !== '' && detectBlock(line, curPos, true)) {
          closeTop();
          continue;
        }
        cur.rows.push(splitRowCells(line.slice(curPos)));
        handled = true;
        continue;
      }
      if (cur.t === 'para') {
        const inf = indentInfo(line, curPos);
        const content = line.slice(inf.next);
        // Is this paragraph inside a list item? Only then can an empty
        // list marker start a new item; otherwise an empty item cannot
        // interrupt a paragraph and the line continues it.
        let inListItem = false;
        for (let s = 0; s < stack.length - 1; s++) if (stack[s].t === 'item') { inListItem = true; break; }
        // An empty list item (a lone `-`) is a new item, not a setext underline.
        const d0 = detectBlock(line, curPos, true);
        if (d0 && d0.kind === 'list' && inListItem && isBlankFrom(line, d0.marker.contentStart)) {
          closeTop();
          createListItem(d0.marker, line);
          curPos = d0.marker.contentStart;
          continue;
        }
        // Setext underline? It must be indented at most 3 columns.
        const setext = inf.cols <= 3 ? isSetextLine(content) : 0;
        if (setext) {
          const paraText = stripLinkDefs(cur.lines.join('\n'), refs).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
          if (paraText.trim() !== '') {
            stack.pop();
            const parent = stack[stack.length - 1];
            parent.children[parent.children.length - 1] = { t: 'heading', level: setext, text: paraText };
            handled = true;
          } else {
            closeTop();
            continue;
          }
          continue;
        }
        // Table delimiter row? It must be indented at most 3 columns.
        const align = inf.cols <= 3 ? parseDelimiterRow(content) : null;
        if (align) {
          const paraText = stripLinkDefs(cur.lines.join('\n'), refs);
          if (paraText.trim() !== '') {
            const plines = paraText.split('\n');
            const headerLine = plines[plines.length - 1];
            const headerCells = splitRowCells(headerLine);
            if (headerCells.length === align.length && headerLine.trim() !== '') {
              const earlier = plines.slice(0, -1).join('\n');
              stack.pop();
              const parent = stack[stack.length - 1];
              const idx = parent.children.length - 1;
              const table = { t: 'table', align, header: headerCells, rows: [] };
              if (earlier.trim() !== '') {
                parent.children[idx] = { t: 'para', lines: earlier.split('\n'), text: earlier };
                parent.children.splice(idx + 1, 0, table);
              } else {
                parent.children[idx] = table;
              }
              stack.push(table);
              handled = true;
              continue;
            }
          }
        }
        // A block that interrupts the paragraph? An empty list item cannot
        // interrupt a paragraph that is not already inside a list.
        let d = detectBlock(line, curPos, true);
        // An ordered list inside a list item can interrupt a paragraph even
        // when it does not start at 1 (marked behaviour; at top level
        // cm-304 still forbids it).
        if (!d && inListItem) {
          const linf = indentInfo(line, curPos);
          const m = parseListMarker(line, linf.next, linf.cols);
          if (m && m.ordered) d = { kind: 'list', marker: m };
        }
        if (d && d.kind === 'list' && !inListItem && isBlankFrom(line, d.marker.contentStart)) {
          cur.lines.push(line.slice(curPos));
          handled = true;
          continue;
        }
        if (d) {
          closeTop();
          if (d.kind === 'list') {
            // A capped indent (5+ columns of whitespace after the marker)
            // leaves contentStart inside the run: expand the whole run
            // so the leftover columns survive as content indent.
            line = expandCappedMarker(line, d.marker);
            lines[i] = line;
            createListItem(d.marker, line);
            curPos = d.marker.contentStart;
            continue;
          }
          if (d.kind === 'quote') {
            // Strip the marker the way the reference does: expand the
            // tabs after '>' from the marker's own column, then drop the
            // marker plus one whitespace character. The content starts
            // at curPos in the rewritten line.
            const qinf = indentInfo(line, curPos);
            line = quoteContentLine(line, curPos, qinf.next);
            lines[i] = line;
            d.contentStart = curPos;
            const q = { t: 'quote', children: [] };
            addNode(q);
            stack.push(q);
            curPos = d.contentStart;
            continue;
          }
          startBlock(d, line, curPos);
          handled = true;
          continue;
        }
        // Otherwise the line continues the paragraph.
        cur.lines.push(line.slice(curPos));
        handled = true;
        continue;
      }
      // Container tip: start a new block (or a paragraph). A list can only
      // contain items; any other block closes the list first.
      const d = detectBlock(line, curPos, false);
      if (d && d.kind === 'list') {
        line = expandCappedMarker(line, d.marker);
        lines[i] = line;
        createListItem(d.marker, line);
        curPos = d.marker.contentStart;
        continue;
      }
      if (cur.t === 'list') {
        closeTop();
        continue;
      }
      if (d && d.kind === 'quote') {
        const qinf = indentInfo(line, curPos);
        line = quoteContentLine(line, curPos, qinf.next);
        lines[i] = line;
        d.contentStart = curPos;
        const q = { t: 'quote', children: [] };
        addNode(q);
        stack.push(q);
        curPos = d.contentStart;
        continue;
      }
      if (d) {
        startBlock(d, line, curPos);
        handled = true;
        continue;
      }
      const p = { t: 'para', lines: [line.slice(curPos)], text: '' };
      addNode(p);
      stack.push(p);
      handled = true;
    }
    i++;
  }
  // Close everything left open. HTML blocks still open here were open at
  // the end of the input (they keep a trailing newline when the input ends
  // with one).
  while (stack.length > 0) {
    const b = stack[stack.length - 1];
    if (b.t === 'html') b.openAtEOF = true;
    closeTop();
  }
  return { root, refs };
}

// ---------- rendering ----------

function renderBlocks(node, refs, out, endsWithNewline, noHtmlNL) {
  switch (node.t) {
    case 'doc':
      for (const c of node.children) renderBlocks(c, refs, out, endsWithNewline);
      break;
    case 'para':
      out.push('<p>' + inlineParse(node.text, refs) + '</p>\n');
      break;
    case 'heading':
      out.push('<h' + node.level + '>' + inlineParse(node.text, refs) + '</h' + node.level + '>\n');
      break;
    case 'code': {
      let content = node.lines.join('\n');
      if (content.length > 0 && !content.endsWith('\n')) content += '\n';
      out.push('<pre><code' + (node.lang ? ' class="language-' + escapeAttr(node.lang) + '"' : '') + '>' + escapeText(content) + '</code></pre>\n');
      break;
    }
    case 'html': {
      out.push(node.lines.join('\n'));
      if (node.trailingNL && !noHtmlNL) out.push('\n');
      break;
    }
    case 'quote':
      out.push('<blockquote>\n');
      for (let k = 0; k < node.children.length; k++) {
        const c = node.children[k];
        renderBlocks(c, refs, out, endsWithNewline, k === node.children.length - 1 && c.t === 'html');
      }
      out.push('</blockquote>\n');
      break;
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      out.push('<' + tag + (node.ordered && node.start !== 1 ? ' start="' + node.start + '"' : '') + '>\n');
      const tight = !node._blank;
      for (const item of node.children) renderItem(item, refs, out, tight, endsWithNewline);
      out.push('</' + tag + '>\n');
      break;
    }
    case 'hr':
      out.push('<hr>\n');
      break;
    case 'table': {
      out.push('<table>\n<thead>\n<tr>\n');
      for (let k = 0; k < node.header.length; k++) {
        out.push('<th' + (node.align[k] ? ' align="' + node.align[k] + '"' : '') + '>' + inlineParse(node.header[k], refs) + '</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      if (node.rows.length > 0) {
        out.push('<tbody>');
        for (const row of node.rows) {
          out.push('<tr>\n');
          for (let k = 0; k < node.header.length; k++) {
            const cell = k < row.length ? row[k] : '';
            out.push('<td' + (node.align[k] ? ' align="' + node.align[k] + '"' : '') + '>' + inlineParse(cell, refs) + '</td>\n');
          }
          out.push('</tr>\n');
        }
        out.push('</tbody>');
      }
      out.push('</table>\n');
      break;
    }
  }
}

function renderItem(item, refs, out, tight, endsWithNewline) {
  out.push('<li>');
  const taskHtml = item.task === 1 ? '<input disabled="" type="checkbox">'
    : item.task === 2 ? '<input checked="" disabled="" type="checkbox">' : '';
  // In a loose list the checkbox sits inside the first paragraph's <p>;
  // in a tight list it sits directly after <li>.
  const firstIsPara = item.children.length > 0 && item.children[0].t === 'para';
  if (taskHtml && tight) {
    out.push(taskHtml);
    if (item.children.length > 0) out.push(' ');
  }
  for (let k = 0; k < item.children.length; k++) {
    const c = item.children[k];
    if (tight && c.t === 'para') out.push(inlineParse(c.text, refs));
    else if (!tight && taskHtml && k === 0 && firstIsPara) {
      out.push('<p>' + taskHtml + ' ' + inlineParse(c.text, refs) + '</p>\n');
    } else renderBlocks(c, refs, out, endsWithNewline, k === item.children.length - 1 && c.t === 'html');
  }
  out.push('</li>\n');
}

export function parse(markdown) {
  docInLink = false;
  let s = markdown;
  const endsWithNewline = s.length > 0 && s.charCodeAt(s.length - 1) === 10;
  if (s.indexOf('\r') !== -1) s = s.replace(/\r\n?/g, '\n');
  const lines = s.split('\n');
  // A trailing newline does not add a blank line of its own.
  if (endsWithNewline) lines.pop();
  const { root, refs } = parseBlocks(lines, endsWithNewline);
  const out = [];
  renderBlocks(root, refs, out, endsWithNewline);
  return out.join('');
}
