import { describe, test, expect } from "@odoo/hoot";
import { setupPosEnv, getFilledOrder } from "@point_of_sale/../tests/unit/utils";
import { definePosModels } from "@point_of_sale/../tests/unit/data/generate_model_definitions";

definePosModels();

// Drive printChanges with a controlled per-printer print result and record which UI
// surface it raises (blocking Retry popup vs non-blocking notification).
async function envWithPrintResult(result) {
    const store = await setupPosEnv();
    const order = await getFilledOrder(store);
    store.generateOrderChange = () => ({ orderData: {}, changes: {} });
    store.generateReceiptsDataToPrint = async () => [{}];
    store.printOrderChanges = async () => result;
    const calls = { dialog: 0, notif: 0, dialogProps: null };
    store.dialog = {
        add: (comp, props) => {
            calls.dialog++;
            calls.dialogProps = props;
        },
    };
    store.notification = {
        add: () => {
            calls.notif++;
        },
    };
    return { store, order, calls };
}

const printer = (name) => ({ config: { name, product_categories_ids: [] } });

describe("pos_restaurant_robustness: print-failure routing", () => {
    test("ambiguous timeout -> non-blocking notice, NO Retry popup, nothing to retry", async () => {
        const { store, order, calls } = await envWithPrintResult({
            successful: false,
            message: { body: "Timeout waiting for IoT Box response, please try again." },
        });
        const p = printer("Barista");
        const res = await store.printChanges(order, [{}], false, [p]);

        expect(calls.notif).toBe(1); // staff informed via a toast
        expect(calls.dialog).toBe(0); // no scary blocking popup
        expect(res.retryPrinters.size).toBe(0); // a retry would duplicate -> not offered
        expect(res.definiteTotalFailure).toBe(false);
        expect(res.anyPrinted).toBe(false);
    });

    test("definite no-print -> Retry popup; Retry targets only that printer", async () => {
        const { store, order, calls } = await envWithPrintResult({
            successful: false,
            errorCode: "PRINTER_NOT_REACHABLE",
            message: { body: "The printer is not reachable." },
        });
        const p = printer("Kitchen");
        const res = await store.printChanges(order, [{}], false, [p]);

        expect(calls.dialog).toBe(1); // the real safety net is kept
        expect(calls.notif).toBe(0);
        expect(calls.dialogProps.canRetry).toBe(true);
        expect(res.retryPrinters.has(p)).toBe(true); // safe to retry (nothing printed)
        expect(res.retryPrinters.size).toBe(1);
        expect(res.definiteTotalFailure).toBe(true);
    });

    test("successful print -> no popup, no notice", async () => {
        const { store, order, calls } = await envWithPrintResult({ successful: true });
        const res = await store.printChanges(order, [{}], false, [printer("Bar")]);

        expect(calls.dialog).toBe(0);
        expect(calls.notif).toBe(0);
        expect(res.allPrinted).toBe(true);
        expect(res.anyPrinted).toBe(true);
    });
});
