'use strict';
// CLAUDE.md rule 8: every Claude reply ends with a repo + branch footer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const md = fs.readFileSync(path.join(__dirname, '..', 'CLAUDE.md'), 'utf8');

test('CLAUDE.md keeps the repo footer rule', () => {
  assert.match(md, /\*\*Repo footer\.\*\*/);
  assert.match(md, /📁 Repo: sandrabrayer\/E-Zone-Dashboard · Branch: <current branch>/);
});
