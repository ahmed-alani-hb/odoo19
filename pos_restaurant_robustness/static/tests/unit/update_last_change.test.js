import { describe, test, expect } from "@odoo/hoot";
import { setupPosEnv, getFilledOrder } from "@point_of_sale/../tests/unit/utils";
import { definePosModels } from "@point_of_sale/../tests/unit/data/generate_model_definitions";

definePosModels();

describe("pos_restaurant_robustness: smart sent-state (Fix A)", () => {
    test("a DEFINITE failure (printer unreachable) leaves items pending — order is not lost, will reprint", async () => {
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
        // Items stay pending so the next send / retry prints them (no lost order),
        // and since nothing printed there is no duplicate risk.
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
        expect(Object.keys(order.last_order_preparation_change.lines || {}).length).toBeGreaterThan(
            0
        );
        expect(syncCalls).toBeGreaterThan(0);
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
