import DevicesSynchronisation from "@point_of_sale/app/utils/devices_synchronisation";
import { patch } from "@web/core/utils/patch";

/**
 * Observability-only override. The pos_restaurant override of
 * `processDynamicRecords` consolidates several open orders that share a table
 * into one and deletes the rest (the mechanism behind "orders disappear when two
 * employees open the same table"). We do not change that behaviour here; we
 * snapshot the per-table open orders before/after it runs and log when orders
 * were removed, so the frequency and impact become measurable.
 */
patch(DevicesSynchronisation.prototype, {
    async processDynamicRecords(dynamicRecords) {
        const before = this._robustnessSnapshotTableOrders();
        const result = await super.processDynamicRecords(...arguments);
        try {
            this._robustnessDetectConsolidation(before);
        } catch {
            // never break a sync because of logging
        }
        return result;
    },

    _robustnessSnapshotTableOrders() {
        try {
            return this.models["pos.order"].reduce((acc, order) => {
                if (!order.finalized && order.table_id?.id) {
                    (acc[order.table_id.id] = acc[order.table_id.id] || []).push(order.uuid);
                }
                return acc;
            }, {});
        } catch {
            return {};
        }
    },

    _robustnessDetectConsolidation(before) {
        const after = this._robustnessSnapshotTableOrders();
        for (const [tableId, beforeUuids] of Object.entries(before)) {
            const afterUuids = after[tableId] || [];
            const removed = beforeUuids.filter((u) => !afterUuids.includes(u));
            // Signature of a consolidation: the table had more than one open order
            // and at least one of them is gone after the sync.
            if (beforeUuids.length > 1 && removed.length) {
                this.pos.logRobustnessEvent?.("order_consolidated", null, {
                    severity: "warning",
                    table_id: Number(tableId),
                    message: `Consolidated ${beforeUuids.length} open orders on the table into ${afterUuids.length}; ${removed.length} order(s) removed locally.`,
                    payload: JSON.stringify({
                        before: beforeUuids,
                        after: afterUuids,
                        removed,
                    }),
                });
            }
        }
    },
});
