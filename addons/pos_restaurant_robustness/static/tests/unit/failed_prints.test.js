import { describe, test, expect } from "@odoo/hoot";
import { setupPosEnv, getFilledOrder } from "@point_of_sale/../tests/unit/utils";
import { definePosModels } from "@point_of_sale/../tests/unit/data/generate_model_definitions";

definePosModels();

const fail = (printer, name) => ({ printer, name });
const printer = (id, name) => ({ config: { id, name } });

describe("pos_restaurant_robustness: failed-print tracker", () => {
    test("records a failed print with its printers + classification", async () => {
        const store = await setupPosEnv();
        const order = await getFilledOrder(store);
        store._recordFailedPrint(order, [{ new: [] }], false, [fail(printer(7, "Barista"), "Barista")], []);
        const list = store.getFailedPrints(order);
        expect(list.length).toBe(1);
        expect(list[0].printers[0].name).toBe("Barista");
        expect(list[0].printers[0].id).toBe(7);
        expect(list[0].printers[0].definite).toBe(true);
    });

    test("clear removes one entry; clearAll empties", async () => {
        const store = await setupPosEnv();
        const order = await getFilledOrder(store);
        store._recordFailedPrint(order, [{}], false, [fail(printer(1, "A"), "A")], []);
        store._recordFailedPrint(order, [{}], false, [fail(printer(2, "B"), "B")], []);
        const list = store.getFailedPrints(order);
        expect(list.length).toBe(2);
        store.clearFailedPrint(order, list[0].id);
        expect(store.getFailedPrints(order).length).toBe(1);
        store.clearAllFailedPrints(order);
        expect(store.getFailedPrints(order).length).toBe(0);
    });

    test("getFailedPrintCount sums a table's open orders", async () => {
        const store = await setupPosEnv();
        const tables = store.models["restaurant.table"]?.getAll?.() || [];
        if (!tables.length) {
            return; // environment without restaurant tables
        }
        const table = tables[0];
        const order = store.addNewOrder({ table_id: table });
        expect(store.getFailedPrintCount(table)).toBe(0);
        store._recordFailedPrint(order, [{}], false, [fail(printer(1, "A"), "A")], []);
        store._recordFailedPrint(order, [{}], false, [], [fail(printer(2, "B"), "B")]);
        expect(store.getFailedPrintCount(table)).toBe(2);
    });

    test("retry reprints ONLY the failed printer and clears the entry on success", async () => {
        const store = await setupPosEnv();
        const order = await getFilledOrder(store);
        store.syncAllOrders = async () => {};
        const a = printer(11, "A");
        const b = printer(22, "B");
        if (!store.unwatched) {
            store.unwatched = {};
        }
        store.unwatched.printers = [a, b];

        let printedTo = null;
        store.printChanges = async (o, change, reprint, printers) => {
            printedTo = printers.map((p) => p.config.id);
            return {
                anyPrinted: true,
                allPrinted: true,
                retryPrinters: new Set(),
                failedNames: [],
                definiteTotalFailure: false,
            };
        };
        store._recordFailedPrint(order, [{ new: [] }], false, [fail(b, "B")], []);
        const entry = store.getFailedPrints(order)[0];
        await store.retryFailedPrint(order, entry.id);

        expect(printedTo).toEqual([22]); // only the printer that failed
        expect(store.getFailedPrints(order).length).toBe(0); // cleared on success
    });

    test("retry that fails again leaves a single fresh entry (no duplicate pile-up)", async () => {
        const store = await setupPosEnv();
        const order = await getFilledOrder(store);
        store.syncAllOrders = async () => {};
        store.notification = { add() {} };
        const b = printer(22, "B");
        if (!store.unwatched) {
            store.unwatched = {};
        }
        store.unwatched.printers = [b];
        // Real printChanges path so a fresh entry is recorded on the repeated failure.
        store.generateOrderChange = () => ({ orderData: {}, changes: {} });
        store.generateReceiptsDataToPrint = async () => [{}];
        store.printOrderChanges = async () => ({
            successful: false,
            message: { body: "The printer is not reachable." },
        });

        store._recordFailedPrint(order, [{ new: [] }], false, [fail(b, "B")], []);
        const entry = store.getFailedPrints(order)[0];
        await store.retryFailedPrint(order, entry.id);

        const list = store.getFailedPrints(order);
        expect(list.length).toBe(1); // old removed, new recorded
        expect(list[0].id).not.toBe(entry.id);
    });
});
