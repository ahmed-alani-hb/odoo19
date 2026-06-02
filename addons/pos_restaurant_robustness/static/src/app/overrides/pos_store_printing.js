import { patch } from "@web/core/utils/patch";
import { PosStore, CONSOLE_COLOR } from "@point_of_sale/app/services/pos_store";
import { changesToOrder } from "@point_of_sale/app/models/utils/order_change";
import { RetryPrintPopup } from "@point_of_sale/app/components/popups/retry_print_popup/retry_print_popup";
import { logPosMessage } from "@point_of_sale/app/utils/pretty_console_log";
import { _t } from "@web/core/l10n/translation";

patch(PosStore.prototype, {
    async setup() {
        // Per-order in-flight guard for sends to the kitchen (Fix B). Keyed on the
        // order uuid; the core `syncingOrders` set is keyed inconsistently
        // (adds id, deletes uuid) and only guards `syncAllOrders`.
        this.sendingInPreparation = new Set();
        return await super.setup(...arguments);
    },

    get telemetry() {
        return this.env?.services?.pos_telemetry;
    },

    /** Enrich an event with order/session context and buffer it. Never throws. */
    logRobustnessEvent(event_type, order, extra = {}) {
        try {
            const telemetry = this.telemetry;
            if (!telemetry) {
                return;
            }
            telemetry.logEvent({
                event_type,
                order_uuid: order?.uuid || false,
                pos_reference: order?.pos_reference || false,
                // Only set the m2o when the order is already on the server.
                order_id: typeof order?.id === "number" ? order.id : false,
                table_id: order?.table_id?.id || false,
                config_id: this.config?.id || false,
                session_id: this.session?.id || false,
                device_identifier: this.device?.identifier ? String(this.device.identifier) : false,
                cashier: (this.getCashier?.() || this.cashier)?.name || false,
                ...extra,
            });
        } catch {
            // Telemetry can never break the POS.
        }
    },

    /**
     * @override
     * Reimplements the core method to fix duplicate kitchen tickets:
     *  - Fix A (durable sent-state): every send marks the items "sent"
     *    (`order.updateLastOrderChange()`) AND persists that to the server, even
     *    when the print did not confirm. A false IoT timeout (the slow Odoo.sh
     *    websocket fallback) reports "failed" although the ticket actually printed;
     *    leaving the items pending — as core does (it marks sent locally but skips
     *    the server sync when the print "failed"), and as our earlier version did
     *    even more aggressively — is exactly what makes a page refresh or a second
     *    device re-send and DUPLICATE the ticket. Genuine print failures stay
     *    recoverable through the Retry/Reprint popup raised in printChanges()
     *    (Reprint re-prints the same ticket without creating a new diff).
     *  - Fix B (double-send guard): concurrent/rapid sends for the same order are
     *    coalesced.
     * The printing/diff logic is identical to core. The restaurant "sent to the
     * kitchen" toast is replicated because we bypass the pos_restaurant override.
     */
    async sendOrderInPreparation(order, opts = {}) {
        // Fix B: coalesce concurrent/rapid sends for the same order.
        if (this.sendingInPreparation.has(order.uuid)) {
            this.logRobustnessEvent("double_send_blocked", order, {
                severity: "warning",
                message: "A send-to-kitchen for this order is already in progress; the duplicate call was ignored.",
            });
            return;
        }
        this.sendingInPreparation.add(order.uuid);
        try {
            let categoryCount = [];
            if (!opts.cancelled) {
                categoryCount = this.getCategoryCount?.(order) || [];
            }

            this.logRobustnessEvent("kitchen_send_attempt", order);

            let printResult = { anyPrinted: false, allPrinted: false };
            let printerPath = false;

            if (this.config.printerCategories.size && !opts.byPassPrint) {
                printerPath = true;
                try {
                    let reprint = false;
                    let orderChange = changesToOrder(
                        order,
                        this.config.printerCategories,
                        opts.cancelled
                    );

                    if (
                        !orderChange.new.length &&
                        !orderChange.cancelled.length &&
                        !orderChange.noteUpdate.length &&
                        !orderChange.internal_note &&
                        !orderChange.general_customer_note &&
                        order.uiState.lastPrints
                    ) {
                        orderChange = [order.uiState.lastPrints.at(-1)];
                        reprint = true;
                    } else {
                        order.uiState.lastPrints.push(orderChange);
                        orderChange = [orderChange];
                    }

                    if (reprint && opts.orderDone) {
                        return;
                    }
                    printResult = await this.printChanges(order, orderChange, reprint);
                } catch (e) {
                    logPosMessage(
                        "Store",
                        "sendOrderInPreparation",
                        "Failed in printing the changes in the order",
                        CONSOLE_COLOR,
                        [e]
                    );
                    this.logRobustnessEvent("kitchen_print_fail", order, {
                        severity: "error",
                        message: "Exception while printing: " + (e?.message || String(e)),
                    });
                    printResult = { anyPrinted: false, allPrinted: false };
                }
            }

            // Fix A — durable sent-state. ALWAYS mark the items "sent to the
            // kitchen" and persist that to the server, regardless of the print
            // result. A false IoT timeout returns "failed" although the ticket
            // actually printed; leaving items pending is what makes a refresh or a
            // second device re-send and duplicate the ticket. Genuine failures stay
            // recoverable via the Retry/Reprint popup raised in printChanges().
            order.updateLastOrderChange();
            if (!this.models["pos.prep.display"]?.length) {
                try {
                    await this.syncAllOrders({ orders: [order] });
                } catch (e) {
                    // Offline / transient sync error: the sent-state is kept locally
                    // (IndexedDB) and syncs later. Never break the send over this.
                    this.logRobustnessEvent("sent_state_sync_deferred", order, {
                        severity: "warning",
                        message:
                            "Sent-to-kitchen state kept locally; server sync deferred. " +
                            (e?.message || String(e)),
                    });
                }
            }
            if (printerPath && !printResult.allPrinted) {
                this.logRobustnessEvent("mark_sent_forced", order, {
                    severity: "warning",
                    message: printResult.anyPrinted
                        ? "Partial kitchen print: items marked sent; reprint the failed printer(s) from the popup."
                        : "Kitchen print did not confirm (likely a slow-fallback timeout): items marked sent to prevent a duplicate. Verify the ticket and use Reprint if it did not print.",
                });
            }

            // Restaurant "sent to the kitchen" toast (replicated from the
            // pos_restaurant override; we bypass it). Shown on every send, mirroring
            // core which marks the order sent on every send.
            if (this.config.module_pos_restaurant && categoryCount.length) {
                const categorySummary = categoryCount
                    .map((cat) => `${cat.count} ${cat.name}`)
                    .join(_t(", "))
                    .replace(/, ([^,]*)$/, _t(" and $1"));
                this.notification.add(_t("%s, sent to the kitchen", categorySummary), {
                    type: "success",
                });
            }
        } finally {
            this.sendingInPreparation.delete(order.uuid);
        }
    },

    /**
     * @override
     * Same per-printer printing loop as core, but returns a richer result
     * `{ anyPrinted, allPrinted, retryPrinters, failedNames }` instead of a bare
     * boolean (callers that ignored the boolean are unaffected), logs the
     * outcome, and makes the retry popup complete the "mark as sent" step when
     * the previously-failed printers finally succeed.
     */
    async printChanges(order, orderChange, reprint = false, printers = this.unwatched.printers) {
        let isPrinted = false;
        const unsuccessfulPrints = [];
        const retryPrinters = new Set();

        for (const printer of printers) {
            for (const change of orderChange) {
                const { orderData, changes } = this.generateOrderChange(
                    order,
                    change,
                    printer.config.product_categories_ids,
                    reprint
                );
                const receiptsData = await this.generateReceiptsDataToPrint(
                    orderData,
                    changes,
                    change
                );
                let result = {};
                for (const data of receiptsData) {
                    result = await this.printOrderChanges(data, printer);
                    if (result.successful) {
                        isPrinted = true;
                    }

                    if (!result.successful) {
                        retryPrinters.add(printer);
                        unsuccessfulPrints.push(
                            printer.config.name + ": " + (result.message?.body || "")
                        );
                    } else if (result.warningCode) {
                        this.displayPrinterWarning(result, printer.config.name);
                    }
                }
            }
        }

        const allPrinted = isPrinted && unsuccessfulPrints.length === 0;
        const failedNames = [...retryPrinters].map((p) => p.config.name);

        // Don't emit ok/fail telemetry for pure reprints (e.g. the ticket screen),
        // only for real sends.
        if (printers.length && !reprint) {
            if (allPrinted) {
                this.logRobustnessEvent("kitchen_print_ok", order, {
                    message: "All kitchen tickets printed successfully.",
                });
            } else if (isPrinted) {
                this.logRobustnessEvent("kitchen_print_partial", order, {
                    severity: "warning",
                    printer_name: failedNames.join(", "),
                    message: "Some kitchen printers failed: " + unsuccessfulPrints.join(" | "),
                });
            } else {
                this.logRobustnessEvent("kitchen_print_fail", order, {
                    severity: "error",
                    printer_name: failedNames.join(", "),
                    message: "All kitchen printers failed: " + unsuccessfulPrints.join(" | "),
                });
            }
        }

        if (unsuccessfulPrints.length) {
            const failedReceipts = unsuccessfulPrints.join("\n");
            this.dialog.add(RetryPrintPopup, {
                message: failedReceipts,
                canRetry: true,
                retry: async () => {
                    this.logRobustnessEvent("kitchen_print_retry", order, {
                        printer_name: failedNames.join(", "),
                        message: "User retried the failed kitchen printer(s).",
                    });
                    // Retry targets only the printers that failed, so the printers
                    // that already succeeded are never re-hit (no duplicate).
                    const res = await this.printChanges(order, orderChange, reprint, retryPrinters);
                    if (res && res.allPrinted) {
                        // Now fully sent: complete the deferred "mark as sent" step.
                        order.updateLastOrderChange();
                        if (!this.models["pos.prep.display"]?.length) {
                            await this.syncAllOrders({ orders: [order] });
                        }
                    }
                },
            });
        }

        return { anyPrinted: isPrinted, allPrinted, retryPrinters, failedNames };
    },
});
