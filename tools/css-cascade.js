'use strict';

/* A small, dependency-free CSS cascade resolver — test support, not app code
 * (it lives in tools/ next to gen-icons.js so `node --test` does not treat it
 * as a test file).
 *
 * It exists to answer one question honestly in CI: "given this element's classes
 * and state, what does the REAL stylesheet compute for it and for its ::before?"
 *
 * The loading-spinner bug it was written for (see CHANGELOG-spinner-glyph-fix.md)
 * was invisible to every source-scan test the repo had: the `::before` rule was
 * present, correct and well-formed, and the defect lived entirely in the CASCADE
 * — `.btn:disabled` (two compounds) outranking `.is-busy` (one) and fading the
 * ring until it could not be seen. Grepping selectors can never catch that;
 * resolving them can.
 *
 * Deliberately NOT a CSS engine. It supports exactly the shapes these two
 * stylesheets use for the controls under test:
 *   - selector lists, descendant combinators, and class / type / id /
 *     attribute ([a="b"]) / pseudo-class (:disabled, :hover, …) compounds
 *   - ::before / ::after pseudo-element subjects
 *   - top-level rules plus @media blocks, gated by a caller-supplied predicate
 *   - `var(--x)` lookups against :root, and the `border` shorthand
 * Anything it cannot parse is reported so a test can assert the unsupported set
 * never grows to include something that matters. test/spinner-glyph.test.js is
 * the consumer; test/spinner-glyph-browser.test.js cross-checks the same numbers
 * in real Chromium when a browser is available. */

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/* Split a declaration block into [prop, value] pairs. */
function parseDecls(body) {
  const out = [];
  body.split(';').forEach((chunk) => {
    const i = chunk.indexOf(':');
    if (i === -1) return;
    const prop = chunk.slice(0, i).trim().toLowerCase();
    const value = chunk.slice(i + 1).trim();
    if (prop && value) out.push([prop, value]);
  });
  return out;
}

/* Flatten a stylesheet into an ordered rule list. `mediaAllows(query)` decides
 * whether an @media block's rules are included; at-rules other than @media
 * (e.g. @keyframes) are skipped wholesale and reported. */
function parseSheet(css, mediaAllows = () => false) {
  const src = stripComments(css);
  const rules = [];
  const skipped = [];
  let i = 0;
  let order = 0;

  const endOfBlock = (from) => {
    let depth = 0;
    for (let k = from; k < src.length; k++) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}') { depth--; if (depth === 0) return k; }
    }
    return -1;
  };

  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1) break;
    const prelude = src.slice(i, open).trim();
    const close = endOfBlock(open);
    if (close === -1) break;
    const body = src.slice(open + 1, close);

    if (prelude.startsWith('@')) {
      const at = prelude.slice(1).split(/\s+/)[0].toLowerCase();
      if (at === 'media') {
        const query = prelude.slice('@media'.length).trim();
        if (mediaAllows(query)) {
          parseSheet(body, mediaAllows).rules.forEach((r) => {
            rules.push(Object.assign({}, r, { order: order++, media: query }));
          });
        }
      } else {
        skipped.push(prelude);
      }
    } else {
      prelude.split(',').forEach((sel) => {
        const s = sel.trim();
        if (s) rules.push({ selector: s, decls: parseDecls(body), order: order++ });
      });
    }
    i = close + 1;
  }
  return { rules, skipped };
}

/* ---------- selector matching ---------- */

const COMPOUND =
  /^([a-z][a-z0-9-]*|\*)?((?:[#.][\w-]+|\[[^\]]*\]|::?[\w-]+(?:\([^)]*\))?)*)$/i;
const PART = /[#.][\w-]+|\[[^\]]*\]|::[\w-]+|:[\w-]+(?:\([^)]*\))?/g;

/* Parse one compound selector into its pieces, or null when unsupported. */
function parseCompound(text) {
  const m = text.match(COMPOUND);
  if (!m) return null;
  const tagRaw = m[1];
  const out = {
    tag: tagRaw && tagRaw !== '*' ? tagRaw.toLowerCase() : null,
    ids: [], classes: [], attrs: [], pseudoClasses: [], pseudoEl: null,
  };
  const parts = m[2] ? m[2].match(PART) || [] : [];
  let consumed = 0;
  for (const p of parts) {
    consumed += p.length;
    if (p.startsWith('::')) { out.pseudoEl = p.slice(2).toLowerCase(); continue; }
    if (p.startsWith('#')) { out.ids.push(p.slice(1)); continue; }
    if (p.startsWith('.')) { out.classes.push(p.slice(1)); continue; }
    if (p.startsWith('[')) {
      const am = p.slice(1, -1).match(/^([\w-]+)(?:\s*([~^|$*]?=)\s*["']?([^"']*)["']?)?$/);
      if (!am) return null;
      out.attrs.push({ name: am[1].toLowerCase(), op: am[2] || null, value: am[3] });
      continue;
    }
    if (p.startsWith(':')) { out.pseudoClasses.push(p.slice(1).toLowerCase()); continue; }
    return null;
  }
  // Anything the tokenizer could not account for means "unsupported", not "empty".
  if (m[2] && consumed !== m[2].length) return null;
  return out;
}

/* Does `el` satisfy one compound? `el` = { tag, id, classes:[], attrs:{},
 * states:[] } — `states` lists the pseudo-classes that currently hold. */
function compoundMatches(c, el) {
  if (c.tag && c.tag !== String(el.tag || '').toLowerCase()) return false;
  if (c.ids.some((id) => id !== el.id)) return false;
  if (c.classes.some((cl) => !(el.classes || []).includes(cl))) return false;
  for (const a of c.attrs) {
    const have = (el.attrs || {})[a.name];
    if (have === undefined) return false;
    if (a.op === '=' && String(have) !== a.value) return false;
    if (a.op && a.op !== '=') return false; // unsupported operator → treat as no match
  }
  if (c.pseudoClasses.some((pc) => !(el.states || []).includes(pc))) return false;
  return true;
}

/* Match a full selector against the subject element. Ancestor compounds are
 * satisfied from `el.ancestors` — { tag, id, classes, attrs, states } entries,
 * outermost first. Combinators other than descendant are unsupported. */
function selectorMatches(selector, el) {
  if (/[>+~]/.test(selector)) return { ok: false, unsupported: true };
  const compounds = selector.trim().split(/\s+/);
  const parsed = compounds.map(parseCompound);
  if (parsed.some((p) => p === null)) return { ok: false, unsupported: true };

  const subject = parsed[parsed.length - 1];
  if (!compoundMatches(subject, el)) return { ok: false };

  const chain = (el.ancestors || []).slice().reverse();
  let ai = 0;
  for (let k = parsed.length - 2; k >= 0; k--) {
    let found = false;
    while (ai < chain.length) {
      if (compoundMatches(parsed[k], chain[ai++])) { found = true; break; }
    }
    if (!found) return { ok: false };
  }
  return { ok: true, specificity: specificityOf(parsed), pseudoEl: subject.pseudoEl };
}

function specificityOf(parsed) {
  let a = 0, b = 0, c = 0;
  for (const p of parsed) {
    a += p.ids.length;
    b += p.classes.length + p.attrs.length + p.pseudoClasses.length;
    c += (p.tag ? 1 : 0) + (p.pseudoEl ? 1 : 0);
  }
  return [a, b, c];
}

function cmpSpecificity(x, y) {
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/* ---------- value resolution ---------- */

/* The `border` shorthand, expanded to the longhands these tests assert. */
function expand(prop, value) {
  if (prop !== 'border') return [[prop, value]];
  const parts = value.split(/\s+/);
  const isWidth = (p) => /^[\d.]+(px|em|rem)$/.test(p);
  const isStyle = (p) => /^(solid|dashed|dotted|none|hidden|double)$/.test(p);
  const width = parts.find(isWidth) || 'medium';
  const style = parts.find(isStyle) || 'none';
  const color = parts.find((p) => !isWidth(p) && !isStyle(p)) || 'currentcolor';
  const out = [];
  for (const side of ['top', 'right', 'bottom', 'left']) {
    out.push([`border-${side}-width`, width]);
    out.push([`border-${side}-style`, style]);
    out.push([`border-${side}-color`, color]);
  }
  return out;
}

/* Resolve `var(--x[, fallback])` against a custom-property map, recursively. */
function resolveVars(value, vars, depth = 0) {
  if (depth > 10 || !/var\(/.test(String(value))) return value;
  const out = String(value).replace(
    /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g,
    (_, name, fallback) => (Object.prototype.hasOwnProperty.call(vars, name)
      ? vars[name]
      : (fallback || '').trim()));
  return resolveVars(out, vars, depth + 1);
}

/* Winning declarations for an element, or for one of its pseudo-elements. */
function computeStyle(sheet, el, pseudoEl = null) {
  const winners = new Map();
  for (const rule of sheet.rules) {
    const m = selectorMatches(rule.selector, el);
    if (!m.ok) continue;
    if ((m.pseudoEl || null) !== (pseudoEl || null)) continue;
    for (const [rawProp, rawValue] of rule.decls) {
      const important = /!important\s*$/i.test(rawValue);
      const value = rawValue.replace(/\s*!important\s*$/i, '').trim();
      for (const [prop, val] of expand(rawProp, value)) {
        const prev = winners.get(prop);
        const sameImportance = important === (prev ? prev.important : false);
        const beats = !prev
          || (important && !prev.important)
          || (sameImportance && (cmpSpecificity(m.specificity, prev.specificity) > 0
              || (cmpSpecificity(m.specificity, prev.specificity) === 0 && rule.order > prev.order)));
        if (beats) {
          winners.set(prop, { value: val, specificity: m.specificity, order: rule.order, important });
        }
      }
    }
  }
  const out = {};
  winners.forEach((v, k) => { out[k] = v.value; });
  return out;
}

/* Which rule wins one property — for asserting WHY, not just what. */
function winningRule(sheet, el, prop, pseudoEl = null) {
  let best = null;
  for (const rule of sheet.rules) {
    const m = selectorMatches(rule.selector, el);
    if (!m.ok) continue;
    if ((m.pseudoEl || null) !== (pseudoEl || null)) continue;
    for (const [rawProp, rawValue] of rule.decls) {
      for (const [p] of expand(rawProp, rawValue.replace(/\s*!important\s*$/i, '').trim())) {
        if (p !== prop) continue;
        const cand = { selector: rule.selector, value: rawValue, specificity: m.specificity, order: rule.order };
        if (!best || cmpSpecificity(cand.specificity, best.specificity) > 0
            || (cmpSpecificity(cand.specificity, best.specificity) === 0 && cand.order > best.order)) {
          best = cand;
        }
      }
    }
  }
  return best;
}

/* :root custom properties, themselves var()-resolved. */
function rootVars(sheet) {
  const vars = {};
  for (const rule of sheet.rules) {
    if (rule.selector !== ':root' && rule.selector !== 'html') continue;
    for (const [prop, value] of rule.decls) {
      if (prop.startsWith('--')) vars[prop] = value.replace(/\s*!important\s*$/i, '').trim();
    }
  }
  Object.keys(vars).forEach((k) => { vars[k] = resolveVars(vars[k], vars); });
  return vars;
}

/* ---------- colour helpers ---------- */

const NAMED = { white: [255, 255, 255], black: [0, 0, 0] };

function parseColor(value) {
  if (value == null) return null;
  const v = String(value).trim().toLowerCase();
  if (v === 'transparent' || v === 'none') return null;
  if (NAMED[v]) return NAMED[v];
  let m = v.match(/^#([0-9a-f]{3})$/);
  if (m) return m[1].split('').map((c) => parseInt(c + c, 16));
  m = v.match(/^#([0-9a-f]{6})$/);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (m) return [1, 2, 3].map((i) => Math.round(Number(m[i])));
  return null;
}

/* The first colour a background value paints — a plain colour, or the leading
 * stop of a linear-gradient, which is what these stylesheets use. */
function backgroundColor(decls, vars) {
  for (const prop of ['background', 'background-image', 'background-color']) {
    const raw = decls[prop];
    if (!raw) continue;
    const v = resolveVars(raw, vars);
    const first = v.match(/(#[0-9a-f]{3,6}|rgba?\([^)]*\))/i);
    if (first) { const c = parseColor(first[1]); if (c) return c; }
    const c = parseColor(v);
    if (c) return c;
  }
  return null;
}

/* Max per-channel distance — the same metric the browser probe reports. */
function channelDistance(a, b) {
  if (!a || !b) return null;
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

module.exports = {
  parseSheet, parseCompound, selectorMatches, specificityOf, cmpSpecificity,
  computeStyle, winningRule, rootVars, resolveVars, parseColor, backgroundColor,
  channelDistance,
};
