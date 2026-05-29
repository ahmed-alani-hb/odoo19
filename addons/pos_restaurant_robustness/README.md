# POS Restaurant Kitchen Printing Robustness

A **removable** Odoo 19 add-on that hardens the restaurant kitchen-printing flow
and adds durable, filterable observability so you can verify POS stability —
especially during rush hours. It layers onto `pos_restaurant` purely through
Odoo's `patch()` (JS) and `_inherit` + `super()` (Python) mechanisms: **no core
file is modified**, and uninstalling the module fully restores stock behaviour.

## What it fixes

### 1. Missed kitchen tickets (Fix A)
Stock POS marks an order's items as *"sent to the kitchen"* as soon as you press
**Order**, even if the kitchen printer was unreachable — so the ticket silently
never prints and is never re-sent. This module advances the *"already sent"*
marker (`last_order_preparation_change`) **only when the print actually
succeeds**. On a failed or partial print the items stay *pending* and are
re-sent by the existing retry (or the next send).

> ⚠️ **Behaviour change:** with this module installed, pressing *Order* when the
> printer is down leaves the items pending (shown as *to-order*) instead of
> clearing them. This is intentional — it is the missed-ticket fix.

### 2. Duplicate kitchen tickets (Fix B)
A per-order in-flight guard coalesces rapid double-clicks / parallel "send to
kitchen" calls for the same order, so the same ticket can't be printed twice.

### 3. Disappearing orders on shared tables (observed, not changed)
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
| `mark_sent_skipped` | items kept pending because the print failed (Fix A) |
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
# Browser-independent tests (event-log model + concurrency simulator)
./odoo-bin -d <db> -u pos_restaurant_robustness --test-enable --stop-after-init \
  --test-tags=/pos_restaurant_robustness:TestSyncConcurrencySim,/pos_restaurant_robustness:TestPosOrderEventModel

# Full suite, including the UI tours (requires a headless browser)
./odoo-bin -d <db> -u pos_restaurant_robustness --test-enable --stop-after-init \
  --test-tags=/pos_restaurant_robustness
```

The Hoot unit tests (`static/tests/unit/**`) run in the JS unit-test runner.

## Reversibility
Every change is additive (a new service + `patch()`es + `_inherit` hooks that
only log around `super()`). Uninstalling the module removes the patches and the
`pos.order.event` table and restores stock behaviour exactly.
