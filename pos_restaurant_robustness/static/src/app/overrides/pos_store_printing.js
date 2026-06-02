import { patch } from "@web/core/utils/patch";
import { PosStore, CONSOLE_COLOR } from "@point_of_sale/app/services/pos_store";
import { changesToOrder } from "@point_of_sale/app/models/utils/order_change";
import { RetryPrintPopup } from "@point_of_sale/app/components/popups/retry_print_popup/retry_print_popup";
import { logPosMessage } from "@point_of_sale/app/utils/pretty_console_log";
import { _t } from "@web/core/l10n/translation";

// Classify a *failed* print result. A "definite no-print" means the printer
// certainly did NOT print (printer unreachable, out of paper, cover open, wrong
// device) — so it is safe AND necessary to re-send those items. Anything else,
// most importantly an IoT/timeout with no acknowledgement, *may* have printed, so
// we must NOT auto-resend it — that is what produced duplicate kitchen tickets on
// the slow Odoo.sh fallback.
const DEFINITE_NO_PRINT_CODES = [
    "PRINTER_NOT_REACHABLE",
    "DEVICENOTFOUND",
    "EPTR_COVER_OPEN",
    "EPTR_REC_EMPTY",
];
export function isDefiniteNoPrint(result) {
    const code = String(result?.errorCode || "").toUpperCase();
    if (DEFINITE_NO_PRINT_CODES.some((c) => code.includes(c))) {
        return true;
    }
    // Fallback for printers that don't set a machine-readable errorCode.
    const body = String(result?.message?.body || "").toLowerCase();
    return /not reachable|unreachable|cover open|out of paper|no paper|paper.*(empty|out)|device not found|printer.*off/.test(
        body
    );
}

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
     * Reimplements the core method to fix duplicate AND lost kitchen tickets:
     *  - Fix A (smart sent-state): a send marks the items "sent"
     *    (`order.updateLastOrderChange()`) and persists it to the server, UNLESS the
     *    print was a *definite* total failure (printer unreachable / out of paper /
     *    cover open — see isDefiniteNoPrint), in which case the items stay pending to
     *    be re-sent (no lost order, and no duplicate since nothing printed). An
     *    *ambiguous* failure — chiefly an IoT timeout on the slow Odoo.sh fallback,
     *    which usually means the ticket DID print — is treated as sent, so a page
     *    refresh or a second device cannot re-send and DUPLICATE it. The Retry/
     *    Reprint popup (printChanges) covers both: it reprints the same ticket
     *    without creating a new diff. (Core marks sent on every send but skips the
     *    server sync on failure, so its sent-state is lost on refresh → duplicate.)
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

            // Fix A — smart sent-state. Mark the items "sent to the kitchen" and
            // persist it to the server UNLESS the print was a *definite* total
            // failure (printer unreachable / out of paper / cover open): then nothing
            // printed, so we leave the items pending to be re-sent — no duplicate risk
            // and, crucially, no lost order. An *ambiguous* failure (e.g. an IoT
            // timeout, which usually means it DID print) is treated as sent, so a
            // refresh or a second device can't re-send and duplicate it. Either way
            // the Retry popup (raised in printChanges) lets staff reprint.
            const definiteTotalFailure = printerPath && printResult.definiteTotalFailure;
            const markedSent = !definiteTotalFailure;
            if (markedSent) {
                order.updateLastOrderChange();
                if (!this.models["pos.prep.display"]?.length) {
                    try {
                        await this.syncAllOrders({ orders: [order] });
                    } catch (e) {
                        // Offline / transient sync error: the sent-state is kept
                        // locally (IndexedDB) and syncs later. Never break the send.
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
                            : "Kitchen print unconfirmed (likely a timeout): items marked sent to prevent a duplicate. Use Reprint if nothing printed.",
                    });
                }
            } else {
                // Definite failure: nothing printed. Keep items pending so the retry
                // or the next send prints them — the order is never lost.
                this.logRobustnessEvent("mark_sent_skipped", order, {
                    severity: "warning",
                    message:
                        "Definite kitchen print failure (printer unreachable / no paper / cover open): items left pending and will be re-sent. No duplicate risk.",
                });
            }

            // Restaurant "sent to the kitchen" toast (replicated from the
            // pos_restaurant override; we bypass it). Suppressed on a definite
            // failure so we never falsely claim the order reached the kitchen.
            if (this.config.module_pos_restaurant && categoryCount.length && markedSent) {
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
     * `{ anyPrinted, allPrinted, retryPrinters, failedNames, definiteTotalFailure }`
     * instead of a bare boolean (callers that ignored the boolean are unaffected),
     * classifies failures (definite no-print vs ambiguous/timeout), logs the
     * outcome, and makes the retry popup complete the "mark as sent" step when the
     * previously-failed printers finally succeed.
     */
    async printChanges(order, orderChange, reprint = false, printers = this.unwatched.printers) {
        let isPrinted = false;
        let sawAmbiguousFailure = false; // a failure that may still have printed (e.g. a timeout)
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
                        if (!isDefiniteNoPrint(result)) {
                            sawAmbiguousFailure = true;
                        }
                    } else if (result.warningCode) {
                        this.displayPrinterWarning(result, printer.config.name);
                    }
                }
            }
        }

        const allPrinted = isPrinted && unsuccessfulPrints.length === 0;
        // A "definite total failure" = nothing printed AND every failure was a
        // definite no-print. Only then is it safe to leave the items pending for an
        // automatic re-send (the printer certainly didn't print, so re-sending can't
        // duplicate, and not re-sending would lose the order).
        const definiteTotalFailure =
            !isPrinted && unsuccessfulPrints.length > 0 && !sawAmbiguousFailure;
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

        return { anyPrinted: isPrinted, allPrinted, retryPrinters, failedNames, definiteTotalFailure };
    },
});
