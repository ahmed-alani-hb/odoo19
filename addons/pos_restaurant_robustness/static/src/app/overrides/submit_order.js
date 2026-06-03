/** @odoo-module */
import { PosStore } from "@point_of_sale/app/services/pos_store";
import { patch } from "@web/core/utils/patch";

/**
 * "Close table after sending" config + snappy, multi-device-correct Send.
 *
 * submitOrder AWAITS the send so the order is marked sent and pushed to the
 * server BEFORE the table closes. That ordering is what lets a second device
 * viewing the same table see the items as "sent" immediately, instead of "not
 * sent" until the printer round-trip finished — which risked a duplicate
 * re-send from the second device.
 *
 * The snappiness lives in sendOrderInPreparation (pos_store_printing.js): for a
 * normal send it marks the order sent + pushes synchronously and prints the
 * kitchen ticket in the BACKGROUND, so this await returns without waiting on the
 * IoT printer round-trip (and rolls the sent-state back if the print definitely
 * fails). Offline still throws inside the send, so the table stays open.
 *
 * When `close_table_after_order` is off, the order is still sent but the table
 * stays open for adding more items.
 *
 * This module loads after pos_restaurant, so this patch takes precedence.
 */
patch(PosStore.prototype, {
    async submitOrder() {
        const order = this.getOrder();
        await this.ensureGuestCustomerCount(order);
        await this.sendOrderInPreparationUpdateLastChange(order);
        this.addPendingOrder([order.id]);
        if (this.config.close_table_after_order !== false) {
            this.showDefault();
        }
    },
});
