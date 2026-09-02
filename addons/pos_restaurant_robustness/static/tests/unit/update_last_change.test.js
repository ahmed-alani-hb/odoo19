import { describe, test, expect } from "@odoo/hoot";
import { setupPosEnv, getFilledOrder } from "@point_of_sale/../tests/unit/utils";
import { definePosModels } from "@point_of_sale/../tests/unit/data/generate_model_definitions";

definePosModels();

// Flush microtasks until `pred` holds. The kitchen ticket now prints in the
// BACKGROUND, so the sent-state reconciliation (and the in-flight guard release)
// settle a few microtasks after `sendOrderInPreparation` returns.
const settle = async (pred = () => true, max = 200) => {
    for (let i = 0; i < max && !pred(); i++) {
        await Promise.resolve();
    }
};

describe("pos_restaurant_robustness: smart sent-state (Fix A)", () => {
    test("a DEFINITE failure (printer unreachable) is rolled back — items end pending, order not lost", async () => {
        const store = await setupPosEnv();
        const order = await getFilledOrder(store);

        // Sanity: the mock printer routes some categories, so we exercise the real
        // printer path (printerCategories non-empty).
        expect(store.config.printerCategories.size).toBeGreaterThan(0);

        store.syncAllOrders = async () => {};
        store.notification = { add() {} };
        const sentLineCount = () =>
            Object.keys(order.last_order_preparation_change.lines || {}).length;

        store.printChanges = async () => ({
            anyPrinted: false,
            allPrinted: false,
            retryPrinters: new Set(),
            failedNames: ["Barista"],
            definiteTotalFailure: true, // printer certainly didn't print
        });
        await store.sendOrderInPreparation(order);
        // The send marks the order sent optimistically, then the background print
        // fails definitively and ROLLS THE SENT-STATE BACK: the items end up pending
        // so the next send / retry prints them (no lost order), and since nothing
        // printed there is no duplicate risk.
        await settle(() => !store.sendingInPreparation.has(order.uuid));
        expect(sentLineCount()).toBe(0);
    });

    test("an AMBIGUOUS failure (timeout) marks items sent and persists — no duplicate on refresh/2nd device", async () => {
        const store = await setupPosEnv();
        const order = await getFilledOrder(store);
        let syncCalls = 0;
        store.syncAllOrders = async () => {
            syncCalls++;
        };
        store.notification = { add() {} };

        store.printChanges = async () => ({
            anyPrinted: false,
            allPrinted: false,
            retryPrinters: new Set(),
            failedNames: ["Barista"],
            definiteTotalFailure: false, // e.g. an IoT timeout — it probably DID print
        });
        await store.sendOrderInPreparation(order);
        // Marked sent + pushed synchronously (before the print ack)...
        expect(Object.keys(order.last_order_preparation_change.lines || {}).length).toBeGreaterThan(
            0
        );
        expect(syncCalls).toBeGreaterThan(0);
        // ...and an ambiguous failure is KEPT sent (not rolled back) to avoid a duplicate.
        await settle(() => !store.sendingInPreparation.has(order.uuid));
        expect(Object.keys(order.last_order_preparation_change.lines || {}).length).toBeGreaterThan(
            0
        );
    });

    test("a successful print marks items sent and persists", async () => {
        const store = await setupPosEnv();
        const order = await getFilledOrder(store);
        let syncCalls = 0;
        store.syncAllOrders = async () => {
            syncCalls++;
        };
        store.notification = { add() {} };

        store.printChanges = async () => ({
            anyPrinted: true,
            allPrinted: true,
            retryPrinters: new Set(),
            failedNames: [],
            definiteTotalFailure: false,
        });
        await store.sendOrderInPreparation(order);
        expect(Object.keys(order.last_order_preparation_change.lines || {}).length).toBeGreaterThan(
            0
        );
        expect(syncCalls).toBeGreaterThan(0);
        await settle(() => !store.sendingInPreparation.has(order.uuid));
    });

    test("a second send with no new items goes through the reprint path (no new diff, no duplicate)", async () => {
        const store = await setupPosEnv();
        const order = await getFilledOrder(store);
        store.syncAllOrders = async () => {};
        store.notification = { add() {} };

        let printCalls = 0;
        let lastReprint;
        store.printChanges = async (o, orderChange, reprint = false) => {
            printCalls++;
            lastReprint = reprint;
            return {
                anyPrinted: true,
                allPrinted: true,
                retryPrinters: new Set(),
                failedNames: [],
                definiteTotalFailure: false,
            };
        };

        await store.sendOrderInPreparation(order); // first send: real diff (printed in background)
        expect(printCalls).toBe(1);
        expect(lastReprint).toBe(false);
        // Let the background print finish and release the in-flight guard.
        await settle(() => !store.sendingInPreparation.has(order.uuid));

        // Items are now marked sent; a second send finds no new changes and goes
        // through the reprint branch instead of producing a new kitchen diff.
        await store.sendOrderInPreparation(order);
        expect(printCalls).toBe(2);
        expect(lastReprint).toBe(true);
    });
});
