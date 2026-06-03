import { describe, test, expect } from "@odoo/hoot";
import { Deferred } from "@odoo/hoot-mock";
import { setupPosEnv, getFilledOrder } from "@point_of_sale/../tests/unit/utils";
import { definePosModels } from "@point_of_sale/../tests/unit/data/generate_model_definitions";

definePosModels();

// The kitchen ticket prints in the BACKGROUND. Flush microtasks until `pred` holds.
const settle = async (pred = () => true, max = 200) => {
    for (let i = 0; i < max && !pred(); i++) {
        await Promise.resolve();
    }
};

describe("pos_restaurant_robustness: optimistic, multi-device-safe send", () => {
    test("marks the order sent + pushes BEFORE the kitchen print runs (other devices see it immediately)", async () => {
        const store = await setupPosEnv();
        const order = await getFilledOrder(store);
        expect(store.config.printerCategories.size).toBeGreaterThan(0);
        store.notification = { add() {} };

        let syncCalls = 0;
        store.syncAllOrders = async () => {
            syncCalls++;
        };

        // Capture whether the order was already flagged "sent" at the moment the
        // (slow, hanging) print starts — this is what a second device reads.
        let sentAtPrintTime = -1;
        const ack = new Deferred();
        store.printChanges = async (o) => {
            sentAtPrintTime = Object.keys(o.last_order_preparation_change.lines || {}).length;
            await ack;
            return {
                anyPrinted: true,
                allPrinted: true,
                retryPrinters: new Set(),
                failedNames: [],
                definiteTotalFailure: false,
            };
        };

        // Resolves WITHOUT waiting for the IoT print ack (snappy table close).
        await store.sendOrderInPreparation(order);

        expect(sentAtPrintTime).toBeGreaterThan(0); // sent-state set BEFORE printing began
        expect(syncCalls).toBeGreaterThan(0); // and pushed to the server for other devices
        expect(store.sendingInPreparation.has(order.uuid)).toBe(true); // print still running in bg

        ack.resolve();
        await settle(() => !store.sendingInPreparation.has(order.uuid));
        expect(store.sendingInPreparation.has(order.uuid)).toBe(false);
    });

    test("rolls the sent-state back if the background print is a DEFINITE failure", async () => {
        const store = await setupPosEnv();
        const order = await getFilledOrder(store);
        expect(store.config.printerCategories.size).toBeGreaterThan(0);
        store.notification = { add() {} };
        store.syncAllOrders = async () => {};

        store.printChanges = async () => ({
            anyPrinted: false,
            allPrinted: false,
            retryPrinters: new Set(),
            failedNames: ["Barista"],
            definiteTotalFailure: true,
        });

        await store.sendOrderInPreparation(order);
        // Optimistically marked sent, then the background print fails definitively
        // and the sent-state is rolled back (items will be re-sent — no lost ticket).
        await settle(() => !store.sendingInPreparation.has(order.uuid));
        expect(Object.keys(order.last_order_preparation_change.lines || {}).length).toBe(0);
        expect(order.lines.some((l) => l.uiState.hasChange)).toBe(true);
    });
});

describe("pos_restaurant_robustness: submitOrder close-table option", () => {
    test("closes the table after sending by default", async () => {
        const store = await setupPosEnv();
        await getFilledOrder(store);
        store.ensureGuestCustomerCount = async () => {};
        store.sendOrderInPreparationUpdateLastChange = async () => {};
        let closed = false;
        store.showDefault = () => {
            closed = true;
        };
        await store.submitOrder();
        expect(closed).toBe(true);
    });

    test("keeps the table open when close_table_after_order is off", async () => {
        const store = await setupPosEnv();
        await getFilledOrder(store);
        store.ensureGuestCustomerCount = async () => {};
        store.sendOrderInPreparationUpdateLastChange = async () => {};
        store.config.close_table_after_order = false;
        let closed = false;
        store.showDefault = () => {
            closed = true;
        };
        await store.submitOrder();
        expect(closed).toBe(false);
    });
});
