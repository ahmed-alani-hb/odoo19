import { describe, test, expect } from "@odoo/hoot";
import { Deferred } from "@odoo/hoot-mock";
import { setupPosEnv, getFilledOrder } from "@point_of_sale/../tests/unit/utils";
import { definePosModels } from "@point_of_sale/../tests/unit/data/generate_model_definitions";

definePosModels();

describe("pos_restaurant_robustness: optimistic submitOrder", () => {
    test("closes the table / frees the button WITHOUT awaiting the IoT print ack", async () => {
        const store = await setupPosEnv();
        const order = await getFilledOrder(store);
        store.ensureGuestCustomerCount = async () => {};
        store.data.network.offline = false;

        let closed = false;
        store.showDefault = () => {
            closed = true;
        };

        // The send (which includes the IoT print ack) hangs to simulate a slow
        // IoT / Odoo.sh round-trip.
        const ack = new Deferred();
        let sendCalls = 0;
        let sendSettled = false;
        store.sendOrderInPreparationUpdateLastChange = async () => {
            sendCalls++;
            await ack;
            sendSettled = true;
        };

        // submitOrder must resolve even though the send is still in-flight.
        await store.submitOrder();

        expect(sendCalls).toBe(1); // the kitchen send was dispatched
        expect(closed).toBe(true); // table closed immediately
        expect(sendSettled).toBe(false); // ...without waiting for the print ack

        // The ack settles in the background afterwards.
        ack.resolve();
        await ack;
        await Promise.resolve();
        expect(sendSettled).toBe(true);
    });

    test("offline is a hard stop: throws and keeps the table open", async () => {
        const store = await setupPosEnv();
        await getFilledOrder(store);
        store.ensureGuestCustomerCount = async () => {};
        store.data.network.offline = true;

        let closed = false;
        store.showDefault = () => {
            closed = true;
        };
        let sendCalls = 0;
        store.sendOrderInPreparationUpdateLastChange = async () => {
            sendCalls++;
        };

        let threw = false;
        try {
            await store.submitOrder();
        } catch {
            threw = true;
        }

        expect(threw).toBe(true); // surfaced to the Send button as an error
        expect(sendCalls).toBe(0); // nothing dispatched
        expect(closed).toBe(false); // table stays open for a retry

        store.data.network.offline = false; // cleanup shared state
    });

    test("close_table_after_order = false keeps the table open but still sends", async () => {
        const store = await setupPosEnv();
        await getFilledOrder(store);
        store.ensureGuestCustomerCount = async () => {};
        store.data.network.offline = false;
        store.config.close_table_after_order = false;

        let closed = false;
        store.showDefault = () => {
            closed = true;
        };
        let sendCalls = 0;
        store.sendOrderInPreparationUpdateLastChange = async () => {
            sendCalls++;
        };

        await store.submitOrder();

        expect(sendCalls).toBe(1); // order still sent to preparation
        expect(closed).toBe(false); // but the table is not closed
    });
});
