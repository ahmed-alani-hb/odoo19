import { describe, test, expect } from "@odoo/hoot";
import { setupPosEnv, getFilledOrder } from "@point_of_sale/../tests/unit/utils";
import { definePosModels } from "@point_of_sale/../tests/unit/data/generate_model_definitions";

definePosModels();

describe("pos_restaurant_robustness: mark-sent gating (Fix A)", () => {
    test("a failed kitchen print does NOT mark items as sent; a successful one does", async () => {
        const store = await setupPosEnv();
        const order = await getFilledOrder(store);

        // Sanity: the mock printer routes some categories, so we exercise the
        // real printer path (printerCategories non-empty).
        expect(store.config.printerCategories.size).toBeGreaterThan(0);

        // Keep the test hermetic: no real sync / notifications.
        store.syncAllOrders = async () => {};
        store.notification = { add() {} };

        const sentLineCount = () =>
            Object.keys(order.last_order_preparation_change.lines || {}).length;

        // 1) Total print failure -> items must remain pending (not marked sent).
        store.printChanges = async () => ({
            anyPrinted: false,
            allPrinted: false,
            retryPrinters: new Set(),
            failedNames: ["Bar Printer"],
        });
        await store.sendOrderInPreparation(order);
        expect(sentLineCount()).toBe(0);

        // 2) Full success -> items are now marked as sent.
        store.printChanges = async () => ({
            anyPrinted: true,
            allPrinted: true,
            retryPrinters: new Set(),
            failedNames: [],
        });
        await store.sendOrderInPreparation(order);
        expect(sentLineCount()).toBeGreaterThan(0);
    });

    test("a partial print (one printer fails) does NOT mark items as sent", async () => {
        const store = await setupPosEnv();
        const order = await getFilledOrder(store);
        store.syncAllOrders = async () => {};
        store.notification = { add() {} };

        store.printChanges = async () => ({
            anyPrinted: true, // one printer succeeded
            allPrinted: false, // ...but another failed
            retryPrinters: new Set(),
            failedNames: ["Kitchen Printer"],
        });
        await store.sendOrderInPreparation(order);
        expect(Object.keys(order.last_order_preparation_change.lines || {}).length).toBe(0);
    });
});
