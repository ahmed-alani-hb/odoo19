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
| R1 | **Cloud can’t reach LAN printers — CONFIRMED** | Reviewed: creyox prints **server-side** — the browser calls the Odoo route `/cr_print_receipt` and the **server** opens a TCP socket (`escpos … Network(ip, 9100)`) to the printer’s LAN IP. An Odoo.sh **cloud** server cannot reach private LAN IPs → **kitchen + receipt printing and the cash drawer all stop on cloud, as-is.** | Must be solved & proven before cutover — see *Code review findings* + Phase B2 |
| R2 | **Third-party (creyox) modules on v19** | Reviewed: they ARE genuine 19.0 builds on v19-valid hooks (`createPrinter`, `afterProcessServerData`, `type='jsonrpc'`). They need the **`python-escpos`** pip package and have an **`auth="none"`** print endpoint that must be hardened. | *Code review findings* below + Phase A1 |
| R3 | **Internet dependency** | Cloud POS is down if the line drops. | Failover prerequisite + Phase B5 drill |
| R4 | **17→19 is two major versions** | Master-data export/import must be validated; some config is re-entered by hand. | Phase A6/A9 |
| R5 | **Shared single user, multi-employee/table** | The original “disappearing orders” pain. | Phase A7 + B3 (observed via Diagnostics) |

> **R1 is now CONFIRMED — it is the make-or-break item. Do not schedule a cutover
> until it is solved and proven on real printers in Phase B2.** Details and options
> are in the next section.

## Code review findings — the three custom modules

Reviewed together: **`cr_pos_network_printer`** (receipt/bill printer + cash drawer),
**`cr_pos_network_printer_res`** (restaurant kitchen printers), and our
**`pos_restaurant_robustness`**.

### How creyox printing actually works (the decisive fact)
The browser renders the ticket to an image and calls the Odoo JSON route
**`/cr_print_receipt`** (and **`/open_cash_drawer`**). The **Odoo server** then opens
a **TCP socket** to the printer’s LAN IP:port using the `python-escpos`
`Network(ip, port)` driver and sends the ESC/POS bytes. Kitchen printers
(`pos.printer` of type *“cr_network_printer”*) are wired via `PosStore.createPrinter`;
the receipt/bill printer via `PosStore.afterProcessServerData → hardwareProxy.printer`.

**So printing is SERVER-SIDE.** It works today only because the Odoo 17 server sits on
the same LAN as the printers. On **Odoo.sh (cloud)** the server is on the internet and
cannot reach `192.168.x.x:9100`, so **all printing and the cash drawer stop working
unless the architecture changes.**

### ✅ Good news
- The creyox modules are genuine **19.0** builds and use only v19-valid APIs
  (verified: `createPrinter`, `afterProcessServerData`, route `type='jsonrpc'`).
- Their kitchen printers plug in *beneath* Odoo’s standard
  `sendOrderInPreparation → printChanges → printReceipt → sendPrintingJob` flow — the
  exact flow `pos_restaurant_robustness` patches. **So our missed-ticket fix (A),
  double-send guard (B) and Kitchen Diagnostics all apply to the creyox kitchen
  printers automatically.** No change to our module is needed, and the three modules
  compose with no method conflicts.

### 🔧 Required changes / decisions before cutover
1. **Pick a cloud-compatible printing architecture (R1) and prove it in B2:**
   - **(a) Odoo IoT Box — recommended.** Printers go on a LAN IoT Box; cloud Odoo
     drives them through it using Odoo’s *standard* printer flow (which our module
     already enhances), so creyox is retired for printing. Lowest long-term surprise;
     modest hardware cost.
   - **(b) Local print-relay agent — keeps creyox’s ESC/POS approach.** Run the
     `/cr_print_receipt` + `/open_cash_drawer` logic as a small service on a **LAN**
     box (the old Odoo 17 machine, a mini-PC, or a Pi) and point the browser’s
     `CrPrinter` at that **local** agent instead of the cloud route. The agent must
     serve **HTTPS with a certificate the POS devices trust** — the Odoo.sh page is
     HTTPS, so an `http://` agent is blocked as mixed content. No new printer
     hardware, but custom to build and maintain.
   - **(c) Stay on a local Odoo 19 server (on-prem).** Preserves creyox printing
     exactly and removes the internet dependency — at the cost of not using Odoo.sh.
   > **Zero-surprise recommendation: (a) IoT Box** — the officially supported cloud
   > pattern, no custom cert/agent burden, and our module already covers that path.
   > Choose (b) only if avoiding an IoT Box is a hard requirement; (c) if rock-solid
   > printing matters more than being on the cloud.
2. **`python-escpos` dependency.** Whatever server does the actual socket printing
   (cloud for option c, or the local agent for b) needs the `python-escpos` pip
   package. On Odoo.sh add a **root `requirements.txt`** with `python-escpos`
   (`Pillow` is already present); otherwise the module errors on install.
3. **Harden the print endpoints (do this regardless).** `/cr_print_receipt` and
   `/open_cash_drawer` are declared `auth="none"` with `cors="*"` and will open a
   socket to **any ip:port the caller supplies** — on an internet-facing server that
   is an unauthenticated SSRF + remote cash-drawer-open endpoint. Require an
   authenticated POS session (`auth="user"`) and validate/whitelist the target IP.
   Ask Creyox for a hardened/cloud build, or apply it in a thin override — **never
   expose `auth="none"` on the public internet.**
4. **Worker load (minor).** Server-side socket printing blocks an Odoo worker for up
   to ~5 s + retries per ticket. Fine at restaurant scale; just size workers and, for
   option (b), keep printing off the cloud request workers.

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
      on the addons path (submodule or path); install the **creyox** modules (19.0 —
      confirmed available) and `pip install python-escpos`. Stand up the **chosen
      cloud-print architecture** from *Code review findings* (IoT Box, or a local
      print-relay agent) so it can be exercised on the bench. 🚦 **Gate G-A1:** all
      three modules install cleanly with `python-escpos` present, and the chosen
      print bridge is in place, before continuing.
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
- [ ] **A4. Validate the CLOUD print architecture (critical).** The print path is
      already known — server-side, confirmed in review — and the robustness fixes are
      confirmed to wrap the creyox kitchen printers. So A4 is now: with a test ESC/POS
      printer, prove the **chosen** cloud-print route (IoT Box, or the local agent
      reached over **HTTPS**) actually prints when Odoo runs cloud-style (i.e. the
      Odoo server is NOT on the printer LAN), and confirm `kitchen_print_ok/fail`
      events appear in Kitchen Diagnostics. 🚦 **Gate G-A4:** the chosen architecture
      prints reliably and is visible in Diagnostics before Phase B.
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
