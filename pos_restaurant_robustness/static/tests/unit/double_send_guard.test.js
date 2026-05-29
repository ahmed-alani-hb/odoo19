import { describe, test, expect } from "@odoo/hoot";
import { Deferred } from "@odoo/hoot-mock";
import { setupPosEnv, getFilledOrder } from "@point_of_sale/../tests/unit/utils";
import { definePosModels } from "@point_of_sale/../tests/unit/data/generate_model_definitions";

definePosModels();

describe("pos_restaurant_robustness: double-send guard (Fix B)", () => {
    test("a second concurrent send for the same order is coalesced", async () => {
        const store = await setupPosEnv();
        const order = await getFilledOrder(store);
        store.syncAllOrders = async () => {};
        store.notification = { add() {} };

        // Make the first send hang inside printChanges so it stays in-flight.
        const deferred = new Deferred();
        let printCalls = 0;
        store.printChanges = async () => {
            printCalls++;
            await deferred;
            return { anyPrinted: true, allPrinted: true, retryPrinters: new Set(), failedNames: [] };
        };

        const first = store.sendOrderInPreparation(order); // not awaited: stays in-flight
        expect(store.sendingInPreparation.has(order.uuid)).toBe(true);
        expect(printCalls).toBe(1);

        // Second call while the first is in-flight must be coalesced (no 2nd print).
        await store.sendOrderInPreparation(order);
        expect(printCalls).toBe(1);

        // Releasing the first send clears the guard.
        deferred.resolve();
        await first;
        expect(store.sendingInPreparation.has(order.uuid)).toBe(false);

        // A subsequent send is allowed again.
        store.printChanges = async () => ({
            anyPrinted: true,
            allPrinted: true,
            retryPrinters: new Set(),
            failedNames: [],
        });
        await store.sendOrderInPreparation(order);
        expect(printCalls).toBe(2);
    });
});
