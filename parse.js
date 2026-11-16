// Fast CommonMark 0.31.2 + GFM parser, byte-identical to marked 18.1.3 defaults.
// Line-based block parser + delimiter-stack inline parser. No dependencies.

// ---------- small helpers ----------
const SP = 32, TAB = 9, LT = 60, GT = 62, AMP = 38, QUOT = 34, SQ = 39;
const BK = 96, STAR = 42, US = 95, TILDE = 126, BANG = 33, LB = 91, RB = 93;
const LP = 40, RP = 41, BS = 92, SL = 47, HASH = 35, DASH = 45, PLUS = 43, DOT = 46;

function isWs(c) { return c === SP || c === TAB || c === 10 || c === 13; }
function isDigit(c) { return c >= 48 && c <= 57; }
function isAlpha(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isAlnum(c) { return isAlpha(c) || isDigit(c); }
function isPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
function escText(s) {
  let out = '', i = 0, j;
  for (;;) {
    j = s.length;
    for (let k = i; k < s.length; k++) {
      const c = s.charCodeAt(k);
      if (c === AMP || c === LT || c === GT || c === QUOT || c === SQ) { j = k; break; }
    }
    if (j === s.length) { out += s.slice(i); break; }
    out += s.slice(i, j);
    const c = s.charCodeAt(j);
    out += c === AMP ? '&amp;' : c === LT ? '&lt;' : c === GT ? '&gt;' : c === QUOT ? '&quot;' : '&#39;';
    i = j + 1;
  }
  return out;
}
function escAttr(s) {
  let out = '', i = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c === AMP) {
      const em = /^&(#\d{1,7}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]*);/.exec(s.slice(k));
      if (em) { out += s.slice(i, k + em[0].length); i = k + em[0].length; k = i - 1; continue; }
      out += s.slice(i, k) + '&amp;';
      i = k + 1;
    } else if (c === LT || c === GT || c === QUOT || c === SQ) {
      out += s.slice(i, k);
      out += c === LT ? '&lt;' : c === GT ? '&gt;' : c === QUOT ? '&quot;' : '&#39;';
      i = k + 1;
    }
  }
  return out + s.slice(i);
}
function numEnt(s, i) {
  let cp = 0, hex = false, j = i + 2;
  if (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88) { hex = true; j++; }
  const st = j;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (hex ? (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102) : c >= 48 && c <= 57) j++;
    else break;
  }
  if (j === st || j >= s.length || s.charCodeAt(j) !== 59) return null;
  cp = parseInt(s.slice(st, j), hex ? 16 : 10);
  if (!cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return { ch: '\uFFFD', end: j + 1 };
  return { ch: String.fromCodePoint(cp), end: j + 1 };
}
function entityAt(s, i) {
  if (s.charCodeAt(i) !== AMP) return null;
  const m = /^&(#\d+|#x[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/.exec(s.slice(i));
  if (!m) return null;
  if (m[1][0] === '#') return numEnt(s, i);
  return { ch: m[0], end: i + m[0].length };
}

// ---------- line cursor (column-aware, partial-tab aware) ----------
function cur(s) { return { s, i: 0, col: 0, pend: 0 }; }
function cPeek(c) { return c.pend > 0 ? SP : c.i < c.s.length ? c.s.charCodeAt(c.i) : -1; }
function cSave(c) { return [c.i, c.col, c.pend]; }
function cLoad(c, st) { c.i = st[0]; c.col = st[1]; c.pend = st[2]; }
function cSkipWs(c, n) {
  let need = n;
  if (need <= 0) return 0;
  if (c.pend > 0) {
    const take = Math.min(c.pend, need);
    c.pend -= take; c.col += take; need -= take;
    if (need === 0) return n;
  }
  while (need > 0 && c.i < c.s.length) {
    const ch = c.s.charCodeAt(c.i);
    if (ch === SP) { c.i++; c.col++; need--; }
    else if (ch === TAB) {
      const tw = 4 - (c.col & 3);
      if (tw <= need) { c.i++; c.col += tw; need -= tw; }
      else { c.pend = tw - need; c.col += need; need = 0; }
    } else break;
  }
  return n - need;
}
function cSkipOneSpace(c) { return cSkipWs(c, 1); }
function cRest(c) { return (c.pend > 0 ? ' '.repeat(c.pend) : '') + c.s.slice(c.i); }
function cAtEnd(c) { return c.pend === 0 && c.i >= c.s.length; }
function cBlank(c) {
  let i = c.i;
  while (i < c.s.length) { const ch = c.s.charCodeAt(i); if (ch !== SP && ch !== TAB) return false; i++; }
  return true;
}
function indentCols(s) {
  let col = 0, i = 0;
  while (i < s.length) {
    const ch = s.charCodeAt(i);
    if (ch === SP) { col++; i++; }
    else if (ch === TAB) { col += 4 - (col & 3); i++; }
    else break;
  }
  return col;
}
function normLabel(s) {
  return s.replace(/[\t\n ]+/g, ' ').trim().toLowerCase().replace(/\u00DF/g, 'ss');
}

// ---------- link reference definitions ----------
function parseDest(s, i) {
  const n = s.length;
  let j = i;
  while (j < n && (s.charCodeAt(j) === SP || s.charCodeAt(j) === TAB)) j++;
  if (j >= n) return null;
  if (s.charCodeAt(j) === LT) {
    const e = s.indexOf('>', j + 1);
    if (e < 0) return null;
    const d = s.slice(j + 1, e);
    if (d.indexOf('\n') >= 0 || d.indexOf('<') >= 0) return null;
    return { dest: d, end: e + 1 };
  }
  let depth = 0, k = j;
  while (k < n) {
    const ch = s.charCodeAt(k);
    if (ch === SP || ch === TAB || ch === 10) break;
    if (ch === LP) depth++;
    else if (ch === RP) { if (depth === 0) break; depth--; }
    else if (ch === 92 && k + 1 < n && isPunct(s.charCodeAt(k + 1))) { k += 2; continue; }
    k++;
  }
  if (k === j) return null;
  return { dest: s.slice(j, k), end: k };
}
function parseTitle(s, i) {
  const n = s.length;
  let j = i;
  while (j < n && (s.charCodeAt(j) === SP || s.charCodeAt(j) === TAB)) j++;
  if (j >= n) return null;
  const q = s.charCodeAt(j);
  if (q !== QUOT && q !== SQ && q !== LP) return null;
  const close = q === LP ? RP : q;
  let k = j + 1;
  while (k < n) {
    const ch = s.charCodeAt(k);
    if (ch === BS && k + 1 < n && isPunct(s.charCodeAt(k + 1))) { k += 2; continue; }
    if (ch === close) return { title: s.slice(j + 1, k), end: k + 1 };
    k++;
  }
  return null;
}
function skipWsNl(s, i) {
  let j = i;
  while (j < s.length && (s.charCodeAt(j) === SP || s.charCodeAt(j) === TAB || s.charCodeAt(j) === 10)) j++;
  return j;
}
function parseRefDef(c, lines, li) {
  const s = c.s;
  const st = cSave(c);
  cSkipWs(c, 3);
  if (cPeek(c) !== LB) { cLoad(c, st); return null; }
  c.i++; c.col++;
  let j = c.i, depth = 1;
  while (j < s.length) {
    const ch = s.charCodeAt(j);
    if (ch === LB) depth++;
    else if (ch === RB) { depth--; if (depth === 0) break; }
    else if (ch === BS && j + 1 < s.length) j++;
    j++;
  }
  if (depth !== 0 || j >= s.length) { cLoad(c, st); return null; }
  const label = s.slice(c.i, j);
  if (!label.trim()) { cLoad(c, st); return null; }
  c.i = j + 1; c.col = j + 1;
  let p2 = c.i;
  while (p2 < s.length && (s.charCodeAt(p2) === SP || s.charCodeAt(p2) === TAB)) p2++;
  if (p2 >= s.length || s.charCodeAt(p2) !== 58) { cLoad(c, st); return null; }
  c.i = p2 + 1; c.col = p2 + 1;
  // dest: same line, or (if the line ends here) on the next line
  let d = null;
  let destLine = li;
  let destStr = s;
  let p = c.i;
  while (p < s.length && (s.charCodeAt(p) === SP || s.charCodeAt(p) === TAB)) p++;
  if (p < s.length) d = parseDest(s, p);
  if (!d && p >= s.length && lines && li + 1 < lines.length) {
    const nl = lines[li + 1];
    let k = 0;
    while (k < nl.length && (nl.charCodeAt(k) === SP || nl.charCodeAt(k) === TAB)) k++;
    d = parseDest(nl, k);
    if (d) { destLine = li + 1; destStr = nl; }
  }
  if (!d) { cLoad(c, st); return null; }
  let title = '';
  let next = destLine;
  // title on the dest line: must be preceded by whitespace
  let e0 = d.end;
  while (e0 < destStr.length && (destStr.charCodeAt(e0) === SP || destStr.charCodeAt(e0) === TAB)) e0++;
  const t = (e0 > d.end) ? parseTitle(destStr, e0) : null;
  if (t) {
    title = t.title;
    let e = t.end;
    while (e < destStr.length && (destStr.charCodeAt(e) === SP || destStr.charCodeAt(e) === TAB)) e++;
    if (e < destStr.length) { cLoad(c, st); return null; }
    if (destLine === li) { c.i = t.end; c.col = t.end; }
  } else {
    let e = d.end;
    while (e < destStr.length && (destStr.charCodeAt(e) === SP || destStr.charCodeAt(e) === TAB)) e++;
    if (e < destStr.length) { cLoad(c, st); return null; }
    if (destLine === li) { c.i = d.end; c.col = d.end; }
    if (lines && destLine + 1 < lines.length) {
      const nl = lines[destLine + 1];
      let k = 0;
      while (k < nl.length && (nl.charCodeAt(k) === SP || nl.charCodeAt(k) === TAB)) k++;
      const t2 = parseTitle(nl, k);
      if (t2) {
        let e2 = t2.end;
        while (e2 < nl.length && (nl.charCodeAt(e2) === SP || nl.charCodeAt(e2) === TAB)) e2++;
        if (e2 >= nl.length) { title = t2.title; next = destLine + 1; }
      }
    }
  }
  return { label: normLabel(label), dest: d.dest, title, next };
}
function stripRefDefs(text, refs) {
  const lines = text.split('\n');
  let i = 0;
  let rest = text;
  while (i < lines.length) {
    const c = cur(lines[i]);
    const d = parseRefDef(c, lines, i);
    if (!d || !cBlank(c)) break;
    if (!refs.has(d.label)) refs.set(d.label, { dest: d.dest, title: d.title });
    i = d.next + 1;
    rest = lines.slice(i).join('\n');
  }
  return rest;
}

// ---------- module state ----------
let stack = [];
let root = [];
let para = null;
let fence = null;
let indCode = null;
let htmlBlock = null;
let lastHtmlNode = null;
let table = null;
let refs = new Map();
let inLink = false;

  // ---------- block parser: detectors ----------
  const HTML_END = [
    /<\/script\s*>/i, /<\/pre\s*>/i, /<\/style\s*>/i, /<\/textarea\s*>/i,
  ];
  function atxHeading(c) {
    const st = cSave(c);
    cSkipWs(c, 3);
    let lvl = 0;
    while (cPeek(c) === HASH && lvl < 7) { c.i++; c.col++; lvl++; }
    if (lvl === 0 || lvl > 6) { cLoad(c, st); return null; }
    const p = cPeek(c);
    if (p !== -1 && p !== SP && p !== TAB) { cLoad(c, st); return null; }
    if (p === SP || p === TAB) { c.i++; c.col++; c.pend = 0; }
    let s = cRest(c);
    let e = s.length;
    while (e > 0 && (s.charCodeAt(e - 1) === SP || s.charCodeAt(e - 1) === TAB)) e--;
    let hashEnd = e;
    while (hashEnd > 0 && s.charCodeAt(hashEnd - 1) === HASH) hashEnd--;
    if (hashEnd < e) {
      if (hashEnd === 0) { s = ''; }
      else if (s.charCodeAt(hashEnd - 1) === SP || s.charCodeAt(hashEnd - 1) === TAB) {
        s = s.slice(0, hashEnd);
        let e2 = s.length;
        while (e2 > 0 && (s.charCodeAt(e2 - 1) === SP || s.charCodeAt(e2 - 1) === TAB)) e2--;
        s = s.slice(0, e2);
      }
    }
    let b = 0;
    while (b < s.length && (s.charCodeAt(b) === SP || s.charCodeAt(b) === TAB)) b++;
    let e3 = s.length;
    while (e3 > b && (s.charCodeAt(e3 - 1) === SP || s.charCodeAt(e3 - 1) === TAB)) e3--;
    return { t: 'head', level: lvl, text: s.slice(b, e3) };
  }
  function setextLine(c) {
    const s = cRest(c);
    let i = 0;
    while (i < s.length && (s.charCodeAt(i) === SP || s.charCodeAt(i) === TAB)) i++;
    if (i > 3) return 0;
    const ch = s.charCodeAt(i);
    if (ch !== 61 && ch !== DASH) return 0;
    let j = i;
    while (j < s.length && s.charCodeAt(j) === ch) j++;
    while (j < s.length && (s.charCodeAt(j) === SP || s.charCodeAt(j) === TAB)) j++;
    if (j !== s.length) return 0;
    return ch === 61 ? 1 : 2;
  }
  function hrLine(c) {
    const st = cSave(c);
    cSkipWs(c, 3);
    const ch = cPeek(c);
    if (ch !== DASH && ch !== STAR && ch !== US) { cLoad(c, st); return false; }
    let count = 0;
    while (!cAtEnd(c)) {
      const p = cPeek(c);
      if (p === ch) { count++; c.i++; c.col++; c.pend = 0; }
      else if (p === SP || p === TAB) { c.i++; c.col++; c.pend = 0; }
      else { cLoad(c, st); return false; }
    }
    if (count < 3) { cLoad(c, st); return false; }
    return true;
  }
  function fenceStart(c) {
    const st = cSave(c);
    let ind = 0;
    while (ind < 3) {
      const p = cPeek(c);
      if (p === SP) { c.i++; c.col++; ind++; }
      else if (p === TAB) { const tw = 4 - (c.col & 3); if (c.col + tw > 3) { cLoad(c, st); return null; } c.i++; c.col += tw; ind += tw; }
      else break;
    }
    const ch = cPeek(c);
    if (ch !== BK && ch !== TILDE) { cLoad(c, st); return null; }
    let len = 0;
    while (cPeek(c) === ch) { c.i++; c.col++; len++; }
    if (len < 3) { cLoad(c, st); return null; }
    let info = cRest(c);
    if (ch === BK && info.indexOf('`') >= 0) { cLoad(c, st); return null; }
    info = info.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
    let e = info.length;
    while (e > 0 && (info.charCodeAt(e - 1) === SP || info.charCodeAt(e - 1) === TAB)) e--;
    let b = 0;
    while (b < e && (info.charCodeAt(b) === SP || info.charCodeAt(b) === TAB)) b++;
    info = info.slice(b, e);
    return { ch, len, indent: ind, info, tilde: ch === TILDE };
  }
  function fenceEnd(c, f) {
    const st = cSave(c);
    cSkipWs(c, 3);
    if (cPeek(c) !== f.ch) { cLoad(c, st); return false; }
    let len = 0;
    while (cPeek(c) === f.ch) { c.i++; c.col++; len++; }
    if (len < f.len) { cLoad(c, st); return false; }
    let rest = cRest(c);
    if (f.tilde) {
      let k = 0;
      while (k < rest.length && (rest.charCodeAt(k) === SP || rest.charCodeAt(k) === TAB)) k++;
      if (k !== rest.length) { cLoad(c, st); return false; }
    } else {
      if (rest.trim() !== '') { cLoad(c, st); return false; }
    }
    return true;
  }
  function htmlStart(rest) {
    let i = 0;
    while (i < rest.length && (rest.charCodeAt(i) === SP || rest.charCodeAt(i) === TAB)) i++;
    if (i > 3) return null;
    const s = rest.slice(i);
    let m = /^<(script|pre|style|textarea)(?:\s|\/?>|$)/i.exec(s);
    if (m) return { type: 1, end: HTML_END[m[1].toLowerCase() === 'script' ? 0 : m[1].toLowerCase() === 'pre' ? 1 : m[1].toLowerCase() === 'style' ? 2 : 3] };
    m = /^<!--/.exec(s);
    if (m) return { type: 2, end: /-->/ };
    m = /^<\?/.exec(s);
    if (m) return { type: 3, end: /\?>/ };
    m = /^<![A-Za-z]/.exec(s);
    if (m) return { type: 4, end: />/ };
    m = /^<!\[CDATA\[/.exec(s);
    if (m) return { type: 5, end: /\]\]>/ };
    m = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s>\/]|$)/.exec(s);
    if (m) {
      const tag = m[1].toLowerCase();
      const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body', 'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem', 'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul']);
      if (BLOCK_TAGS.has(tag)) {
        if (s.startsWith('</')) {
          let q = m[0].length;
          while (q < s.length && (s.charCodeAt(q) === SP || s.charCodeAt(q) === TAB)) q++;
          if (q < s.length && s.charCodeAt(q) !== GT) return null;
        }
        return { type: 6, end: null };
      }
      // type 7: a complete tag alone on the line (validated strictly)
      const tagV = parseHtmlTag(s, 0);
      if (tagV) {
        let rest = s.slice(tagV.end);
        let k = 0;
        while (k < rest.length && (rest.charCodeAt(k) === SP || rest.charCodeAt(k) === TAB)) k++;
        if (k === rest.length) return { type: 7, end: null };
      }
    }
    return null;
  }
  function listMarker(c) {
    const st = cSave(c);
    let ind = 0;
    while (ind < 3) {
      const p = cPeek(c);
      if (p === SP) { c.i++; c.col++; ind++; }
      else if (p === TAB) { const tw = 4 - (c.col & 3); if (c.col + tw > 3) { cLoad(c, st); return null; } c.i++; c.col += tw; ind += tw; }
      else break;
    }
    const ch = cPeek(c);
    let bullet = false, ordered = false, start = 0, delim = '', mlen = 0;
    if (ch === DASH || ch === PLUS || ch === STAR) {
      bullet = true; delim = String.fromCharCode(ch); mlen = 1;
      c.i++; c.col++;
    } else if (ch >= 48 && ch <= 57) {
      let j = c.i, num = 0, digits = 0;
      while (j < c.s.length && c.s.charCodeAt(j) >= 48 && c.s.charCodeAt(j) <= 57 && digits < 10) { num = num * 10 + (c.s.charCodeAt(j) - 48); digits++; j++; }
      if (digits === 0 || digits > 9) { cLoad(c, st); return null; }
      if (j >= c.s.length) { cLoad(c, st); return null; }
      const d = c.s.charCodeAt(j);
      if (d !== DOT && d !== RP) { cLoad(c, st); return null; }
      ordered = true; start = num; delim = String.fromCharCode(d); mlen = digits + 1;
      c.i = j + 1; c.col = j + 1;
    } else { cLoad(c, st); return null; }
    const p = cPeek(c);
    if (p === -1) return { bullet, ordered, start, delim, mlen, contentCol: ind + mlen + 1, empty: true };
    if (p !== SP && p !== TAB) { cLoad(c, st); return null; }
    let w = 0;
    {
      let i = c.i, cc = c.col;
      while (i < c.s.length) {
        const ch2 = c.s.charCodeAt(i);
        if (ch2 === SP) { cc++; i++; }
        else if (ch2 === TAB) { cc += 4 - (cc & 3); i++; }
        else break;
      }
      w = cc - c.col;
    }
    // empty item: only whitespace after the marker
    let ei = c.i;
    while (ei < c.s.length && (c.s.charCodeAt(ei) === SP || c.s.charCodeAt(ei) === TAB)) ei++;
    if (ei >= c.s.length && w >= 1) return { bullet, ordered, start, delim, mlen, contentCol: ind + mlen + 1, empty: true };
    const contentCol = w >= 5 ? ind + mlen + 1 : ind + mlen + w;
    // consume the separator whitespace up to the content column
    // (toSkip is a relative column count, so it works inside containers)
    cSkipWs(c, contentCol - (ind + mlen));
    return { bullet, ordered, start, delim, mlen, contentCol, empty: false };
  }
  function sameList(m, node) {
    if (m.ordered !== node.ordered) return false;
    return m.delim === node.delim;
  }
  function tryQuote(c) {
    const st = cSave(c);
    cSkipWs(c, 3);
    if (cPeek(c) !== GT) { cLoad(c, st); return false; }
    c.i++; c.col++; c.pend = 0;
    if (cPeek(c) === SP || cPeek(c) === TAB) cSkipWs(c, 1);
    return true;
  }
  function tryItem(c, it) {
    if (cBlank(c)) return true;
    // an empty item followed by a blank line is closed; later content
    // does not belong to it
    if (it.node.blocks.length === 0 && it.node.blankAfter) return false;
    const st = cSave(c);
    const got = cSkipWs(c, it.contentCol);
    if (got < it.contentCol) { cLoad(c, st); return false; }
    return true;
  }
  function closeContainers(n) {
    closePara(); closeCode(); closeFence(); closeHtml(); closeTable();
    while (stack.length > n) stack.pop();
  }

  // ---------- tables ----------
  function tableDelim(line) {
    let s = line;
    let i = 0;
    while (i < s.length && (s.charCodeAt(i) === SP || s.charCodeAt(i) === TAB)) i++;
    if (i > 3) return null;
    s = s.slice(i);
    if (s.charCodeAt(0) === 124) s = s.slice(1);
    if (s.length && s.charCodeAt(s.length - 1) === 124) s = s.slice(0, -1);
    const parts = s.split('|');
    if (!parts.length) return null;
    const aligns = [];
    for (const p of parts) {
      let a = 0, b = p.length;
      while (a < b && p.charCodeAt(a) === SP) a++;
      while (b > a && p.charCodeAt(b - 1) === SP) b--;
      const t = p.slice(a, b);
      if (!t.length) return null;
      const left = t.charCodeAt(0) === 58, right = t.charCodeAt(t.length - 1) === 58;
      let k = left ? 1 : 0;
      const end = right ? t.length - 1 : t.length;
      if (k >= end) return null;
      for (; k < end; k++) if (t.charCodeAt(k) !== 45) return null;
      aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
    }
    return aligns;
  }
  function splitRow(line) {
    const cells = [];
    // find code-span ranges: a run of L backticks opens only if a run of exactly L follows
    const n0 = line.length;
    const inSpan = new Uint8Array(n0);
    let i0 = 0;
    while (i0 < n0) {
      if (line.charCodeAt(i0) !== 96) { i0++; continue; }
      let j0 = i0;
      while (j0 < n0 && line.charCodeAt(j0) === 96) j0++;
      const L = j0 - i0;
      let k0 = j0, found = -1;
      while (k0 < n0) {
        if (line.charCodeAt(k0) === 96) {
          let m0 = k0;
          while (m0 < n0 && line.charCodeAt(m0) === 96) m0++;
          if (m0 - k0 === L) { found = k0; break; }
          k0 = m0;
        } else k0++;
      }
      if (found < 0) { i0 = j0; continue; }
      for (let p = i0; p < found + L; p++) inSpan[p] = 1;
      i0 = found + L;
    }
    let cur = '', i = 0, n = line.length;
    while (i < n && (line.charCodeAt(i) === SP || line.charCodeAt(i) === TAB)) i++;
    if (i < n && line.charCodeAt(i) === 124) i++;
    for (; i < n; i++) {
      const ch = line.charCodeAt(i);
      if (ch === 92 && i + 1 < n && line.charCodeAt(i + 1) === 124) { cur += '|'; i++; continue; }
      if (ch === 124 && !inSpan[i]) { cells.push(cur.trim()); cur = ''; continue; }
      cur += line[i];
    }
    cells.push(cur.trim());
    if (cells.length > 1 && cells[cells.length - 1] === '') {
      let j = n - 1;
      while (j >= 0 && (line.charCodeAt(j) === SP || line.charCodeAt(j) === TAB)) j--;
      if (j >= 0 && line.charCodeAt(j) === 124) cells.pop();
    }
    return cells;
  }

  // ---------- state closers ----------
  function closePara() {
    if (!para) return;
    while (para.lines.length > 1 && para.lines[0] === '') para.lines.shift();
    const text = para.lines.join('\n');
    const rest = stripRefDefs(text, refs);
    const lst = para.list;
    if (rest.trim() === '') {
      const idx = lst.indexOf(para);
      if (idx >= 0) lst.splice(idx, 1);
    } else {
      para.text = rest;
    }
    para = null;
  }
  function closeCode() {
    if (!indCode) return;
    while (indCode.lines.length && indCode.lines[indCode.lines.length - 1] === '') indCode.lines.pop();
    indCode.text = indCode.lines.join('\n');
    if (indCode.text.length && !indCode.text.endsWith('\n')) indCode.text += '\n';
    indCode = null;
  }
  function closeFence() {
    if (!fence) return;
    fence.node.text = fence.node.lines.join('\n');
    if (fence.node.text.length && !fence.node.text.endsWith('\n')) fence.node.text += '\n';
    fence = null;
  }
  function closeHtml() {
    if (!htmlBlock) return;
    htmlBlock.node.text = htmlBlock.node.lines.join('\n');
    lastHtmlNode = htmlBlock.node;
    htmlBlock = null;
  }
  function closeTable() { table = null; }
  function children() {
    if (!stack.length) return root;
    const top = stack[stack.length - 1];
    if (top.t === 'item') return top.node.blocks;
    if (top.t === 'quote') return top.node.blocks;
    const it = top.node.items[top.node.items.length - 1];
    return it ? it.blocks : root;
  }
  function markBlank() {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].t === 'item') {
        if (i === stack.length - 1) {
          for (let k = i; k >= 0; k--) if (stack[k].t === 'item') stack[k].node.blankAfter = true;
        }
        return;
      }
    }
  }
  function checkLoose() {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].t === 'item') {
        if (stack[i].node.blankAfter) {
          const lst = stack[i - 1];
          if (lst && lst.t === 'list') lst.node.loose = true;
        }
        // the blank line was consumed by content inside this item, so it
        // does not separate any ancestor items either
        for (let k = i; k >= 0; k--) if (stack[k].t === 'item') stack[k].node.blankAfter = false;
        return;
      }
    }
  }
  function openListItem(m, c) {
    let lst = null;
    if (stack.length && stack[stack.length - 1].t === 'list') {
      const top = stack[stack.length - 1];
      if (sameList(m, top.node)) lst = top.node;
      else closeContainers(stack.length - 1);
    }
    if (!lst) {
      checkLoose();
      const node = { t: 'list', ordered: m.ordered, bullet: m.bullet, start: m.start, delim: m.delim, items: [], loose: false };
      children().push(node);
      stack.push({ t: 'list', node });
      lst = node;
    } else {
      const prev = lst.items[lst.items.length - 1];
      if (prev && prev.blankAfter) { lst.loose = true; prev.blankAfter = false; }
    }
    const item = { t: 'item', blocks: [], blankAfter: false, contentCol: m.contentCol };
    lst.items.push(item);
    stack.push({ t: 'item', node: item, contentCol: m.contentCol });
    if (m.empty) return;
    processStarts(c, m.contentCol);
  }
  function isBlockStartLazy(c) {
    const st = cSave(c);
    let r = false;
    if (atxHeading(c)) r = true;
    else { cLoad(c, st); if (fenceStart(c)) r = true; }
    if (!r) { cLoad(c, st); if (htmlStart(cRest(c))) r = true; }
    if (!r) { cLoad(c, st); if (hrLine(c)) r = true; }
    if (!r) { cLoad(c, st); if (listMarker(c)) r = true; }
    cLoad(c, st);
    return r;
  }
  function matchContainers(c) {
    for (let i = 0; i < stack.length; i++) {
      const s = stack[i];
      if (s.t === 'quote') {
        if (!tryQuote(c)) {
          if (para && !cBlank(c) && !isBlockStartLazy(c)) return { fail: i, lazy: true };
          return { fail: i, lazy: false };
        }
      } else if (s.t === 'item') {
        if (tryItem(c, s)) continue;
        if (para && !cBlank(c) && !isBlockStartLazy(c)) return { fail: i, lazy: true };
        return { fail: i, lazy: false };
      }
    }
    return { fail: stack.length, lazy: false };
  }
  // ---------- paragraph line text ----------
  function expandLeadingTabs(s, startCol) {
    let i = 0, hasTab = false;
    while (i < s.length) {
      const ch = s.charCodeAt(i);
      if (ch === SP) i++;
      else if (ch === TAB) { hasTab = true; i++; }
      else break;
    }
    if (!hasTab) return s;
    let out = '', col = startCol;
    for (let j = 0; j < i; j++) {
      const ch = s.charCodeAt(j);
      if (ch === SP) { out += ' '; col++; }
      else { const w = 4 - (col & 3); out += ' '.repeat(w); col += w; }
    }
    return out + s.slice(i);
  }
  function paraText(c, inContainer, lazy) {
    let s = cRest(c);
    if (lazy) {
      let col = c.col + c.pend, i = 0, wsCols = 0;
      while (i < s.length) {
        const ch = s.charCodeAt(i);
        if (ch === SP) { col++; i++; wsCols++; }
        else if (ch === TAB) { const w = 4 - (col & 3); col += w; i++; wsCols += w; }
        else break;
      }
      if (wsCols >= 4) {
        let col2 = c.col + c.pend, j = 0, stripped = 0, rem = 0;
        while (j < s.length && stripped < 4) {
          const ch = s.charCodeAt(j);
          if (ch === SP) { j++; stripped++; col2++; }
          else if (ch === TAB) {
            const w = 4 - (col2 & 3);
            if (stripped + w > 4) { rem = stripped + w - 4; j++; break; }
            j++; stripped += w; col2 += w;
          } else break;
        }
        s = ' '.repeat(rem) + s.slice(j);
      }
    }
    if (inContainer) s = expandLeadingTabs(s, c.col + c.pend);
    if (c.pend > 0) s = ' '.repeat(c.pend) + s;
    return s;
  }
  function lazyLineText(c) {
    let s = cRest(c);
    if (c.pend > 0) s = ' '.repeat(c.pend) + s;
    let col = c.col + c.pend, i = 0, wsCols = 0;
    while (i < s.length) {
      const ch = s.charCodeAt(i);
      if (ch === SP) { col++; i++; wsCols++; }
      else if (ch === TAB) { const w = 4 - (col & 3); col += w; i++; wsCols += w; }
      else break;
    }
    if (wsCols < 4) return s;
    let col2 = c.col + c.pend, j = 0, stripped = 0;
    while (j < s.length && stripped < 4) {
      const ch = s.charCodeAt(j);
      if (ch === SP) { j++; stripped++; col2++; }
      else if (ch === TAB) {
        const w = 4 - (col2 & 3);
        if (stripped + w > 4) { const rem = stripped + w - 4; return ' '.repeat(rem) + s.slice(j + 1); }
        j++; stripped += w; col2 += w;
      } else break;
    }
    return s.slice(j);
  }

  // ---------- dispatcher & main loop ----------
  function openParaAt(c, indent) {
    checkLoose();
    if (indent > c.col) cSkipWs(c, indent - c.col);
    const node = { t: 'para', lines: [], list: children() };
    children().push(node);
    para = node;
    para.lines.push(paraText(c, stack.length > 0));
  }
  function isBlockStart(c) {
    const st = cSave(c);
    let r = false;
    if (atxHeading(c)) r = true;
    else { cLoad(c, st); if (fenceStart(c)) r = true; }
    if (!r) { cLoad(c, st); if (htmlStart(cRest(c))) r = true; }
    if (!r) { cLoad(c, st); if (hrLine(c)) r = true; }
    if (!r) { cLoad(c, st); if (listMarker(c)) r = true; }
    if (!r) {
      cLoad(c, st);
      cSkipWs(c, 3);
      if (cPeek(c) === GT) r = true;
    }
    if (!r) {
      cLoad(c, st);
      if (cSkipWs(c, 4) >= 4 && !cAtEnd(c)) r = true;
    }
    cLoad(c, st);
    return r;
  }
  function processStarts(c, indent) {
    if (table) {
      if (!isBlockStart(c)) { table.rows.push(splitRow(cRest(c))); return; }
      closeTable();
    }
    const entry = cSave(c);
    if (para) {
      const lv = setextLine(c);
      if (lv) {
        const text = para.lines.join('\n');
        const rest = stripRefDefs(text, refs).trim();
        if (rest !== '') {
          para.list[para.list.length - 1] = { t: 'head', level: lv, text: rest };
          para = null;
          return;
        }
      }
      cLoad(c, entry);
      if (para.lines.length === 1) {
        const al = tableDelim(cRest(c));
        if (al) {
          const headCells = splitRow(para.lines[0]);
          if (headCells.length === al.length) {
            const node = { t: 'table', head: headCells, aligns: al, rows: [] };
            para.list[para.list.length - 1] = node;
            table = node;
            para = null;
            return;
          }
        }
      }
      cLoad(c, entry);
    }
    const atx = atxHeading(c);
    if (atx) { closePara(); children().push(atx); return; }
    cLoad(c, entry);
    {
      const qSt = cSave(c);
      cSkipWs(c, 3);
      if (cPeek(c) === GT) {
        closePara();
        const node = { t: 'quote', blocks: [] };
        children().push(node);
        stack.push({ t: 'quote', node });
        c.i++; c.col++; c.pend = 0;
        if (cPeek(c) === SP || cPeek(c) === TAB) cSkipWs(c, 1);
        processStarts(c, c.col);
        return;
      }
      cLoad(c, qSt);
    }
    const f = fenceStart(c);
    if (f) {
      closePara();
      const node = { t: 'code', lines: [], info: f.info, fenced: true };
      children().push(node);
      fence = { node, ch: f.ch, len: f.len, indent: f.indent, tilde: f.tilde };
      return;
    }
    cLoad(c, entry);
    const rest0 = cRest(c);
    const hb = htmlStart(rest0);
    if (hb && (hb.type !== 7 || !para)) {
      closePara();
      const node = { t: 'html', lines: [rest0], type: hb.type };
      children().push(node);
      if (hb.end && hb.end.test(rest0)) { node.text = rest0; lastHtmlNode = node; return; }
      htmlBlock = { node, type: hb.type, end: hb.end || null };
      return;
    }
    if (hrLine(c)) {
      closePara();
      // a thematic break ends any open list, unless it is the content of a
      // list item that was just opened (its blocks are still empty)
      const top = stack.length ? stack[stack.length - 1] : null;
      const freshItem = top && top.t === 'item' && top.node.blocks.length === 0;
      if (!freshItem) {
        while (stack.length && (stack[stack.length - 1].t === 'list' || stack[stack.length - 1].t === 'item')) stack.pop();
      }
      children().push({ t: 'hr' });
      return;
    }
    cLoad(c, entry);
    const m = listMarker(c);
    if (m) {
      if (para && m.ordered && m.start !== 1) { cLoad(c, entry); }
      else if (para && m.empty) { cLoad(c, entry); }
      else { closePara(); openListItem(m, c); return; }
    } else cLoad(c, entry);
    if (!para) {
      const indSt = cSave(c);
      const ind = cSkipWs(c, 4);
      if (ind >= 4 && !cAtEnd(c)) {
        checkLoose();
        const node = { t: 'code', lines: [], info: '', fenced: false };
        children().push(node);
        indCode = node;
        indCode.lines.push(cRest(c));
        return;
      }
      cLoad(c, indSt);
    }
    if (!para) { checkLoose(); openParaAt(c, indent); }
    else para.lines.push(paraText(c, stack.length > 0));
  }
  function processLine(raw) {
    for (;;) {
      const c = cur(raw);
      if (fence) {
        const m = matchContainers(c);
        if (m.fail < stack.length) { closeContainers(m.fail); continue; }
        if (fenceEnd(c, fence)) { closeFence(); return; }
        let s = cRest(c);
        if (!fence.tilde) {
          let k = 0;
          while (k < fence.indent && k < s.length && (s.charCodeAt(k) === SP || s.charCodeAt(k) === TAB)) k++;
          s = s.slice(k);
        }
        fence.node.lines.push(s);
        return;
      }
      if (indCode) {
        const m = matchContainers(c);
        if (m.fail < stack.length) { closeContainers(m.fail); continue; }
        if (cBlank(c)) { cSkipWs(c, 4); indCode.lines.push(cRest(c)); return; }
        const st = cSave(c);
        if (cSkipWs(c, 4) >= 4) { indCode.lines.push(cRest(c)); return; }
        cLoad(c, st);
        closeCode();
        continue;
      }
      if (htmlBlock) {
        const m = matchContainers(c);
        if (m.fail < stack.length) { closeContainers(m.fail); continue; }
        if (cBlank(c)) {
          if (htmlBlock.type >= 6) { closeHtml(); continue; }
          htmlBlock.node.lines.push('');
          return;
        }
        const s = cRest(c);
        htmlBlock.node.lines.push(s);
        if (htmlBlock.end && htmlBlock.end.test(s)) closeHtml();
        return;
      }
      const m = matchContainers(c);
      if (m.fail < stack.length) {
        if (m.lazy) {
          if (m.fail > 0) para.lines.push(paraText(c, true, true));
          else para.lines.push(lazyLineText(c));
          return;
        }
        closeContainers(m.fail);
        continue;
      }
      if (cBlank(c)) {
        // a line that is whitespace-only AFTER a container marker was
        // consumed still contributes that whitespace to the paragraph
        if (para && stack.length > 0 && cRest(c).length > 0) { para.lines.push(cRest(c)); return; }
        closePara(); closeTable(); markBlank(); if (lastHtmlNode) { lastHtmlNode.blankAfter = true; lastHtmlNode = null; } return;
      }
      if (stack.length && stack[stack.length - 1].t === 'list') {
        const st = cSave(c);
        const lm = listMarker(c);
        cLoad(c, st);
        if (!lm || !sameList(lm, stack[stack.length - 1].node)) {
          closeContainers(stack.length - 1);
          continue;
        }
      }
      lastHtmlNode = null;
      processStarts(c, c.col);
      return;
    }
  }

  // ---------- inline helpers ----------
  const PUNCT = '!\"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
  const PUNCT_RE = /[\p{P}\p{S}]/u;
  function isPunctS(ch) {
    if (ch === '') return false;
    const code = ch.charCodeAt(0);
    if (code < 128) return PUNCT.indexOf(ch) >= 0;
    return PUNCT_RE.test(ch);
  }
  function isWsCh(ch) {
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') return true;
    if (ch === '') return false;
    const code = ch.charCodeAt(0);
    if (code < 128) return false;
    return /\s/.test(ch);
  }
  function flanking(text, i, j) {
    const prev = i > 0 ? text[i - 1] : '';
    const next = j < text.length ? text[j] : '';
    const prevWs = prev === '' || isWsCh(prev);
    const nextWs = next === '' || isWsCh(next);
    const prevP = isPunctS(prev);
    const nextP = isPunctS(next);
    const leftF = !nextWs && (!nextP || prevWs || prevP);
    const rightF = !prevWs && (!prevP || nextWs || nextP);
    return { leftF, rightF };
  }
  function findCodeEnd(text, i, tickLen) {
    let j = i;
    const n = text.length;
    while (j < n) {
      if (text.charCodeAt(j) === 96) {
        let k = j;
        while (k < n && text.charCodeAt(k) === 96) k++;
        if (k - j === tickLen) return j;
        j = k;
      } else j++;
    }
    return -1;
  }
  const DISALLOWED = new Set(['title', 'textarea', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'script', 'plaintext']);
  function parseHtmlTag(text, i) {
    const n = text.length;
    if (i + 1 >= n) return null;
    const c1 = text[i + 1];
    if (c1 === '!') {
      if (text.startsWith('<!-->', i)) {
        return { html: '<!-->', end: i + 5 };
      }
      if (text.startsWith('<!--->', i)) {
        return { html: '<!--->', end: i + 6 };
      }
      if (text.startsWith('<!--', i)) {
        const e = text.indexOf('-->', i + 4);
        if (e < 0) return null;
        return { html: text.slice(i, e + 3), end: e + 3 };
      }
      if (text.startsWith('<![CDATA[', i)) {
        const e = text.indexOf(']]>', i + 9);
        if (e < 0) return null;
        return { html: text.slice(i, e + 3), end: e + 3 };
      }
      const m = /^<![A-Za-z][^>]*>/.exec(text.slice(i));
      if (m) return { html: m[0], end: i + m[0].length };
      return null;
    }
    if (c1 === '?') {
      const e = text.indexOf('?>', i + 2);
      if (e < 0) return null;
      return { html: text.slice(i, e + 2), end: e + 2 };
    }
    let j = i + 1;
    let closing = false;
    if (text[j] === '/') { closing = true; j++; }
    const nameStart = j;
    if (j >= n || !/[A-Za-z]/.test(text[j])) return null;
    while (j < n && /[A-Za-z0-9-]/.test(text[j])) j++;
    if (j === nameStart) return null;
    const name = text.slice(nameStart, j).toLowerCase();
    if (closing) {
      let k = j;
      while (k < n && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
      if (k >= n || text[k] !== '>') return null;
      const html = text.slice(i, k + 1);
      return { html: DISALLOWED.has(name) ? escText(html) : html, end: k + 1 };
    }
    let k = j;
    // validate attributes: (ws+ name (= value)?)* ws* /? >
    for (;;) {
      let ws = 0;
      while (k < n && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) { k++; ws++; }
      if (k >= n) return null;
      const ch = text[k];
      if (ch === '>') { k++; break; }
      if (ch === '/') {
        if (k + 1 >= n || text[k + 1] !== '>') return null;
        k += 2;
        const html = text.slice(i, k);
        return { html: DISALLOWED.has(name) ? escText(html) : html, end: k };
      }
      if (ws === 0) return null;
      // attribute name
      const aStart = k;
      while (k < n && /[A-Za-z0-9_.:-]/.test(text[k])) k++;
      if (k === aStart) return null;
      // optional = value (do not consume trailing ws if there is no '=')
      const saveK = k;
      while (k < n && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
      if (k < n && text[k] === '=') {
        k++;
        while (k < n && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
        if (k >= n) return null;
        const q = text[k];
        if (q === '"' || q === "'") {
          k++;
          while (k < n && text[k] !== q) k++;
          if (k >= n) return null;
          k++;
        } else {
          if (text[k] === '>' || text[k] === '"' || text[k] === "'" || text[k] === '=' || text[k] === '<' || text[k] === '`') return null;
          while (k < n && text[k] !== ' ' && text[k] !== '\t' && text[k] !== '\n' && text[k] !== '>') {
            if (text[k] === '"' || text[k] === "'" || text[k] === '=' || text[k] === '<' || text[k] === '`') return null;
            k++;
          }
        }
      } else {
        k = saveK;
      }
    }
    const html = text.slice(i, k);
    return { html: DISALLOWED.has(name) ? escText(html) : html, end: k };
  }
  function parseLinkDest(text, i) {
    const n = text.length;
    let j = i;
    if (j < n && text[j] === '(') {
      j++;
      while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
      let dest = '';
      if (j < n && text[j] === '<') {
        let e = j + 1, ok = false;
        while (e < n) {
          const cch = text[e];
          if (cch === '\\' && e + 1 < n && isPunctS(text[e + 1])) { e += 2; continue; }
          if (cch === '>') { ok = true; break; }
          if (cch === '\n' || cch === '<') break;
          e++;
        }
        if (!ok) return null;
        const inner = text.slice(j + 1, e);
        if (/[\n<>]/.test(inner)) return null;
        dest = inner;
        j = e + 1;
      } else {
        let depth = 0, k = j;
        while (k < n) {
          const ch = text[k];
          if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') break;
          if (ch === '(') depth++;
          else if (ch === ')') { if (depth === 0) break; depth--; }
          else if (ch === '\\' && k + 1 < n && isPunctS(text[k + 1])) { k += 2; continue; }
          k++;
        }
        dest = text.slice(j, k);
        j = k;
      }
      while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
      let title = '';
      if (j < n && (text[j] === '"' || text[j] === "'" || text[j] === '(')) {
        const q = text[j];
        const close = q === '(' ? ')' : q;
        let k = j + 1, ok = false;
        while (k < n) {
          if (text[k] === '\\' && k + 1 < n && isPunctS(text[k + 1])) { k += 2; continue; }
          if (text[k] === close) { ok = true; break; }
          k++;
        }
        if (!ok) return null;
        title = text.slice(j + 1, k);
        j = k + 1;
        while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
      }
      if (j >= n || text[j] !== ')') return null;
      return { href: dest, title, end: j + 1 };
    }
    if (j < n && text[j] === '[') {
      const e = text.indexOf(']', j + 1);
      if (e < 0) return null;
      return { refLabel: text.slice(j + 1, e), end: e + 1 };
    }
    return null;
  }
  function bracketCanLink(text, from, refs) {
    const n = text.length;
    let depth = 0, j = from;
    while (j < n) {
      const ch = text[j];
      if (ch === '`') {
        let k = j;
        while (k < n && text[k] === '`') k++;
        const end = findCodeEnd(text, k, k - j);
        if (end >= 0) { j = end + (k - j); continue; }
        j = k; continue;
      }
      if (ch === '\\' && j + 1 < n) { j += 2; continue; }
      if (ch === '[') depth++;
      else if (ch === ']') {
        if (depth === 0) break;
        depth--;
      }
      j++;
    }
    if (j >= n) return false;
    const after = j + 1;
    if (after < n && text[after] === '(') return true;
    if (after < n && text[after] === '[') {
      const e = text.indexOf(']', after + 1);
      if (e < 0) return false;
      const label = text.slice(after + 1, e);
      if (label === '') return true;
      return refs.has(normLabel(label));
    }
    return false;
  }

  function trimAutolinkTrail(s) {
    let end = s.length;
    while (end > 0) {
      const ch = s[end - 1];
      if (ch === '.' || ch === ',' || ch === ':' || ch === '!' || ch === '?') { end--; continue; }
      if (ch === ';') {
        let k = end - 2;
        while (k >= 0 && /[A-Za-z0-9#]/.test(s[k])) k--;
        if (k >= 0 && s[k] === '&' && end - 1 - k <= 12) { end = k; continue; }
        end--; continue;
      }
      if (ch === ')') {
        let depth = 0;
        for (let k = 0; k < end; k++) { if (s[k] === '(') depth++; else if (s[k] === ')') depth--; }
        if (depth < 0) { end--; continue; }
        break;
      }
      break;
    }
    return s.slice(0, end);
  }
  function tryExtAutolink(text, i) {
    const n = text.length;
    if (i > 0) {
      const prev = text[i - 1];
      if (!(isWsCh(prev) || prev === '*' || prev === '_' || prev === '~' || prev === '(' || prev === '<')) return null;
    }
    if (inLink) return null;
    if (text.startsWith('www.', i)) {
      let k = i + 4;
      while (k < n && /[A-Za-z0-9.\-_]/.test(text[k])) k++;
      let domain = text.slice(i + 4, k);
      while (domain.length && (domain[domain.length - 1] === '.' || domain[domain.length - 1] === '-')) domain = domain.slice(0, -1);
      if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(domain)) return null;
      let end = i + 4 + domain.length;
      while (end < n && !isWsCh(text[end]) && text[end] !== '<') end++;
      let disp = trimAutolinkTrail(text.slice(i, end));
      if (!disp || disp.length <= 4) return null;
      return { href: 'http://' + disp, disp, end: i + disp.length };
    }
    let j = i;
    while (j < n && !isWsCh(text[j]) && text[j] !== '<' && text[j] !== '`' && text[j] !== '[' && text[j] !== ']') j++;
    const word = text.slice(i, j);
    const atIdx = word.indexOf('@');
    if (atIdx > 0) {
      const local = word.slice(0, atIdx);
      const rest = word.slice(atIdx + 1);
      if (/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+$/.test(local) && !local.includes(':')) {
        let k = 0;
        while (k < rest.length && /[A-Za-z0-9.\-]/.test(rest[k])) k++;
        let domain = rest.slice(0, k);
        while (domain.length && (domain[domain.length - 1] === '.' || domain[domain.length - 1] === '-')) domain = domain.slice(0, -1);
        if (domain.length && rest.length > domain.length && (rest[domain.length] === '-' || rest[domain.length] === '_')) domain = '';
        if (domain.length && /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{1,}$/.test(domain)) {
          const disp = trimAutolinkTrail(local + '@' + domain);
          if (disp.includes('@')) return { href: 'mailto:' + disp, disp, end: i + disp.length };
        }
      }
      // fall through to the scheme check (mailto:/xmpp: addresses reach here)
    }
    const sm = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.exec(word);
    if (sm && sm[0].length >= 3) {
      const scheme = sm[0].slice(0, -1).toLowerCase();
      if (scheme === 'mailto' || scheme === 'xmpp') {
        const after = word.slice(sm[0].length);
        const at = after.indexOf('@');
        if (at > 0) {
          const local = after.slice(0, at);
          let rest = after.slice(at + 1);
          if (/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+$/.test(local)) {
            let k = 0;
            while (k < rest.length && /[A-Za-z0-9.\-]/.test(rest[k])) k++;
            let domain = rest.slice(0, k);
            while (domain.length && (domain[domain.length - 1] === '.' || domain[domain.length - 1] === '-')) domain = domain.slice(0, -1);
            if (domain.length && !(rest.length > domain.length && (rest[domain.length] === '-' || rest[domain.length] === '_'))) {
              if (/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{1,}$/.test(domain)) {
                let disp = sm[0] + local + '@' + domain;
                let tail = rest.slice(domain.length);
                if (tail.startsWith('/')) {
                  let q = 1;
                  while (q < tail.length && !isWsCh(tail[q]) && tail[q] !== '<' && tail[q] !== '/' && tail[q] !== '?' && tail[q] !== '#' && tail[q] !== '[' && tail[q] !== ']') q++;
                  if (q > 1) disp += tail.slice(0, q);
                }
                disp = trimAutolinkTrail(disp);
                return { href: disp, disp, end: i + disp.length };
              }
            }
          }
        }
        return null;
      }
      const after = word.slice(sm[0].length);
      if (after.length && !/^[.,;:!?]$/.test(after) && /[A-Za-z0-9]/.test(after)) {
        const disp = trimAutolinkTrail(word);
        if (disp.length > sm[0].length) return { href: disp, disp, end: i + disp.length };
      }
    }
    return null;
  }
  function plainText(tokens) {
    let s = '';
    for (const tok of tokens) {
      if (tok.t === 0) s += tok.s;
      else if (tok.t === 1) s += tok.ch.repeat(Math.max(0, tok.len - tok.usedOpen - tok.usedClose));
      else if (tok.t === 2) s += tok.s;
      else if (tok.t === 5) s += plainText(tok.children);
      else if (tok.t === 6) s += tok.alt;
      else if (tok.t === 7) s += tok.disp;
      else if (tok.t === 8) s += tok.s;
      else if (tok.t === 9) s += tok.s;
      else if (tok.t === 4) s += ' ';
    }
    return s;
  }
  function inlineParse(text) {
    const tokens = [];
    const brackets = [];
    const n = text.length;
    let i = 0;
    let afterBrk = false;
    function pushText(s) {
      if (!s) return;
      if (afterBrk) {
        let k = 0;
        while (k < s.length && (s.charCodeAt(k) === SP || s.charCodeAt(k) === TAB)) k++;
        s = s.slice(k);
        if (!s) return; // keep afterBrk: still stripping leading ws
        afterBrk = false;
      }
      const last = tokens[tokens.length - 1];
      if (last && last.t === 0) last.s += s;
      else tokens.push({ t: 0, s });
    }
    function pushDelim(ch, len, canOpen, canClose) {
      tokens.push({ t: 1, ch, len, canOpen, canClose, active: true, openTags: [], closeTags: [], usedOpen: 0, usedClose: 0 });
    }
    while (i < n) {
      const ch = text.charCodeAt(i);
      if (ch === 92) {
        if (i + 1 < n) {
          const nx = text[i + 1];
          if (nx === '\n') { tokens.push({ t: 4 }); afterBrk = true; i += 2; continue; }
          if (isPunct(nx.charCodeAt(0))) { pushText(nx); i += 2; continue; }
        }
        pushText('\\'); i++; continue;
      }
      if (ch === 96) {
        let j = i;
        while (j < n && text.charCodeAt(j) === 96) j++;
        const tickLen = j - i;
        const end = findCodeEnd(text, j, tickLen);
        if (end >= 0) {
          let content = text.slice(j, end).replace(/\n/g, ' ');
          if (content.length >= 2 && content.charCodeAt(0) === SP && content.charCodeAt(content.length - 1) === SP && content.trim() !== '') content = content.slice(1, -1);
          tokens.push({ t: 2, s: content });
          i = end + tickLen;
          continue;
        }
        pushText(text.slice(i, j)); i = j; continue;
      }
      if (ch === 42 || ch === 95 || ch === 126) {
        let j = i;
        while (j < n && text.charCodeAt(j) === ch) j++;
        const len = j - i;
        const { leftF, rightF } = flanking(text, i, j);
        let canOpen, canClose;
        if (ch === 95) {
          const prevP = i > 0 && isPunctS(text[i - 1]);
          const nextP = j < n && isPunctS(text[j]);
          canOpen = leftF && (!rightF || prevP);
          canClose = rightF && (!leftF || nextP);
        } else if (ch === 126 && len >= 3) {
          canOpen = false; canClose = false;
        } else { canOpen = leftF; canClose = rightF; }
        pushDelim(String.fromCharCode(ch), len, canOpen, canClose);
        i = j; continue;
      }
      if (ch === 91) {
        tokens.push({ t: 8, s: '[' });
        brackets.push({ tokIdx: tokens.length - 1, startIdx: i + 1, image: false, active: true });
        i++; continue;
      }
      if (ch === 33 && i + 1 < n && text.charCodeAt(i + 1) === 91) {
        tokens.push({ t: 8, s: '![' });
        brackets.push({ tokIdx: tokens.length - 1, startIdx: i + 2, image: true, active: true });
        i += 2; continue;
      }
      if (ch === 93) {
        let resolved = false;
        let b = brackets.length - 1;
        while (b >= 0 && !brackets[b].active) b--;
        if (b >= 0) {
          const br = brackets[b];
          const dest = parseLinkDest(text, i + 1);
          let href = null, title = '', destEnd = i + 1;
          if (dest) {
            destEnd = dest.end;
            if (dest.href !== undefined) { href = dest.href; title = dest.title; }
            else if (dest.refLabel !== undefined) {
              const label = dest.refLabel === '' ? text.slice(br.startIdx, i) : dest.refLabel;
              const ref = refs.get(normLabel(label));
              if (ref) { href = ref.dest; title = ref.title; }
            }
          } else {
            const label = text.slice(br.startIdx, i);
            const ref = refs.get(normLabel(label));
            if (ref) { href = ref.dest; title = ref.title; }
          }
          if (href !== null && href !== undefined) {
            const children = tokens.splice(br.tokIdx + 1);
            tokens.splice(br.tokIdx, 1);
            if (br.image) { for (let k = 0; k < brackets.length; k++) if (brackets[k].tokIdx > br.tokIdx) brackets[k].active = false; }
            else { for (let k = 0; k < brackets.length; k++) if (!brackets[k].image) brackets[k].active = false; }
            br.active = false;
            resolveEmphasis(children);
            if (br.image) tokens.push({ t: 6, src: href, title, alt: plainText(children) });
            else tokens.push({ t: 5, href, title, children });
            i = destEnd;
            resolved = true;
          } else {
            br.active = false;
          }
        }
        if (!resolved) { pushText(']'); i++; }
        continue;
      }
      if (ch === 60) {
        const m = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/.exec(text.slice(i));
        if (m) { tokens.push({ t: 7, href: m[1], disp: m[1] }); i += m[0].length; continue; }
        const em = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/.exec(text.slice(i));
        if (em) { tokens.push({ t: 7, href: 'mailto:' + em[1], disp: em[1] }); i += em[0].length; continue; }
        const tag = parseHtmlTag(text, i);
        if (tag) { tokens.push({ t: 3, s: tag.html }); i = tag.end; continue; }
        pushText('<'); i++; continue;
      }
      if (ch === 38) {
        const em = /^&(#\d{1,7}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]*);/.exec(text.slice(i));
        if (em) {
          const body = em[1];
          if (body.charCodeAt(0) === 35) {
            let cp;
            if (body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88) cp = parseInt(body.slice(2), 16);
            else cp = parseInt(body.slice(1), 10);
            if (!cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) pushText('\uFFFD');
            else pushText(String.fromCodePoint(cp));
          } else tokens.push({ t: 9, s: em[0] });
          i += em[0].length; continue;
        }
        pushText('&'); i++; continue;
      }
      if (ch === 10) {
        const last = tokens[tokens.length - 1];
        if (last && last.t === 0) {
          let k = last.s.length;
          while (k > 0 && last.s.charCodeAt(k - 1) === SP) k--;
          if (last.s.length - k >= 2) { last.s = last.s.slice(0, k); tokens.push({ t: 4 }); afterBrk = true; }
          else pushText('\n');
        } else pushText('\n');
        i++; continue;
      }
      if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122)) {
        const at = tryExtAutolink(text, i);
        if (at) {
          if (brackets.length) {
            const br = brackets[brackets.length - 1];
            if (br.active && bracketCanLink(text, br.startIdx, refs)) { pushText(text[i]); i++; continue; }
          }
          tokens.push({ t: 7, href: at.href, disp: at.disp });
          i = at.end; continue;
        }
        pushText(text[i]); i++; continue;
      }
      pushText(text[i]); i++;
    }
    resolveEmphasis(tokens);
    return renderInline(tokens);
  }

  // ---------- emphasis resolution (with forward-scan fix) ----------
  function delimRemaining(d) { return d.len - d.usedOpen - d.usedClose; }
  function resolveEmphasis(tokens) {
    const stack = [];
    for (let idx = 0; idx < tokens.length; idx++) {
      const tok = tokens[idx];
      if (tok.t !== 1 || !tok.active) continue;
      if (tok.canClose) {
        let j = stack.length - 1;
        while (j >= 0 && tok.active && delimRemaining(tok) > 0) {
          const open = stack[j].tok;
          if (!open.active || open.ch !== tok.ch || !open.canOpen) { j--; continue; }
          const oRem = delimRemaining(open);
          const cRem = delimRemaining(tok);
          if (oRem <= 0 || cRem <= 0) { j--; continue; }
          // odd-match rule (CommonMark 9): if either delimiter can both open
          // and close, and the sum of the full run lengths is a multiple of 3
          // while not both lengths are multiples of 3, they cannot match.
          if (((open.canOpen && open.canClose) || (tok.canOpen && tok.canClose)) && (open.len + tok.len) % 3 === 0 && !(open.len % 3 === 0 && tok.len % 3 === 0)) { j--; continue; }
          let openOnly = 0, closeOnly = 0, oddAccum = 0;
          for (let k = stack[j].idx + 1; k < idx; k++) {
            const d = tokens[k];
            if (d.t !== 1 || d.ch !== tok.ch || d.trapped) continue;
            if (d.matchedBy && d.matchedBy.has(tok)) continue;
            const contrib = d.active ? delimRemaining(d) : d.len;
            if (contrib <= 0) continue;
            if (d.canOpen && !d.canClose) openOnly += contrib;
            else if (d.canClose && !d.canOpen) closeOnly += contrib;
            else if (d.canOpen && d.canClose && d.active && (contrib + oRem + cRem) % 3 === 0) oddAccum += contrib;
          }
          let use = 1;
          if (tok.ch === '~') {
            if (oRem < 1 || cRem < 1) { j--; continue; }
            use = (oRem >= 2 && cRem >= 2) ? 2 : 1;
          } else if (oRem >= 2 && cRem >= 2) {
            use = 2;
            if (open.canOpen && open.canClose && tok.canOpen && tok.canClose && (oRem + cRem + oddAccum) % 3 === 0 && !(oRem % 3 === 0 && cRem % 3 === 0)) use = 1;
          }
          const need = use + openOnly - closeOnly;
          if (cRem < need) { j--; continue; }
          const tag = tok.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
          open.openTags.push({ tag, cIdx: idx });
          open.usedOpen += use;
          tok.closeTags.push({ tag, oIdx: stack[j].idx });
          tok.usedClose += use;
          if (!open.matchedBy) open.matchedBy = new Set();
          open.matchedBy.add(tok);
          // openers above the matched one are trapped inside the emphasis
          // just formed and cannot match a closer outside it
          const removed = stack.splice(j + 1);
          for (const r of removed) r.tok.trapped = true;
          if (delimRemaining(open) <= 0) { open.active = false; j--; }
          if (delimRemaining(tok) <= 0) { tok.active = false; break; }
        }
      }
      if (tok.canOpen && tok.active && delimRemaining(tok) > 0) stack.push({ tok, idx });
    }
  }
  function normalizeUri(uri) {
    let out = '', k = 0;
    while (k < uri.length) {
      if (uri[k] === '\\' && k + 1 < uri.length && isPunctS(uri[k + 1])) { out += uri[k + 1]; k += 2; continue; }
      if (uri[k] === '\\') { out += '%5C'; k++; continue; }
      const code = uri.charCodeAt(k);
      if (code < 32 || code === 127) out += '%' + code.toString(16).toUpperCase().padStart(2, '0');
      else if (uri[k] === ' ') out += '%20';
      else if (uri[k] === '"' || uri[k] === '<' || uri[k] === '>' || uri[k] === '`') out += '%' + code.toString(16).toUpperCase().padStart(2, '0');
      else if (code >= 128) out += encodeURIComponent(uri[k]);
      else out += uri[k];
      k++;
    }
    return out;
  }
  function normalizeAutolinkUri(uri) {
    let out = '', k = 0;
    while (k < uri.length) {
      const code = uri.charCodeAt(k);
      if (code < 32 || code === 127) out += '%' + code.toString(16).toUpperCase().padStart(2, '0');
      else if (uri[k] === ' ') out += '%20';
      else if (uri[k] === '\\') out += '%5C';
      else if (uri[k] === '"' || uri[k] === ']' || uri[k] === '[' || uri[k] === '`') out += '%' + code.toString(16).toUpperCase().padStart(2, '0');
      else if (code >= 128) out += encodeURIComponent(uri[k]);
      else out += uri[k];
      k++;
    }
    return out;
  }
  function unescTitle(s) { return s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1'); }
  function renderInline(tokens) {
    let out = '';
    for (const tok of tokens) {
      if (tok.t === 0) out += escText(tok.s);
      else if (tok.t === 1) {
        const lit = tok.len - tok.usedOpen - tok.usedClose;
        const closeSorted = tok.closeTags.map((t, i) => ({ tag: t.tag, oIdx: t.oIdx, i })).sort((a, b) => (b.oIdx - a.oIdx) || ((a.tag === 'strong' ? 0 : 1) - (b.tag === 'strong' ? 0 : 1)) || (a.i - b.i));
        const openSorted = tok.openTags.map((t, i) => ({ tag: t.tag, cIdx: t.cIdx, i })).sort((a, b) => (b.cIdx - a.cIdx) || ((a.tag === 'em' ? 0 : 1) - (b.tag === 'em' ? 0 : 1)) || (a.i - b.i));
        for (const t of closeSorted) out += '</' + t.tag + '>';
        if (lit > 0) out += escText(tok.ch.repeat(lit));
        for (const t of openSorted) out += '<' + t.tag + '>';
      }
      else if (tok.t === 2) out += '<code>' + escText(tok.s) + '</code>';
      else if (tok.t === 3) out += tok.s;
      else if (tok.t === 4) out += '<br>';
      else if (tok.t === 5) {
        inLink = true;
        const inner = renderInline(tok.children);
        inLink = false;
        out += '<a href="' + escAttr(normalizeUri(tok.href)) + '"' + (tok.title ? ' title="' + escAttr(unescTitle(tok.title)) + '"' : '') + '>' + inner + '</a>';
      }
      else if (tok.t === 6) {
        out += '<img src="' + escAttr(normalizeUri(tok.src)) + '" alt="' + escAttr(tok.alt) + '"' + (tok.title ? ' title="' + escAttr(unescTitle(tok.title)) + '"' : '') + '>';
      }
      else if (tok.t === 7) {
        out += '<a href="' + escAttr(normalizeAutolinkUri(tok.href)) + '">' + escText(tok.disp) + '</a>';
      }
      else if (tok.t === 8) out += escText(tok.s);
      else if (tok.t === 9) out += tok.s;
    }
    return out;
  }
  function renderListItem(blocks, loose) {
    let checkHtml = '';
    if (blocks.length && blocks[0].t === 'para') {
      const t = blocks[0].text;
      const m = /^\[( |x|X)\](?:[ \t]+|$)/.exec(t);
      if (m) {
        const checked = m[1] !== ' ';
        checkHtml = checked ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ';
        const stripped = t.slice(m[0].length);
        blocks = [{ t: 'para', lines: blocks[0].lines, list: blocks[0].list, text: stripped }].concat(blocks.slice(1));
      }
    }
    if (loose) {
      let out = renderBlocks(blocks);
      if (checkHtml) out = out.replace(/^<p>/, '<p>' + checkHtml);
      return out;
    }
    let out = '';
    for (const b of blocks) {
      if (b.t === 'para') out += inlineParse(b.text);
      else out += renderBlocks([b]);
    }
    return checkHtml + out;
  }
  function renderBlocks(blocks) {
    let out = '';
    for (const b of blocks) {
      if (b.t === 'para') out += '<p>' + inlineParse(b.text) + '</p>\n';
      else if (b.t === 'head') out += '<h' + b.level + '>' + inlineParse(b.text) + '</h' + b.level + '>\n';
      else if (b.t === 'code') {
        const info = b.info ? ' class="language-' + escAttr(b.info.split(/\s+/)[0]) + '"' : '';
        out += '<pre><code' + info + '>' + escText(b.text) + '</code></pre>\n';
      }
      else if (b.t === 'html') out += b.text + (b.type <= 5 && !b.blankAfter ? '\n' : '');
      else if (b.t === 'hr') out += '<hr>\n';
      else if (b.t === 'quote') out += '<blockquote>\n' + renderBlocks(b.blocks) + '</blockquote>\n';
      else if (b.t === 'list') {
        const tag = b.ordered ? 'ol' : 'ul';
        const start = b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '';
        out += '<' + tag + start + '>\n';
        for (const it of b.items) out += '<li>' + renderListItem(it.blocks, b.loose) + '</li>\n';
        out += '</' + tag + '>\n';
      }
      else if (b.t === 'table') {
        out += '<table>\n<thead>\n<tr>\n';
        for (let k = 0; k < b.head.length; k++) {
          const al = b.aligns[k];
          out += '<th' + (al ? ' align="' + al + '"' : '') + '>' + inlineParse(b.head[k]) + '</th>\n';
        }
        out += '</tr>\n</thead>\n';
        if (b.rows.length) {
          out += '<tbody>';
          for (const row of b.rows) {
            out += '<tr>\n';
            for (let k = 0; k < b.head.length; k++) {
              const cell = k < row.length ? row[k] : '';
              const al = b.aligns[k];
              out += '<td' + (al ? ' align="' + al + '"' : '') + '>' + inlineParse(cell) + '</td>\n';
            }
            out += '</tr>\n';
          }
          out += '</tbody>';
        }
        out += '</table>\n';
      }
    }
    return out;
  }
  export function parse(markdown) {
    root = []; stack = []; para = null; fence = null; indCode = null; htmlBlock = null; lastHtmlNode = null; table = null;
    refs = new Map();
    inLink = false;
    const lines = markdown.split('\n');
    if (lines.length && lines[lines.length - 1] === '' && markdown.endsWith('\n')) lines.pop();
    for (let li = 0; li < lines.length; li++) processLine(lines[li]);
    closePara(); closeCode(); closeFence(); closeHtml(); closeTable();
    let out = renderBlocks(root);
    if (out.length && !out.endsWith('\n')) out += '\n';
    return out;
  }
  export default parse;
