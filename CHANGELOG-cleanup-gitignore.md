# Cleanup: gitignore settings.local.json

## What

- Added `.claude/settings.local.json` to `.gitignore`.
- Removed `.claude/settings.local.json` from git tracking (`git rm --cached`).

## Why

`.claude/settings.local.json` is a local, per-developer Claude Code settings
file. It was accidentally committed in commit `e6605d6` and should not be
tracked in the repository.

## Scope

No application code or behavior changes. Tracking/ignore rules only.
