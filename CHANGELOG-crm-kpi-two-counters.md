# CHANGELOG — «גבייה לביצוע» and «ממתין לאימות אורטל» as two distinct counters

Date: 2026-10-29 · Branch `claude/kpi-two-counters` → base `claude/build-ezone-dashboard-QOg5s`
Decision: Sandra, 29/10 («כן לשלושתם»), per the work package §8. UI only, SW v104 → v105.

- The first card of Vered's / Sandra's day is now **«גבייה לביצוע»** (big number) + **«ממתין לאימות
  אורטל»** (second number on the same card, like «פגישות היום / תיאומים פתוחים»).
- «גבייה לביצוע» = what Vered acts on: recorded debts past their cycle, cycles without a report
  due, collection tasks due, and flagged / partial receipts awaiting **her** decision.
- «ממתין לאימות אורטל» = reported receipts — not confirmed cash, not her task; never counted as
  collection work and never a second collection demand for the same amount. The rows stay under
  «ממתין לגורם אחר» with אורטל as owner.
- Hint: «N מחזורים פתוחים · דיווח אינו כסף מאומת». While payments load the second counter shows «…»,
  if they failed «—» — never 0.
- **No debt calculation changed** (`debtAging`, balances, the ledger are untouched).
- Tests updated (`crm-my-day`, `crm-ortal-day`, browser labels); SW guards. `npm audit`: 0
  high/critical. Nothing to set.
