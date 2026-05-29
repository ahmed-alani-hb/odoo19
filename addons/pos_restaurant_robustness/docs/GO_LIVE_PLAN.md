# POS Go-Live Plan: Odoo 17 (local) → Odoo 19 (Odoo.sh) — Zero-Surprise Edition

A step-by-step guideline to validate the customization and migrate the restaurant
from the **Odoo 17 local server** to **Odoo 19 on Odoo.sh**, with the explicit
goal of **zero unpredictable outcomes**. Follow the phases in order; do not skip a
go/no-go gate.

## Decisions locked for this project
- **Data:** Master data only (products, categories, customers, taxes, floors/tables,
  printer config) is carried to v19. Transactional history stays on the **Odoo 17
  server kept read-only as an archive**.
- **Printers:** ESC/POS **network** kitchen printers driven by third-party modules
  (*POS Network Printer / POS Order Receipt Printer / POS Kitchen Receipt Printers /
  ESC/POS Printer — creyox*).
- **Internet:** A **failover** connection will be added before cutover (treated as a
  prerequisite below).
- **Custom module:** `pos_restaurant_robustness` (kitchen-print fixes + *Kitchen
  Diagnostics* event log + test suite) is the safety net and the measurement tool.

## Zero-surprise principles (apply to every phase)
1. **Odoo 17 keeps running the business** until the final sign-off. It is always the
   fallback; it never loses data during this project.
2. **Change one variable at a time.** Don’t combine “new version” + “new printer
   path” + “new hardware” in a single untested step.
3. **Nothing reaches real customers untested.** In-restaurant testing runs *in
   parallel* with live 17, on clearly-labelled TEST devices.
4. **Every phase has a written pass/fail gate and a rollback.** If a gate fails, you
   stop — staying on 17 is always an acceptable outcome.
5. **Measure, don’t guess.** Use *Kitchen Diagnostics* (Point of Sale → Reporting →
   Kitchen Diagnostics) and the logbook to make every decision on data.

---

## ⚠️ TOP RISKS — read before you start
| # | Risk | Why it matters | De-risked in |
|---|---|---|---|
| R1 | **Cloud can’t reach LAN printers** | Odoo.sh is on the internet; ESC/POS printers are private LAN IPs. If the creyox modules print **server-side**, the cloud server literally cannot open a socket to the printer. | Phase A4 + B2 (must prove a working print path before cutover) |
| R2 | **Third-party (creyox) modules on v19** | They must exist for **19.0** and install cleanly; their print path must either work with, or be made to work with, the robustness fixes. | Phase A1/A4 |
| R3 | **Internet dependency** | Cloud POS is down if the line drops. | Failover prerequisite + Phase B5 drill |
| R4 | **17→19 is two major versions** | Master-data export/import must be validated; some config is re-entered by hand. | Phase A6/A9 |
| R5 | **Shared single user, multi-employee/table** | The original “disappearing orders” pain. | Phase A7 + B3 (observed via Diagnostics) |

> **R1 is the make-or-break item.** Likely resolutions if printing is server-side:
> (a) an **Odoo IoT Box** on the LAN bridging the printers (most robust; note this
> usually means using Odoo’s *standard* kitchen-printing, which the robustness
> module already covers); (b) **browser/client-side** printing if the creyox module
> supports it (browser is on the LAN); or (c) a **local print-relay agent** the
> cloud can hand jobs to. **Do NOT plan cutover until one of these is proven in
> Phase B2.**

---

## Roles, tools, logbook
- **Owner / decision-maker:** you (go/no-go authority).
- **Test captain:** one person who runs scripted scenarios and records results.
- **Optional:** an Odoo partner for the Odoo.sh build + any module compat fixes.
- **Tools:** laptop with Odoo 19 (Docker or source), the `odoo-custom-addons` repo,
  an Odoo.sh **staging** branch, the creyox v19 modules, a test ESC/POS network
  printer (or the real ones in Phase B).
- **Logbook:** one shared sheet. Columns: *date, phase, test ID, expected, actual,
  Diagnostics events seen, pass/fail, notes*. (Template in Appendix D.)

---

## PHASE A — Laptop (2 days). Functional + module + print-path proof

**Goal:** prove the full v19 software stack installs and behaves correctly, the
three original bugs are handled, and you understand exactly how printing will work
in the cloud — all before touching the restaurant.

### Day 1 — build, install, automated tests, print-path discovery
- [ ] **A1. Build the v19 stack locally.** Install Odoo 19; put `odoo-custom-addons`
      on the addons path (submodule or path); install the **creyox** modules
      (obtain the **19.0** versions). 🚦 **Gate G-A1:** if any creyox module has no
      working 19.0 version → STOP and resolve (vendor update / alternative /
      switch to IoT-Box standard printing) before continuing.
- [ ] **A2. Smoke test.** Create a restaurant POS config (shared user, a few
      products in kitchen categories, 2+ printers/stations, a couple of tables).
      Install `pos_restaurant_robustness`. Confirm **Kitchen Diagnostics** menu
      appears and the POS opens.
- [ ] **A3. Run the automated test suite — must be green:**
      ```
      odoo-bin -d test19 -u pos_restaurant_robustness --test-enable --stop-after-init \
        --test-tags=/pos_restaurant_robustness:TestSyncConcurrencySim,/pos_restaurant_robustness:TestPosOrderEventModel
      ```
      (Full suite incl. UI tours needs a headless browser; run if available.)
- [ ] **A4. Determine the PRINT PATH (critical).** With a test ESC/POS printer (or a
      packet capture), send a kitchen order and answer:
      - Does the print job leave the **Odoo server** (server→printer IP) or the
        **browser/agent** (LAN→printer)?
      - Do the creyox modules use Odoo’s standard `sendOrderInPreparation` /
        `printChanges` flow (→ robustness Fix A/B apply automatically and emit
        `kitchen_print_*` events), or their **own** print flow (→ fixes must be
        re-targeted, or switch to standard/IoT printing)?
      Write the answer in the logbook. 🚦 **Gate G-A4:** you must know the path and
      have a cloud-viable plan for it (see R1) before Phase B.
- [ ] **A5. Functional POS pass (simulated/desk printer).** Take orders → send to
      kitchen → pay → print bill → refund → split bill → transfer table. Confirm
      each kitchen ticket and each bill. Note anything off in the logbook.

### Day 2 — the three original bugs, resilience, master data
- [ ] **A6. Master-data dry run.** Export from 17 and import into laptop v19 in this
      order: *taxes → product & POS categories → products → customers → pricelists →
      floors/tables → printers/stations → payment methods → employees/the shared
      user* (Appendix A). Re-enter any creyox printer settings by hand.
- [ ] **A7. Reproduce & verify the 3 original failures using Diagnostics:**
      - **Missed ticket (Fix A):** force a printer failure (unplug/black-hole the IP)
        → confirm the items stay **pending** (not silently “sent”) and a
        `kitchen_print_fail` + `mark_sent_skipped` event is logged; on retry they
        print and clear. *(If A4 found a non-standard print path, instead verify the
        equivalent behaviour in that path and note the gap.)*
      - **Duplicate (Fix B):** double-click/rapid-fire “Order” → confirm only one
        print and a `double_send_blocked` event.
      - **Disappearing orders (R5):** open the **same table** in two browser tabs on
        the **shared user**; add items in each; sync → review
        `sync_table_match_diff_order` / `order_lines_overwritten` /
        `order_consolidated` events. Confirm no order line is lost (this is what the
        `TestSyncConcurrencySim` test asserts).
- [ ] **A8. Network-loss resilience.** Mid-order, cut the laptop’s network → observe
      POS behaviour → reconnect → confirm orders sync and nothing is double-charged
      or lost.
- [ ] **A9. Validate master data (checklist).** Record counts (products, customers,
      taxes, tables) old vs new; spot-check 10 products (price, tax, kitchen
      category routing), 5 customers, every printer/station mapping.
- [ ] **A10. Light load check.** Load your real product count; run ~20 quick orders;
      confirm responsiveness and the Diagnostics pivot looks clean.

🚦 **GATE G-A (exit Phase A):** all automated tests green; the 3 bugs behave as
expected and are visible in Diagnostics; master-data import validated; **print path
understood with a cloud-viable plan**. If any fail → fix on the laptop and repeat.
**Rollback:** none needed — production is still 17, untouched.

---

## PHASE B — In the restaurant, real network + real printers (PARALLEL with live 17)

**Goal:** prove the *exact* printing and network behaviour on the real hardware and
LAN, against the **Odoo.sh staging** build — while Odoo 17 keeps serving customers.

> **Safety:** this is a STAGING test. Use a separate Odoo.sh **staging** branch/build
> and a **test** POS config. Label test tablets clearly. **Do not take real customer
> orders on v19 in this phase.**

- [ ] **B0. Prereqs on site:** Odoo.sh staging build ready with all modules; test
      device(s) that match the real POS hardware/browsers; access to each kitchen
      printer; the failover connection installed (or its absence logged as accepted
      risk for this test).
- [ ] **B1. Connectivity & latency.** From a test tablet on the restaurant network,
      open the Odoo.sh staging POS over the internet. Measure page-load and
      order-sync latency; test on the **actual** POS hardware and browser used in
      production.
- [ ] **B2. Printer reachability — THE critical test (R1).**
      - First, from a LAN device confirm the printer is alive at the raw level:
        `telnet <printer_ip> 9100` (or `nc -vz <printer_ip> 9100`).
      - Confirm the cloud server **cannot** reach that IP (expected) — proving why
        the print path must be client-side / IoT Box / local agent.
      - Then **send real kitchen tickets to EVERY printer/station** from the v19
        staging POS (one order per kitchen category). For each: correct printer,
        correct content, no missed, no duplicate. Cross-check every send in
        **Kitchen Diagnostics**.
      🚦 **Gate G-B2:** every station prints reliably from the cloud build. If not,
      adjust the print architecture (IoT Box / browser / agent) and repeat. **Cutover
      cannot proceed past a failed G-B2.**
- [ ] **B3. Multi-employee / multi-table on real devices.** Several staff on the
      shared user, multiple tablets, deliberately opening the **same tables**. Watch
      Diagnostics for consolidation/overwrite events; confirm no orders “disappear”
      and tickets are correct.
- [ ] **B4. Rush-hour simulation.** Replay a busy service: ~40–60 orders in 20–30 min
      across all tables and printers, with edits/splits/transfers. Then open the
      Diagnostics **pivot (event type × minute)**. Pass = **0 missed and 0 duplicate
      kitchen tickets**, acceptable latency, no lost orders.
- [ ] **B5. Failure drills.**
      - Pull a printer’s power/network mid-ticket → confirm retry/pending behaviour
        and recovery (no missed ticket once restored).
      - Pull the **internet** mid-service → confirm POS offline behaviour and clean
        recovery on reconnect. This validates *why* failover matters and how staff
        should react.

🚦 **GATE G-B (exit Phase B / go-no-go to cutover):** G-B2 passed on every station;
rush-hour sim had **0 missed / 0 duplicate** tickets; multi-employee tables behaved;
internet-loss handled; failover present (or a documented, accepted contingency).
**Rollback:** none needed — production is still 17.

---

## PHASE C — Cutover (Odoo 17 local → Odoo 19 Odoo.sh)

**Goal:** switch production with a rehearsed, reversible procedure during a low-risk
window.

- [ ] **C0. Pre-cutover checklist (all must be ✅):** failover internet live (or
      accepted); G-A and G-B passed; all real devices provisioned and bookmarked to
      the **production** Odoo.sh URL; every printer/station mapped and re-tested from
      production; staff trained on v19 + on the “internet down” procedure; rollback
      rehearsed (you’ve practised repointing a device back to 17).
- [ ] **C1. Pick the window:** after close / slowest day. Never mid-service.
- [ ] **C2. Freeze & final sync:** set Odoo 17 to read-only for edits; do the final
      **delta** master-data export→import (any products/customers added since A6);
      re-validate counts (Appendix A/Day-2 checklist).
- [ ] **C3. Controlled parallel validation:** with 17 still available, run a handful
      of **real** orders on v19 production across stations — confirm kitchen prints
      and bills are perfect.
- [ ] **C4. GO / NO-GO:** if C3 is clean and all C0 items ✅ → **GO**: move all staff
      to v19. If anything is off → **NO-GO**: revert devices to 17 (it never left
      service); fix and reschedule. Either outcome is safe.
- [ ] **C5. Keep 17 as instant rollback** for at least **2–4 weeks** (running and
      restorable). Document the exact rollback steps and a target *time-to-rollback*
      (e.g., < 15 min): repoint devices/bookmarks to the 17 server, resume on 17.

---

## PHASE D — Post-cutover monitoring (first 2 weeks)

- [ ] **D1. Daily Diagnostics review.** Open Kitchen Diagnostics pivot (event type ×
      hour). Track `kitchen_print_fail`, `mark_sent_skipped`, `double_send_blocked`,
      `order_consolidated`, `sync_table_match_diff_order`. Target: trending to ~0.
- [ ] **D2. Defined rollback triggers.** Pre-agree thresholds that force a fallback to
      17, e.g.: sustained internet outage with no failover; > X missed tickets/hour
      that staff can’t work around; data integrity doubt. If hit → execute C5
      rollback, no debate.
- [ ] **D3. Decommission 17** only after a clean stabilisation period **and** a full
      accounting period-close on 19. Archive the 17 DB (it remains your history).

---

## Appendix A — Master-data export/import order & checklist
Export from 17 (Settings → Technical → Export, or list view → Export), import to 19
in dependency order. Keep an ID/reference column so relations resolve.
1. Account taxes → 2. Product categories + POS categories → 3. Products
(`product.template`/`product.product`, incl. POS availability + kitchen category) →
4. Customers (`res.partner`) → 5. Pricelists → 6. Restaurant floors & tables →
7. Printers/stations + **creyox printer settings (re-enter by hand)** → 8. Payment
methods → 9. Employees + the shared POS user.
**Validate:** counts old vs new for each model; spot-check prices, taxes, and
**kitchen-category → printer routing** for 10 products.

## Appendix B — Using the safety net
- Run tests: see Phase A3. Re-run after any module/config change.
- Read Diagnostics: **Point of Sale → Reporting → Kitchen Diagnostics**. List view +
  filters (by table/session/device/receipt) to trace one ticket end-to-end; **pivot
  / graph (event type × hour)** to spot spikes. Events older than 90 days auto-purge.
- The module is **removable**: if anything about its behaviour is unwanted, uninstall
  it to restore stock Odoo behaviour exactly.

## Appendix C — Device & printer inventory (fill in before Phase B)
| Station / printer | Model | IP:port | Kitchen category | Reaches via (server/IoT/browser) | Tested ✅ |
|---|---|---|---|---|---|
| | | | | | |

## Appendix D — Test logbook template
| Date | Phase | Test ID | Expected | Actual | Diagnostics events | Pass/Fail | Notes |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

---

### One-line summary of the safety model
Odoo 17 runs the restaurant the entire time; v19 is proven on a laptop, then on the
real network/printers in parallel, and only becomes production after two explicit
go/no-go gates — with 17 kept as an instant rollback for weeks afterward.
