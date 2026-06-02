import { describe, test, expect } from "@odoo/hoot";
import { setupPosEnv, getFilledOrder } from "@point_of_sale/../tests/unit/utils";
import { definePosModels } from "@point_of_sale/../tests/unit/data/generate_model_definitions";

definePosModels();

describe("pos_restaurant_robustness: durable sent-state (Fix A)", () => {
    test("EVERY send marks items sent and persists — even a failed/timed-out print (no duplicate)", async () => {
        const store = await setupPosEnv();
        const order = await getFilledOrder(store);

        // Sanity: the mock printer routes some categories, so we exercise the real
        // printer path (printerCategories non-empty).
        expect(store.config.printerCategories.size).toBeGreaterThan(0);

        let syncCalls = 0;
        store.syncAllOrders = async () => {
            syncCalls++;
        };
        store.notification = { add() {} };

        const sentLineCount = () =>
            Object.keys(order.last_order_preparation_change.lines || {}).length;

        // A total print failure (e.g. a false IoT timeout). The items must STILL be
        // marked sent and the state persisted, so a refresh / second device cannot
        // re-send and duplicate the ticket.
        store.printChanges = async () => ({
            anyPrinted: false,
            allPrinted: false,
            retryPrinters: new Set(),
            failedNames: ["Barista"],
        });
        await store.sendOrderInPreparation(order);
        expect(sentLineCount()).toBeGreaterThan(0);
        expect(syncCalls).toBeGreaterThan(0);
    });

    test("a successful print also marks items sent and persists", async () => {
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
        });
        await store.sendOrderInPreparation(order);
        expect(Object.keys(order.last_order_preparation_change.lines || {}).length).toBeGreaterThan(
            0
        );
        expect(syncCalls).toBeGreaterThan(0);
    });

    test("a second send with no new items does not re-diff (reprint path), so no duplicate", async () => {
        const store = await setupPosEnv();
        const order = await getFilledOrder(store);
        store.syncAllOrders = async () => {};
        store.notification = { add() {} };

        let printCalls = 0;
        let lastReprint;
        store.printChanges = async (o, orderChange, reprint = false) => {
            printCalls++;
            lastReprint = reprint;
            return { anyPrinted: true, allPrinted: true, retryPrinters: new Set(), failedNames: [] };
        };

        await store.sendOrderInPreparation(order); // first send: real diff
        expect(printCalls).toBe(1);
        expect(lastReprint).toBe(false);

        // Items are now marked sent; a second send finds no new changes and goes
        // through the reprint branch instead of producing a new kitchen diff.
        await store.sendOrderInPreparation(order);
        expect(printCalls).toBe(2);
        expect(lastReprint).toBe(true);
    });
});
