/* Guard for CHANGELOG-inclusive-coordinator-wording.md — coordinators include
 * men, so no user-facing string may call them by the feminine-only «רכזת» /
 * «רכזות». Use «רכז/ת» in the singular and «רכזים» in the plural
 * (EZONE-ECOSYSTEM-STATUS.md, "Gendered roles").
 *
 * Scope:
 *   - public/**: every text file, whole content (markup, scripts, styles,
 *     manifest), so nothing that can reach a screen slips through;
 *   - apps-script/Code.gs: every string literal ('…', "…", `…`). Comments are
 *     not user-facing and are skipped.
 *
 * No exceptions: since CHANGELOG-inclusive-role-wording.md the coordinators
 * feed stamps updatedBy with 'רכזים · ' (older sheet rows keep their old stamp;
 * nothing rewrites them). */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/* «רכזת» / «רכזות» as a standalone word, with the usual one- or two-letter
 * Hebrew prefixes (ה, ו, ל, ב, ש, כ, מה …). Not inside a longer word, so
 * «מרכזות» / «מרכזת» (centralizes) never match. */
const FEMININE_COORDINATOR = /(?<![א-ת])(?:[והלבשכ]{1,2}|מה)?רכז(?:ת|ות)(?![א-ת])/u;

const TEXT_EXT = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg', '.txt', '.md']);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return TEXT_EXT.has(path.extname(e.name).toLowerCase()) ? [p] : [];
  });
}

/* String literals of a JS source, comments skipped. A small scanner: enough
 * for Code.gs (no regex literals contain quotes that would confuse it — the
 * self-test below pins the behaviour). */
function stringLiterals(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') { s += src[j + 1] || ''; j += 2; continue; }
        if (c !== '`' && src[j] === '\n') break;   // unterminated: not a literal
        s += src[j];
        j++;
      }
      out.push({ text: s, line: src.slice(0, i).split('\n').length });
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

test('the matcher: feminine-only coordinator words match; inclusive and unrelated words do not', () => {
  ['רכזת', 'רכזות', 'הרכזות', 'לרכזת', 'והרכזות', 'מהרכזות', 'שהרכזת', '(רכזת)', 'ע״י הרכזות ב־30']
    .forEach(s => assert.ok(FEMININE_COORDINATOR.test(s), s));
  ['רכז', 'רכז/ת', 'רכזים', 'הרכזים', 'מרכזות', 'מרכזת', 'רכזתי', 'coordinator']
    .forEach(s => assert.ok(!FEMININE_COORDINATOR.test(s), s));
});

test('the literal scanner skips comments and finds every quote style', () => {
  const lits = stringLiterals("// 'רכזות' in a comment\n/* \"רכזת\" */ const a = 'x'; const b = \"y\"; const c = `z ${1}`;");
  assert.deepStrictEqual(lits.map(l => l.text), ['x', 'y', 'z ${1}']);
});

test('public/**: no feminine-only coordinator wording («רכזת» / «רכזות»)', () => {
  const hits = [];
  walk(path.join(ROOT, 'public')).forEach(file => {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (FEMININE_COORDINATOR.test(line)) hits.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
    });
  });
  assert.deepStrictEqual(hits, [], 'use «רכז/ת» (singular) / «רכזים» (plural):\n' + hits.join('\n'));
});

test('apps-script/Code.gs string literals: no feminine-only coordinator wording', () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
  const hits = stringLiterals(src)
    .filter(l => FEMININE_COORDINATOR.test(l.text))
    .map(l => `Code.gs:${l.line}: ${JSON.stringify(l.text)}`);
  assert.deepStrictEqual(hits, [], 'use «רכז/ת» (singular) / «רכזים» (plural):\n' + hits.join('\n'));
});

test('the coordinators-feed updatedBy stamp uses the inclusive plural', () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
  assert.strictEqual(stringLiterals(src).filter(l => l.text === 'רכזים · ').length, 1);
});
