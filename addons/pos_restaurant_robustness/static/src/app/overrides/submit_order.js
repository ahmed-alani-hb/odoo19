/** @odoo-module */
import { PosStore } from "@point_of_sale/app/services/pos_store";
import { patch } from "@web/core/utils/patch";

/**
 * Make "close the table after sending the order" configurable.
 *
 * Core `submitOrder` (pos_restaurant) always calls `showDefault()` at the end,
 * which returns to the floor screen (closes the table). We reimplement the small
 * method so that the close only happens when the new `close_table_after_order`
 * config option is on (the default — current behaviour). When it is off, the
 * order is still sent but the table stays open for adding more items.
 *
 * This module loads after pos_restaurant, so this patch takes precedence; the
 * body mirrors pos_restaurant.submitOrder plus the conditional close.
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
