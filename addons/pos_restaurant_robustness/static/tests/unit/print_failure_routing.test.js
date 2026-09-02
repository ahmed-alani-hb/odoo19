import { describe, test, expect } from "@odoo/hoot";
import { setupPosEnv, getFilledOrder } from "@point_of_sale/../tests/unit/utils";
import { definePosModels } from "@point_of_sale/../tests/unit/data/generate_model_definitions";

definePosModels();

// Drive printChanges with a controlled per-printer print result and record which UI
// surface it raises (blocking dialog vs non-blocking notification).
async function envWithPrintResult(result) {
    const store = await setupPosEnv();
    const order = await getFilledOrder(store);
    store.generateOrderChange = () => ({ orderData: {}, changes: {} });
    store.generateReceiptsDataToPrint = async () => [{}];
    store.printOrderChanges = async () => result;
    const calls = { dialog: 0, notif: 0 };
    store.dialog = { add: () => calls.dialog++ };
    store.notification = { add: () => calls.notif++ };
    return { store, order, calls };
}

const printer = (name) => ({ config: { name, product_categories_ids: [] } });

describe("pos_restaurant_robustness: print-failure routing", () => {
    test("ambiguous timeout -> recorded as 'may have printed', nothing safe to auto-retry, no blocking popup", async () => {
        const { store, order, calls } = await envWithPrintResult({
            successful: false,
            message: { body: "Timeout waiting for IoT Box response, please try again." },
        });
        const p = printer("Barista");
        const res = await store.printChanges(order, [{}], false, [p]);

        expect(calls.dialog).toBe(0); // no blocking popup
        expect(calls.notif).toBe(1); // brief toast
        const failed = store.getFailedPrints(order);
        expect(failed.length).toBe(1); // surfaced on the table panel instead
        expect(failed[0].printers[0].definite).toBe(false); // "may have printed"
        expect(res.retryPrinters.size).toBe(0); // a blind retry would duplicate
        expect(res.definiteTotalFailure).toBe(false);
    });

    test("definite no-print -> recorded as 'didn't print' + toast (no blocking popup)", async () => {
        const { store, order, calls } = await envWithPrintResult({
            successful: false,
            errorCode: "PRINTER_NOT_REACHABLE",
            message: { body: "The printer is not reachable." },
        });
        const p = printer("Kitchen");
        const res = await store.printChanges(order, [{}], false, [p]);

        expect(calls.dialog).toBe(0); // popup replaced by the table panel
        expect(calls.notif).toBe(1);
        const failed = store.getFailedPrints(order);
        expect(failed.length).toBe(1);
        expect(failed[0].printers[0].name).toBe("Kitchen");
        expect(failed[0].printers[0].definite).toBe(true); // safe to retry
        expect(res.retryPrinters.has(p)).toBe(true);
        expect(res.definiteTotalFailure).toBe(true);
    });

    test("successful print -> nothing recorded, no popup, no notice", async () => {
        const { store, order, calls } = await envWithPrintResult({ successful: true });
        const res = await store.printChanges(order, [{}], false, [printer("Bar")]);

        expect(calls.dialog).toBe(0);
        expect(calls.notif).toBe(0);
        expect(store.getFailedPrints(order).length).toBe(0);
        expect(res.allPrinted).toBe(true);
        expect(res.anyPrinted).toBe(true);
    });
});
