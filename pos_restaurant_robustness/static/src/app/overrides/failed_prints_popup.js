/** @odoo-module */
import { Component, useState } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";
import { _t } from "@web/core/l10n/translation";
import { usePos } from "@point_of_sale/app/hooks/pos_hook";

/**
 * "Kitchen prints to resolve" panel, shown when a table with failed kitchen prints
 * is opened (and reachable from the on-table bubble). Lets the waiter:
 *  - Retry: reprints ONLY the printers that failed (never the ones that already
 *    printed) — so it cannot duplicate what already came out.
 *  - Clear: dismiss the entry (the ticket did come out, or it isn't needed).
 * Each entry is labelled by what happened so the waiter never duplicates blindly.
 */
export class FailedPrintsPopup extends Component {
    static template = "pos_restaurant_robustness.FailedPrintsPopup";
    static components = { Dialog };
    static props = {
        order: Object,
        close: Function,
    };

    setup() {
        this.pos = usePos();
        this.state = useState({ busy: false });
    }

    get entries() {
        // Only SURFACED entries — in-flight "pending" markers (a send still printing)
        // are not shown here.
        return this.pos.getActiveFailedPrints(this.props.order);
    }

    entryNames(entry) {
        return (entry.printers || []).map((p) => p.name).filter(Boolean).join(_t(", "));
    }

    entryReason(entry) {
        return entry.reason || "";
    }

    entryMayHavePrinted(entry) {
        // "ambiguous" (e.g. a timeout) printers may already have printed.
        return (entry.printers || []).some((p) => !p.definite);
    }

    async retry(entry) {
        if (this.state.busy) {
            return;
        }
        this.state.busy = true;
        try {
            await this.pos.retryFailedPrint(this.props.order, entry.id);
        } finally {
            this.state.busy = false;
        }
        if (!this.entries.length) {
            this.props.close();
        }
    }

    clear(entry) {
        this.pos.clearFailedPrint(this.props.order, entry.id);
        if (!this.entries.length) {
            this.props.close();
        }
    }

    async retryAll() {
        if (this.state.busy) {
            return;
        }
        this.state.busy = true;
        try {
            await this.pos.retryAllFailedPrints(this.props.order);
        } finally {
            this.state.busy = false;
        }
        if (!this.entries.length) {
            this.props.close();
        }
    }

    clearAll() {
        this.pos.clearAllFailedPrints(this.props.order);
        this.props.close();
    }
}
