# POS Restaurant Kitchen Printing Robustness

A **removable** Odoo 19 add-on that hardens the restaurant kitchen-printing flow
and adds durable, filterable observability so you can verify POS stability —
especially during rush hours. It layers onto `pos_restaurant` purely through
Odoo's `patch()` (JS) and `_inherit` + `super()` (Python) mechanisms: **no core
file is modified**, and uninstalling the module fully restores stock behaviour.

## What it fixes

### 1. Duplicate **and** lost kitchen tickets (Fix A — smart sent-state)
When the POS can't reach the IoT directly and falls back to the slow Odoo.sh
websocket relay, a kitchen print often **times out even though the ticket actually
printed**. Stock POS marks the items sent only *locally* and skips saving it when
the print "failed", so the *"already sent"* fact is lost on a refresh / second
device → **duplicate ticket**. Naively always-marking-sent would instead **lose** a
ticket that genuinely never printed.

This module **classifies the failure** and persists the sent-state accordingly:

| Print outcome | Action | Why |
|---|---|---|
| success | mark sent + persist | normal |
| **ambiguous** failure (e.g. IoT **timeout** — usually printed) | mark sent + persist | a refresh / 2nd device can't re-send → **no duplicate** |
| **definite** failure (printer **unreachable / no paper / cover open**) | keep items **pending** | nothing printed → re-sent on retry/next send → **no lost order** |

Either way the **Retry/Reprint** popup is shown so staff can reprint (Reprint
re-prints the same ticket without creating a new diff). The classifier is
`isDefiniteNoPrint()`.

> ⚠️ The reliable cure for the underlying timeouts is to restore the **direct LAN
> connection to the IoT** (`docs/IOT_PRINTING_TROUBLESHOOTING.md`); then prints
> confirm reliably and neither duplicates nor lost tickets occur — this is a
> safety net for when they don't.

### 2. Self-healing double-send guard (Fix B)
A per-order in-flight guard coalesces rapid double-clicks / parallel "send to
kitchen" calls for the same order, so the same ticket can't be printed twice. The
guard **auto-releases after 30s** so a hung IoT print or order-sync (a promise that
never settles) can never **freeze the Send button until a page refresh** — and that
refresh is exactly what dropped the local "sent" state and caused a duplicate.
Retrying in place keeps the local sent-state, so already-sent lines aren't
re-printed. While a send is in progress a further press shows *"Still sending the
previous ticket — please wait…"*; an auto-release is logged as `send_guard_timeout`.

### 3. Duplicate tickets from concurrent two-device sends (Fix C — prep-change merge)
When two devices send to the kitchen at the **same moment**, core's
`_ensure_to_keep_last_preparation_change` keeps the *newer* sent-state and
**discards the older one** (it logs *"Preparation changes were outdated"*). The
discarded device loses its "already sent" record and **re-sends on the next
refresh → duplicate ticket**. This module **merges** the two states instead —
the union of sent lines, keeping the greater sent quantity per line
(`_merge_preparation_changes`, unit-tested) — so neither device's printed items
are lost and nothing gets re-sent. Logged as `prep_change_merged`.

> ⚠️ This addresses the **same-order** concurrent case. If two devices collide on
> **different** tables, the symptom is a stalled sync (not a prep-change
> conflict) and the lever is **Odoo.sh worker count** / reducing load on the PC
> that also hosts the IoT — see GO_LIVE_PLAN.md. **Validate this merge in an
> Odoo.sh staging build with two devices before relying on it in production.**

### 4. Disappearing orders on shared tables (observed, not changed)
When two employees open the same table, Odoo merges/overwrites orders. This
module **does not change** that logic yet — it **measures** it: every table
match, overwrite, consolidation and preparation-change conflict is logged so you
can quantify how often it happens before deciding on a fix. The pure-Python
simulator (`tests/test_sync_concurrency_sim.py`) is the regression gate for a
future fix.

## Observability — *Kitchen Diagnostics*

A `pos.order.event` log captures, from both the frontend and the backend:

| Event | Meaning |
|---|---|
| `kitchen_send_attempt` / `kitchen_print_ok` | normal send / fully printed |
| `kitchen_print_partial` / `kitchen_print_fail` | some / all printers failed |
| `kitchen_print_retry` | user retried a failed printer |
| `mark_sent_forced` | ambiguous failure (e.g. timeout) → items marked sent to avoid a duplicate (Fix A) |
| `mark_sent_skipped` | definite failure (unreachable/no paper) → items kept pending to avoid a lost order (Fix A) |
| `sent_state_sync_deferred` | sent-state kept locally; server persist deferred (offline) |
| `send_guard_timeout` | a hung send's in-flight guard was auto-released after 30s (Fix B) so Send isn't frozen |
| `prep_change_merged` | concurrent two-device kitchen states were merged to avoid a duplicate (Fix C) |
| `double_send_blocked` | a duplicate send was coalesced (Fix B) |
| `sync_table_match_diff_order` | a sync matched a *different* order on the same table |
| `order_lines_overwritten` | an existing order's lines were rewritten during a sync |
| `order_consolidated` | open orders on a table were merged and some deleted |
| `prep_change_conflict` | an incoming preparation change was outdated and dropped |

Open **Point of Sale → Reporting → Kitchen Diagnostics**. Use the **pivot/graph**
(event type × hour) to spot rush-hour spikes, and the list filters
(by table / session / device / receipt) to trace a single "missed ticket"
complaint end-to-end. Events older than 90 days are purged by a daily cron
(`pos_restaurant_robustness.retention_days` to change the window).

Frontend events are buffered client-side and flushed via a fire-and-forget
`silentCall`, so logging can never delay or break a kitchen ticket.

## Tests

```bash
# Python tests (event-log model + multi-employee concurrency simulator) — no browser
./odoo-bin -d <db> -u pos_restaurant_robustness --test-enable --stop-after-init \
  --test-tags=/pos_restaurant_robustness:TestSyncConcurrencySim,/pos_restaurant_robustness:TestPosOrderEventModel
```

The JS behaviour — kitchen-print **failure classification**, **durable sent-state**,
and the **double-send guard** — is covered by the Hoot unit tests in
`static/tests/unit/**`, which run in the JS unit-test runner (no fragile,
environment-dependent browser tours).

## Reversibility
Every change is additive (a new service + `patch()`es + `_inherit` hooks that
only log around `super()`). Uninstalling the module removes the patches and the
`pos.order.event` table and restores stock behaviour exactly.
