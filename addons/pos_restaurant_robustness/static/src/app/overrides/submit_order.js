/** @odoo-module */
import { PosStore } from "@point_of_sale/app/services/pos_store";
import { patch } from "@web/core/utils/patch";
import { ConnectionLostError } from "@web/core/network/rpc";

/**
 * Optimistic Send: close the table and free the (useTrackedAsync) Send button as
 * soon as the order is dispatched to preparation, instead of holding the cashier
 * through the IoT printer round-trip.
 *
 * Core/pos_restaurant `submitOrder` AWAITS the whole kitchen send — including the
 * IoT print acknowledgement — before it returns to the floor and re-enables the
 * Send button. On a slow IoT / Odoo.sh round-trip that makes Send feel frozen.
 *
 * New flow:
 *   useTrackedAsync -> submitOrder -> dispatch sendOrderInPreparation
 *     -> button "done" + table closes  (immediately)
 *     -> [background] await IoT print ack -> mark sent -> backend sync
 *
 * The send still runs through our hardened `sendOrderInPreparation`, so the
 * duplicate / lost-ticket guarantees are unchanged: the local sent-state is set
 * from the real print result, the per-order in-flight guard coalesces rapid
 * double-sends, and a failed printer raises the Retry/Reprint popup (which now
 * appears over the floor screen). The backend sync is already backgrounded
 * inside sendOrderInPreparation and runs right after the print ack.
 *
 * Offline is the one hard stop: if the server is unreachable we must NOT close
 * the table (mirrors core, which throws ConnectionLostError before sending), so
 * the Send button surfaces the error and the cashier can retry rather than
 * silently moving on from an order that never left.
 *
 * The optional `close_table_after_order` config still controls the close.
 *
 * This module loads after pos_restaurant, so this patch takes precedence.
 */
patch(PosStore.prototype, {
    async submitOrder() {
        const order = this.getOrder();
        await this.ensureGuestCustomerCount(order);

        // Hard stop before we free the cashier: a known-offline server means the
        // order can't be synced, so don't close the table (core throws here too).
        if (this.data.network.offline) {
            this.data.network.warningTriggered = false;
            throw new ConnectionLostError();
        }

        // Dispatch the kitchen send WITHOUT awaiting the IoT print ack: the print
        // acknowledgement and the (already backgrounded) backend sync settle in the
        // background inside sendOrderInPreparation, which also raises the Retry
        // popup if a printer fails. Guard the background promise so it can never
        // raise an unhandled rejection after the table has closed.
        Promise.resolve(this.sendOrderInPreparationUpdateLastChange(order)).catch((e) => {
            this.logRobustnessEvent?.("submit_send_deferred_error", order, {
                severity: "warning",
                message:
                    "Send-to-kitchen failed after the table closed (handled in background): " +
                    (e?.message || String(e)),
            });
        });

        this.addPendingOrder([order.id]);
        if (this.config.close_table_after_order !== false) {
            this.showDefault();
        }
    },
});
