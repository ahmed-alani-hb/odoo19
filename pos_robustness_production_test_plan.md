# Production Test Plan — POS Kitchen‑Print Robustness

**Audience:** Claude for Chrome (browser agent). Execute these steps in the **live Odoo 19 POS** and report results using the template in §5.
**Build under test:** production branch `odoo-custom-addons` @ commit `b7fa53b5`, module **`pos_restaurant_robustness`**.
**What we're validating:** the new "no silent kitchen prints" hardening (persisted *unconfirmed* marker, ~25 s confirmation timeout, startup sweep, and a persistent **red alert banner** injected at the POS root) **did not break the POS**, and that failed/unconfirmed kitchen prints are now surfaced (banner + table bubble + retry panel) instead of silently lost.

---

## 0. READ FIRST — this is PRODUCTION 🔴

- **Prefer to run outside service hours.** You will create and send test orders.
- Use **one dedicated test table** (an unused/corner table) and **one cheap test product**.
- **Never** take a payment or validate/settle a real customer order as part of testing.
- **Every test order you create must be cancelled/deleted** at the end (see §4 Cleanup).
- **Do not change** any printer or IoT hardware configuration.
- The console snippets in the optional tests are **local‑only** (they add a marker to the on‑screen order state); they do **not** print or change server data — except **Retry**, which sends a real ticket to the printer.
- 🛑 **If the POS shows a blank/white screen, fails to load, or throws errors:** STOP, capture a screenshot + copy the red Console errors, and report immediately under TC1. Do not keep clicking.

---

## 1. Setup & access

1. Open the production Odoo and **log in** (ask the operator to log in if a login is required — do not guess credentials).
2. Open **DevTools → Console** (F12) and keep it visible the whole time, so JavaScript errors are captured.
3. Open the POS: **Point of Sale** app → the **"صالة"** register → **Open/Continue session**. (If a session is already open on a real device, coordinate first — do not disrupt it.)
4. (For the optional console tests) make sure you are on the **POS browser tab** (the full‑screen POS UI), not the backend.

**Console helper — grab the POS store** (used only by the optional TC4–TC6). Paste into the Console:
```js
window.__pos = (() => { try { return odoo.__WOWL_DEBUG__.root.env.services.pos; } catch (e) { return null; } })();
console.log("POS store:", window.__pos ? "FOUND" : "NOT FOUND");
```
If it prints **NOT FOUND**, report that and **skip** the optional console tests (TC4–TC6); do TC1, TC2, TC3, TC7, TC8 instead.

---

## 2. Critical UI tests (agent can do these fully — no hardware)

### TC1 — POS loads cleanly on every screen  ⭐ highest priority
*Why:* the new alert banner is injected at the POS root (Chrome); a template error there would break the whole POS. This test de‑risks the deploy.
1. Look at the **Floor** screen — tables render normally.
2. Click the test table → **Product** screen renders.
3. Open the **Orders / Ticket** screen (the Orders button).
4. Open the **navbar menu** (hamburger / "⋮").
- **Expected:** every screen renders normally; **no** blank/white screen; the Console has **no red errors** mentioning `Chrome`, `KitchenAlert`, `getKitchenAlerts`, `Navbar`, `failedPrints`, or `OwlError/template`.
- **Report:** Pass/Fail per screen, a screenshot of the Floor screen, and **paste any red Console errors verbatim**.

### TC2 — Normal send, healthy printer (no false alarm)
*Precondition:* a kitchen printer is powered on and normally working.
1. On the test table, add **1 test product**.
2. Click the **Order** button (the one that sends to the kitchen).
- **Expected:** a green **"… sent to the kitchen"** toast; the ticket physically prints; **within ~30 s NO red banner** appears and **NO** warning bubble appears on the table; no Console error.
- **Report:** Pass/Fail; did a ticket physically print (ask the operator)?; screenshot; confirm no banner/bubble appeared.

### TC7 — Double‑send guard (no duplicate)
1. On the test table add 1 product. 2. **Click the Order button twice, fast** (double‑click).
- **Expected:** only **one** kitchen ticket prints; you may see a brief *"Still sending the previous ticket…"* notice; no error.
- **Report:** Pass/Fail; how many tickets printed (ask operator); screenshot.

### TC8 — Backend observability log
1. Leave the POS; go to the backend: **Point of Sale → Reporting → Kitchen Diagnostics** (the `pos.order.event` list).
2. Sort by **Event Date** descending.
- **Expected:** recent rows reflect your tests — e.g. `Kitchen Send Attempt`, `Kitchen Send Dispatched …`, `Kitchen Print OK` for TC2; `double_send_blocked` for TC7.
- **Report:** Pass/Fail; paste the latest ~8 event rows (Event / Severity / Message / Receipt Ref).

---

## 3. Real fix validation

### TC3 — Silent‑failure end‑to‑end (collaborative: operator flips a printer) ⭐ the actual bug
*This reproduces the production "order 25" case — a send that never prints and (before the fix) showed nothing.*
1. Ask the operator to **power OFF (or unplug) one kitchen printer** (e.g. "Barista").
2. On the test table, add **1 test product** that routes to **that** printer, and click **Order**.
3. **Wait up to ~30 seconds**, watching the screen and Console.
- **Expected:**
  - A **persistent red banner** appears at the top (on every screen) reading roughly **"Table N — <printer>: No response from printer — not confirmed"**, with **Open** and **Dismiss** buttons.
  - The table shows a small **warning bubble** on the Floor screen.
  - It does **not** disappear on its own.
4. Click **Open** on the banner → the **"Kitchen prints to resolve"** panel opens listing the entry (labelled *may have printed / not confirmed*).
5. Ask the operator to **power the printer back ON**, then click **Retry** in the panel.
- **Expected:** the ticket now prints, and the entry + banner **clear**.
- **Report:** Pass/Fail at each step; how long until the banner appeared (seconds); screenshots of the banner and panel; whether Retry printed and cleared the alert; any Console errors.

> If no printer can be flipped, skip TC3 and rely on TC4–TC6 (console simulation) to validate the alert UI.

---

## 4. Optional UI tests via console simulation (no hardware; only if store was FOUND)

> These add a **local** alert marker to the current order to verify the surfacing UI. They do **not** print. Run them on the **test table's** order.

### TC4 — Banner + bubble appear for an unconfirmed entry; Dismiss clears
1. Make sure the **test table's order is open** (Product screen).
2. Console:
```js
(() => {
  const pos = window.__pos, order = pos.getOrder();
  if (!order) return "NO_ORDER — open the test table first";
  const id = pos._recordPendingPrint(order, [{ new: [], cancelled: [], noteUpdate: [] }], false);
  pos._convertPendingToUnconfirmed(order, id);
  return "alert created; kitchenAlerts=" + pos.getKitchenAlerts().length;
})();
```
- **Expected:** the red **banner** appears (table + reason "No response from printer — not confirmed"); the Floor table shows the **bubble**.
3. Click **Dismiss** on the banner (or **Clear** in the panel).
- **Expected:** the banner and bubble disappear; `window.__pos.getKitchenAlerts().length` returns `0`.
- **Report:** Pass/Fail; screenshot of the banner; the two console return values.

### TC5 — Table panel Retry/Clear
1. With an alert present (from TC4), go to the **Floor**, **click the test table**.
- **Expected:** opening the table **auto‑opens** the "Kitchen prints to resolve" panel.
2. Click **Clear** on the entry.
- **Expected:** the entry is removed; banner clears.
- **Report:** Pass/Fail; screenshot of the auto‑opened panel.
- *(Skip Retry here unless a printer is on and a test ticket is acceptable — Retry sends a real print.)*

### TC6 — Startup sweep surfaces a marker orphaned by a refresh
1. Console (creates an **in‑flight pending** marker — should **not** alarm yet):
```js
(() => {
  const pos = window.__pos, order = pos.getOrder();
  if (!order) return "NO_ORDER";
  pos._recordPendingPrint(order, [{ new: [], cancelled: [], noteUpdate: [] }], false);
  return "pending created; visible alerts now=" + pos.getKitchenAlerts().length; // expect 0
})();
```
- **Expected:** return shows `…now=0` (a pending send does not alarm); **no** banner.
2. **Reload the POS tab** (F5) and let it fully load.
- **Expected:** after load, the **banner appears** for that order ("Not confirmed before reload — reprint if nothing printed") — the startup sweep surfaced the orphaned marker.
- **Report:** Pass/Fail; the console return value; screenshot after reload.
- *Note:* this depends on the order's state having been persisted locally before reload; if no banner appears after reload, note it as **Inconclusive** (not necessarily a failure) — the logic is also covered by automated tests.

---

## 5. Report format

Return a table plus evidence:

| Test | Result (Pass / Fail / Blocked / Inconclusive) | Evidence / notes |
|------|----------------------------------------------|------------------|
| TC1 POS loads | | screenshot + any console errors |
| TC2 Healthy send | | printed? banner absent? |
| TC3 Silent‑failure E2E | | seconds to banner; screenshots; retry cleared? |
| TC4 Banner/bubble/Dismiss | | console return values + screenshot |
| TC5 Panel Retry/Clear | | auto‑opened? |
| TC6 Startup sweep | | console return + post‑reload screenshot |
| TC7 Double‑send guard | | # tickets printed |
| TC8 Backend log | | latest event rows |

Also report: **(a)** any red Console errors (verbatim), **(b)** overall verdict — *is the POS healthy and are failed/unconfirmed kitchen prints clearly surfaced?*, **(c)** anything confusing in the wording/UX.

---

## 6. Cleanup (do every item)

1. **Dismiss/Clear all test alerts** (banner **Dismiss**, or panel **Clear all**). Confirm `window.__pos?.getKitchenAlerts().length === 0`.
2. **Cancel/delete every test order** you created (Orders screen → select the test order → delete/cancel; never *pay* it).
3. Ask the operator to **power any flipped printer back ON**.
4. Close DevTools. Leave the POS on the Floor screen as you found it.
