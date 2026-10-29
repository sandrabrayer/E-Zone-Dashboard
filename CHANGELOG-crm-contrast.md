# CHANGELOG — CRM contrast pass

Date: 2026-10-29 · Branch `claude/crm-contrast` → base `claude/build-ezone-dashboard-QOg5s`
Sandra, on the first live look at Stage 2: «הצבעים בהירים מדי — תחזק את כל הרקעים וגם את הכיתוב».

`public/crm/crm.css` only (+ `theme-color`, SW v99 → v100). No JS, no Code.gs, no server change.

- Page background `#F5F7FA` → `#E6ECF2`; secondary surface `#EEF2F6` → `#DCE4EC`; menu `#F3F6F9`;
  borders `#DCE3EA` → `#B9C6D2`; shadows a little deeper. Cards stay white so they read as cards.
- Text `#172B36` → `#0E1B25`; muted `#5B6B78` → `#3C4E5C`; dim `#7E8C97` → `#566876`; the action,
  ok, warn and bad colours one step darker (`#0B6B63`, `#136B33`, `#B4380B`, `#A31515`).
- Card labels, chips, names and nav-group headings heavier (600–700); small text 12 → 13px;
  the header date / user in full text colour; chips get a filled background.
- Tests updated: `crm-my-day` tokens, `crm-shell-browser` body colour, `crm-pwa` theme-color,
  SW guards (`crm-pwa`, `dashboard-perf-assets`). Full suite green. `npm audit`: 0 high/critical.
- Deploy: nothing to set.
