# Staging validation — Fix C (concurrent two-device kitchen duplicate)

Fix C makes the server **merge** two devices' "already sent to the kitchen" states
instead of discarding the older one — so two people sending to the **same table**
at the same moment no longer produce a duplicate kitchen ticket. Validate this on
an **Odoo.sh staging** build before merging PR #3 to production.

## Prerequisites
- Odoo.sh **staging** branch built from the PR (`claude/pos-robustness-update`).
- Kitchen printer working through the IoT (so tickets actually print).
- **Two devices** that can open the POS — ideally the **same pair that showed the
  bug** (the Windows PC + an Android tablet).
- **Kitchen Diagnostics** menu visible: *Point of Sale → Reporting → Kitchen
  Diagnostics*.

## 0. Quick check — is the fix actually deployed? (Odoo.sh Shell, ~1 min)
In the staging branch's **Shell**, run:
```python
env['pos.order']._merge_preparation_changes(
    '{"lines": {"X": {"quantity": 2}}, "metadata": {"serverDate": "2026-01-01 10:00:05"}}',
    '{"lines": {"Y": {"quantity": 3}}, "metadata": {"serverDate": "2026-01-01 10:00:00"}}')
```
- ✅ Expected: a JSON string containing **both** `"X"` and `"Y"`.
- ❌ `AttributeError` (method missing) → the PR isn't on this branch; fix deployment first.

This proves the merge code is live and correct. Now test the real flow.

## A. The two-device duplicate (main test) — repeat 5–10×
The collision is timing-based, so do it several times.

1. On **Device 1** and **Device 2**, open the **same table** (e.g. Table 5).
2. **Device 1:** add item **A** (e.g. 1 Tea). **Device 2:** add a *different* item
   **B** (e.g. 1 Coffee). **Do not send yet.**
3. Count "3 – 2 – 1 – Send": both press **Order/Send** at the **same instant**.
4. Record:
   - **Kitchen printer:** how many tickets and what's on them.
   - **Each device's order screen:** items **green/sent**? Any order **stuck grey**?
   - On any stuck device, **refresh the page** → does it **re-send / re-print**?

**PASS (fix works):**
- No item printed more than once.
- After the concurrent send (and after a refresh) neither device re-sends.
- A **`prep_change_merged`** event shows in Kitchen Diagnostics around that time.

**FAIL:**
- The same item prints **twice**, or
- A device **re-sends** the same items after refresh, or
- An item is **missing** from the kitchen (lost ticket).

> Tip: make the PC one of the two senders — its slower double-duty sync widens the
> collision window. If after ~10 tries you can't trigger a collision at all with
> fast direct printing, that's a good sign (the firewall fix shrank the window),
> and step 0 already proved the merge works when a collision does happen.

## B. Regression check (single device — normal flows still correct)
Fix C changes how kitchen state is resolved, so confirm normal operation is intact:
1. Add items → Send → **one** ticket prints; items show sent.
2. Add **more** items → Send → only the **new** items print.
3. **Void** an already-sent item → a **cancellation** ticket prints.
4. **Reprint** from the order → same ticket, no new items.
5. Pay / close the order → normal.

Anything different here is a regression — report it (don't merge).

## C. Different tables (scope check, optional)
Repeat A with the two devices on **different tables**. Fix C does **not** target
this case. A stuck order / duplicate here is the **worker/load** issue, not a Fix C
failure → raise the Odoo.sh **worker count** and/or stop the PC doing double-duty
as register + IoT host. Note it separately.

## Decision — merge PR #3 to production when:
- step 0 returns both lines, **and**
- **A** shows no duplicates (with `prep_change_merged` on collisions), **and**
- **B** shows no regression.
