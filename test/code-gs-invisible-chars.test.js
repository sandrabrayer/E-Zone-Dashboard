/* Guard: no RAW invisible or control character in apps-script/*.gs outside a
 * string literal.
 *
 * Why: the Apps Script backend is one flat V8 script that runs on EVERY
 * request. A raw character nobody can see — a right-to-left mark pasted with
 * Hebrew text, a zero-width space, an NBSP, a BOM, a bidi override — is:
 *   - a SyntaxError between tokens (U+200B / U+200E / U+200F …): the whole
 *     script fails to load and every action, getData included, fails with it;
 *   - a DIFFERENT identifier inside a name (U+200C / U+200D are legal
 *     identifier parts): `getData` + U+200D + `_` is not `getData_`;
 *   - a Trojan-Source hazard in a comment or a regex (CVE-2021-42574): what a
 *     reviewer reads is not what runs.
 * Inside a string literal ('…', "…", or template text) a raw character is DATA
 * — Hebrew UI text may legitimately carry one (the warning-sign subject line does:
 * U+FE0F) — so string literals are exempt. Everything else is scanned: code,
 * comments, regex literals and ${…} template expressions. Write such a
 * character as an escape instead ('\u200f', /[\u200b-\u200f]/).
 *
 * "Invisible or control" = every character in Unicode categories Cc (controls,
 * except TAB / LF / CR), Cf (format: bidi marks and overrides, zero-width
 * characters, BOM, soft hyphen, tags …), Co (private use), Cs (surrogates),
 * Cn (unassigned), Zl / Zp (line / paragraph separators), every Zs space
 * separator except the plain space (NBSP, thin / hair / ideographic spaces …),
 * plus the default-ignorable characters that are letters or marks by category
 * but render as nothing (Hangul fillers, Khmer inherent vowels, Mongolian
 * variation selectors, combining grapheme joiner, variation selectors).
 *
 * The scanner is a small JavaScript tokenizer (comments, the three string
 * forms, nested template expressions, regex-vs-division). It is proven here
 * on synthetic sources, and on the real file it must end cleanly — no
 * unterminated string, comment, regex or template — so a tokenizer slip
 * cannot quietly exempt code by mistaking it for a string. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const GS_DIR = path.join(ROOT, 'apps-script');
const GS_FILES = fs.readdirSync(GS_DIR).filter((f) => f.endsWith('.gs')).sort();

const INVISIBLE = new RegExp(
  '(?![\\t\\n\\r])[\\p{Cc}\\p{Cf}\\p{Co}\\p{Cs}\\p{Cn}\\p{Zl}\\p{Zp}]' +
  '|(?! )\\p{Zs}' +
  '|[\\u034f\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u3164\\uffa0\\ufe00-\\ufe0f\\u{e0100}-\\u{e01ef}]',
  'gu');

const NAMES = {
  0x00a0: 'NO-BREAK SPACE', 0x00ad: 'SOFT HYPHEN', 0x061c: 'ARABIC LETTER MARK',
  0x200b: 'ZERO WIDTH SPACE', 0x200c: 'ZERO WIDTH NON-JOINER', 0x200d: 'ZERO WIDTH JOINER',
  0x200e: 'LEFT-TO-RIGHT MARK', 0x200f: 'RIGHT-TO-LEFT MARK', 0x2028: 'LINE SEPARATOR',
  0x2029: 'PARAGRAPH SEPARATOR', 0x202a: 'LEFT-TO-RIGHT EMBEDDING', 0x202b: 'RIGHT-TO-LEFT EMBEDDING',
  0x202c: 'POP DIRECTIONAL FORMATTING', 0x202d: 'LEFT-TO-RIGHT OVERRIDE', 0x202e: 'RIGHT-TO-LEFT OVERRIDE',
  0x2060: 'WORD JOINER', 0x2066: 'LEFT-TO-RIGHT ISOLATE', 0x2067: 'RIGHT-TO-LEFT ISOLATE',
  0x2068: 'FIRST STRONG ISOLATE', 0x2069: 'POP DIRECTIONAL ISOLATE', 0xfe0f: 'VARIATION SELECTOR-16',
  0xfeff: 'ZERO WIDTH NO-BREAK SPACE (BOM)',
};

const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await']);
const isLineTerm = (c) => c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029';
const isWordChar = (c) => /[A-Za-z0-9_$]/.test(c);

/* Split `src` into contiguous regions {kind, start, end}, kind one of
 * 'code' | 'comment' | 'string' | 'template' | 'regex'. `errors` lists every
 * construct the source left unterminated (a clean file has none). */
function scanRegions(src) {
  const regions = [];
  const errors = [];
  const n = src.length;
  const emit = (kind, s, e) => { if (e > s) regions.push({ kind, start: s, end: e }); };
  const frames = [{ type: 'code', depth: 0, inTemplate: false }];
  let i = 0;
  let codeStart = 0;
  let last = { kind: 'start', word: '' }; // last significant code token
  const regexAllowed = () => {
    if (last.kind === 'start' || last.kind === 'punct') return true;
    if (last.kind === 'word') return REGEX_AFTER_WORD.has(last.word);
    return false; // ')' ']' '}' a literal, or '++' / '--'
  };
  while (i < n) {
    const top = frames[frames.length - 1];
    if (top.type === 'template') {
      const s = i;
      while (i < n && src[i] !== '`' && !(src[i] === '$' && src[i + 1] === '{')) i += src[i] === '\\' ? 2 : 1;
      emit('template', s, Math.min(i, n));
      if (i >= n) { errors.push({ kind: 'template', at: s }); break; }
      if (src[i] === '`') {
        i++;
        frames.pop();
        last = { kind: 'literal' };
      } else {
        i += 2;
        frames.push({ type: 'code', depth: 0, inTemplate: true });
        last = { kind: 'punct' };
      }
      codeStart = i;
      continue;
    }
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && (d === '/' || d === '*')) {
      emit('code', codeStart, i);
      const s = i;
      if (d === '/') {
        i += 2;
        while (i < n && !isLineTerm(src[i])) i++;
      } else {
        const e = src.indexOf('*/', i + 2);
        if (e < 0) { errors.push({ kind: 'comment', at: s }); i = n; } else i = e + 2;
      }
      emit('comment', s, i);
      codeStart = i;
      continue;
    }
    if (c === '\'' || c === '"') {
      emit('code', codeStart, i);
      const s = i;
      let j = i + 1;
      while (j < n && src[j] !== c && !isLineTerm(src[j])) j += src[j] === '\\' ? 2 : 1;
      if (j >= n || src[j] !== c) errors.push({ kind: 'string', at: s });
      i = Math.min(j + 1, n);
      emit('string', s, i);
      last = { kind: 'literal' };
      codeStart = i;
      continue;
    }
    if (c === '`') {
      emit('code', codeStart, i);
      i++;
      frames.push({ type: 'template' });
      continue;
    }
    if (c === '/' && regexAllowed()) {
      emit('code', codeStart, i);
      const s = i;
      let j = i + 1;
      let inClass = false;
      while (j < n && !isLineTerm(src[j])) {
        const r = src[j];
        if (r === '\\') { j += 2; continue; }
        if (inClass) { if (r === ']') inClass = false; } else if (r === '[') inClass = true; else if (r === '/') break;
        j++;
      }
      if (j >= n || src[j] !== '/') errors.push({ kind: 'regex', at: s });
      j++;
      while (j < n && /[A-Za-z]/.test(src[j])) j++;
      i = Math.min(j, n);
      emit('regex', s, i);
      last = { kind: 'literal' };
      codeStart = i;
      continue;
    }
    if (c === '}' && top.inTemplate && top.depth === 0) {
      emit('code', codeStart, i);
      i++;
      frames.pop();
      codeStart = i;
      continue;
    }
    if (c === '{') top.depth++;
    if (c === '}') top.depth--;
    if (isWordChar(c)) {
      let j = i;
      while (j < n && isWordChar(src[j])) j++;
      last = { kind: 'word', word: src.slice(i, j) };
      i = j;
      continue;
    }
    if (!/\s/.test(c)) {
      if ((c === '+' || c === '-') && d === c) { last = { kind: 'literal' }; i += 2; continue; }
      last = (c === ')' || c === ']' || c === '}') ? { kind: 'close' } : { kind: 'punct' };
    }
    i++;
  }
  emit('code', codeStart, Math.min(i, n));
  // An unclosed template TEXT was reported where the scan stopped; an unclosed
  // ${…} expression (the scan ran off the end inside code) is reported here.
  if (frames.length !== 1 && frames[frames.length - 1].type !== 'template') {
    errors.push({ kind: 'template-expression', at: n });
  }
  return { regions, errors };
}

/* Raw invisible / control characters outside string literals, with 1-based
 * line:column and the region they sit in. */
function findInvisibles(src) {
  const { regions, errors } = scanRegions(src);
  const lineStarts = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === '\n') lineStarts.push(k + 1);
  const where = (idx) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, column: idx - lineStarts[lo] + 1 };
  };
  const hits = [];
  regions.forEach((r) => {
    if (r.kind === 'string' || r.kind === 'template') return;
    const part = src.slice(r.start, r.end);
    for (const m of part.matchAll(INVISIBLE)) {
      const cp = m[0].codePointAt(0);
      const hex = 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
      hits.push(Object.assign({ kind: r.kind, cp, label: hex + (NAMES[cp] ? ' ' + NAMES[cp] : '') }, where(r.start + m.index)));
    }
  });
  return { hits, errors, regions };
}

const RLM = String.fromCharCode(0x200f);
const ZWJ = String.fromCharCode(0x200d);
const NBSP = String.fromCharCode(0xa0);
const BOM = String.fromCharCode(0xfeff);
const VS16 = String.fromCharCode(0xfe0f);
const kinds = (src) => findInvisibles(src).hits.map((h) => h.kind);

/* ===== the scanner, proven on synthetic sources ===== */

test('scanner: flags a raw invisible character in code, in an identifier, in both comment forms and in a regex literal', () => {
  assert.deepStrictEqual(kinds('const a = 1;' + RLM + '\nconst b = 2;'), ['code'], 'between tokens');
  assert.deepStrictEqual(kinds('function getData' + ZWJ + '_() {}'), ['code'], 'inside an identifier (a legal, different name)');
  assert.deepStrictEqual(kinds('// note ' + RLM + '\nx();'), ['comment']);
  assert.deepStrictEqual(kinds('/* note ' + RLM + ' */ x();'), ['comment']);
  assert.deepStrictEqual(kinds('const re = /[' + RLM + ']/g;'), ['regex']);
  assert.deepStrictEqual(kinds('if (s.match(/a' + RLM + 'b/)) x();'), ['regex'], 'a regex after "("');
  assert.deepStrictEqual(kinds('const t = `a ${ b' + RLM + ' } c`;'), ['code'], 'a ${} expression inside a template is code');
  assert.deepStrictEqual(kinds('var' + NBSP + 'x = 1;'), ['code'], 'NBSP (legal JS whitespace, still invisible)');
  assert.deepStrictEqual(kinds(BOM + 'var x = 1;'), ['code'], 'a byte-order mark');
  assert.deepStrictEqual(kinds('// ✏' + VS16 + ' edit\n'), ['comment'], 'an emoji variation selector in a comment');
  assert.deepStrictEqual(kinds('x();\u000b'), ['code'], 'a vertical tab');
});

test('scanner: string literals are exempt — single, double, template text — and escapes are not raw characters', () => {
  assert.deepStrictEqual(kinds("const a = '" + RLM + "';"), []);
  assert.deepStrictEqual(kinds('const a = "' + RLM + '";'), []);
  assert.deepStrictEqual(kinds('const a = `' + RLM + ' ${b} ' + VS16 + '`;'), []);
  assert.deepStrictEqual(kinds("const a = '⚠" + VS16 + " subject';"), []);
  assert.deepStrictEqual(kinds("const re = /[\\u200b-\\u200f]/g; const s = '\\u200f';"), [], 'escape sequences are plain ASCII');
  assert.deepStrictEqual(kinds('const a = 1;\t\r\n'), [], 'TAB / CR / LF are ordinary whitespace');
});

test('scanner: quotes and comment markers inside other constructs do not derail it', () => {
  // A quote inside a regex must not open a string (that would exempt the code after it).
  assert.deepStrictEqual(kinds("const re = /['\"`]/g; x();" + RLM), ['code']);
  // '//' inside a string is not a comment; '/' after a value is division.
  assert.deepStrictEqual(kinds("const u = 'http://x' + a / b / c;" + RLM), ['code']);
  assert.deepStrictEqual(kinds('const r = (a) / 2; y();' + RLM), ['code']);
  assert.deepStrictEqual(kinds('i++ / 2;' + RLM), ['code']);
  assert.deepStrictEqual(kinds('return /x/.test(s)' + RLM), ['code'], 'a regex after return');
  // A regex character class may hold a '/' without ending the literal.
  assert.deepStrictEqual(kinds('const re = /[/]' + RLM + '/;'), ['regex']);
  // Nested template expressions with braces.
  assert.deepStrictEqual(kinds('const t = `a ${ {k: `b ${c}`}.k } d`; z();' + RLM), ['code']);
});

test('scanner: unterminated constructs are reported, so a tokenizer slip can never pass silently', () => {
  assert.deepStrictEqual(findInvisibles("const a = 'oops\nx();").errors.map((e) => e.kind), ['string']);
  assert.deepStrictEqual(findInvisibles('/* never closed').errors.map((e) => e.kind), ['comment']);
  assert.deepStrictEqual(findInvisibles('const t = `open').errors.map((e) => e.kind), ['template']);
  assert.deepStrictEqual(findInvisibles('const t = `a ${ b').errors.map((e) => e.kind), ['template-expression']);
  assert.deepStrictEqual(findInvisibles('x = 1; y = (/abc\n);').errors.map((e) => e.kind), ['regex']);
});

test('scanner: reports the exact line, column and code point', () => {
  const [hit] = findInvisibles('a();\nb();\n  c(' + RLM + ');').hits;
  assert.deepStrictEqual({ line: hit.line, column: hit.column, label: hit.label }, { line: 3, column: 5, label: 'U+200F RIGHT-TO-LEFT MARK' });
});

/* ===== the real backend ===== */

test('apps-script/Code.gs is scanned (and every other .gs file in apps-script/)', () => {
  assert.ok(GS_FILES.includes('Code.gs'), 'found: ' + GS_FILES.join(', '));
});

GS_FILES.forEach((file) => {
  const src = fs.readFileSync(path.join(GS_DIR, file), 'utf8');

  test('apps-script/' + file + ': the tokenizer reads it cleanly end to end', () => {
    const { errors, regions } = findInvisibles(src);
    assert.deepStrictEqual(errors, [], 'unterminated constructs mean the scanner misread the file');
    let at = 0;
    regions.forEach((r) => { assert.strictEqual(r.start, at, 'regions are contiguous'); at = r.end; });
    assert.strictEqual(at, src.length, 'regions cover the whole file');
    const count = (k) => regions.filter((r) => r.kind === k).length;
    if (file === 'Code.gs') {
      assert.ok(count('string') > 100 && count('comment') > 100 && count('regex') > 0,
        'Code.gs has many strings and comments and some regex literals — the scanner saw them');
    }
  });

  test('apps-script/' + file + ': NO raw invisible or control character outside a string literal', () => {
    const { hits } = findInvisibles(src);
    const lines = src.split('\n');
    const report = hits.map((h) => 'apps-script/' + file + ':' + h.line + ':' + h.column + '  ' + h.label +
      ' in ' + h.kind + '  →  ' + JSON.stringify(lines[h.line - 1].trim().slice(0, 100)));
    assert.deepStrictEqual(report, [],
      'raw invisible/control characters found — write them as \\uXXXX escapes (or delete them):\n' + report.join('\n'));
  });

  test('apps-script/' + file + ': a raw U+FFFD sits only inside a string or regex literal — never in code or a comment', () => {
    const { regions } = findInvisibles(src);
    const stray = [];
    regions.forEach((r) => {
      if (r.kind === 'string' || r.kind === 'template' || r.kind === 'regex') return;
      const k = src.slice(r.start, r.end).indexOf('\ufffd');
      if (k >= 0) stray.push(r.kind + ' at offset ' + (r.start + k));
    });
    assert.deepStrictEqual(stray, [], 'U+FFFD outside a literal is encoding damage (and a SyntaxError in code)');
  });
});
