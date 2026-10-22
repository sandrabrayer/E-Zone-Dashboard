# CHANGELOG — CLAUDE.md repo footer rule

**Date:** 2026-10-22 · **Type:** docs only (no runtime change)

## What changed
- `CLAUDE.md` gains rule 8, **Repo footer**: every Claude reply to Sandra ends with
  `📁 Repo: sandrabrayer/E-Zone-Dashboard · Branch: <current branch>`, so the
  working repo is always visible in the Claude app / web (where the terminal
  status line is not shown).
- The same rule is added to the CLAUDE.md of every sibling repo (separate PRs).

## Tests
- `test/claude-md-repo-footer.test.js` — asserts CLAUDE.md keeps the rule and
  names this repo.

## Security
- No code, secrets, endpoints or deploy settings touched. No Railway or Apps
  Script change; nothing for Sandra to configure.
