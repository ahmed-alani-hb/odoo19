# POS Restaurant Kitchen Printing Robustness

A **removable** Odoo 19 add-on that hardens the restaurant kitchen-printing flow
and adds durable, filterable observability so you can verify POS stability —
especially during rush hours. It layers onto `pos_restaurant` purely through
Odoo's `patch()` (JS) and `_inherit` + `super()` (Python) mechanisms: **no core
file is modified**, and uninstalling the module fully restores stock behaviour.

## What it fixes

### 1. Duplicate kitchen tickets (Fix A — durable sent-state)
The real-world failure: when the POS can't reach the IoT directly and falls back
to the slow Odoo.sh websocket relay, a kitchen print often **times out even though
the ticket actually printed**. Stock POS marks the items sent only *locally* and
skips saving it when the print "failed"; our earlier version left them fully
pending. Either way the *"already sent"* fact is lost, so a page refresh or a
second device **re-sends and prints a duplicate**.

This module now **durably records "sent to the kitchen" on every send** — it
updates `last_order_preparation_change` *and* persists it to the server — so
neither a refresh nor another device re-sends the same items. Genuine print
failures stay recoverable through the **Retry/Reprint** popup, which reprints the
same ticket without creating a new diff.

> ⚠️ **Trade-off:** a kitchen print that *times out* is indistinguishable from one
> that genuinely *failed*, so this favours **never duplicating** over **never
> missing**. If a printer is truly down, the items are marked sent and a Retry
> popup is shown — staff must press **Reprint**. The reliable cure is to restore
> the **direct LAN connection to the IoT** (`docs/IOT_PRINTING_TROUBLESHOOTING.md`)
> so prints stop timing out and confirm reliably.

### 2. Double-send guard (Fix B)
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
| `mark_sent_forced` | items marked sent despite a failed/timed-out print, to avoid a duplicate (Fix A) |
| `sent_state_sync_deferred` | sent-state kept locally; server persist deferred (offline) |
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
