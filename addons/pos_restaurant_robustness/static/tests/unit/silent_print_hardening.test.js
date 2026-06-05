import { describe, test, expect } from "@odoo/hoot";
import { advanceTime } from "@odoo/hoot-mock";
import { setupPosEnv, getFilledOrder } from "@point_of_sale/../tests/unit/utils";
import { definePosModels } from "@point_of_sale/../tests/unit/data/generate_model_definitions";

definePosModels();

const change = () => [{ new: [], cancelled: [], noteUpdate: [] }];

describe("pos_restaurant_robustness: silent-print hardening (optimistic send)", () => {
    test("dispatch records a PENDING marker that is not yet surfaced (no false alarm)", async () => {
        const store = await setupPosEnv();
        const order = await getFilledOrder(store);
        const id = store._recordPendingPrint(order, change(), false);
        expect(typeof id).toBe("string");
        expect(store.getFailedPrints(order).length).toBe(1); // marker persisted (uiState)
        expect(store.getActiveFailedPrints(order).length).toBe(0); // in-flight -> not surfaced
        expect(store.getKitchenAlerts().length).toBe(0); // no banner while pending
    });

    test("a confirmed print clears the pending marker", async () => {
        const store = await setupPosEnv();
        const order = await getFilledOrder(store);
        store.printConfirmTimeoutMs = 10000;
        store.printChanges = async () => ({
            anyPrinted: true,
            allPrinted: true,
            definiteTotalFailure: false,
            definiteFailures: [],
            ambiguousFailures: [],
        });
        const id = store._recordPendingPrint(order, change(), false);
        await store._robustnessPrintAndReconcile(order, change(), {}, id);
        expect(store.getFailedPrints(order).length).toBe(0); // cleared on success
    });

    test("a never-confirmed print is surfaced as UNCONFIRMED within the timeout (order-25 case)", async () => {
        const store = await setupPosEnv();
        const order = await getFilledOrder(store);
        store.printConfirmTimeoutMs = 50;
        store.printChanges = () => new Promise(() => {}); // never settles (hung IoT)
        const id = store._recordPendingPrint(order, change(), false);
        const done = store._robustnessPrintAndReconcile(order, change(), {}, id);
        await advanceTime(60); // fire the confirmation timeout
        await done;
        const active = store.getActiveFailedPrints(order);
        expect(active.length).toBe(1);
        expect(active[0].unconfirmed).toBe(true);
        expect(store.getKitchenAlerts().length).toBe(1); // now it alarms
    });

    test("a failed print converts the pending marker into a surfaced failure", async () => {
        const store = await setupPosEnv();
        const order = await getFilledOrder(store);
        store.printConfirmTimeoutMs = 10000;
        store._robustnessPushSentState = () => {}; // isolate from server sync
        const printer = { config: { id: 9, name: "Barista" } };
        store.printChanges = async () => ({
            anyPrinted: false,
            allPrinted: false,
            definiteTotalFailure: true,
            definiteFailures: [{ printer, name: "Barista" }],
            ambiguousFailures: [],
        });
        const id = store._recordPendingPrint(order, change(), false);
        await store._robustnessPrintAndReconcile(order, change(), { lines: [] }, id);
        const active = store.getActiveFailedPrints(order);
        expect(active.length).toBe(1);
        expect(active[0].pending).toBe(false);
        expect(active[0].printers[0].name).toBe("Barista");
    });

    test("startup sweep surfaces pending markers orphaned by a dead session (refresh/crash)", async () => {
        const store = await setupPosEnv();
        const order = await getFilledOrder(store);
        store._recordPendingPrint(order, change(), false);
        expect(store.getActiveFailedPrints(order).length).toBe(0); // pending pre-sweep
        store._sweepOrphanPendingPrints();
        const active = store.getActiveFailedPrints(order);
        expect(active.length).toBe(1);
        expect(active[0].unconfirmed).toBe(true);
        expect(store.getKitchenAlerts().length).toBe(1);
    });
});
