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
// Connection-failure dialog titles the (IoT) printer returns when the job never
// reached the printer at all — the IoT box was unreachable, the client was
// offline, or the box couldn't find the printer. Nothing printed in any of these,
// so re-sending is safe and necessary.
const DEFINITE_NO_PRINT_TITLES = [
    "connection to iot box failed",
    "no internet connection",
    "connection to the printer failed",
];
// Body phrasings for the same "never printed" conditions, for printers/paths that
// don't set a machine-readable errorCode (the IoT printer only returns text). A
// TIMEOUT is deliberately NOT here: the job was sent and may have printed, so it
// stays "ambiguous" (no auto-resend, no Retry) to avoid a duplicate.
const DEFINITE_NO_PRINT_BODY =
    /not reachable|unreachable|could not reach|cover open|out of paper|no paper|paper.*(empty|out)|device not found|cannot find the printer|receipt printer isn|turned on and connected|connected to the internet before retrying|printer.*off/;
export function isDefiniteNoPrint(result) {
    const code = String(result?.errorCode || "").toUpperCase();
    if (DEFINITE_NO_PRINT_CODES.some((c) => code.includes(c))) {
        return true;
    }
    const title = String(result?.message?.title || "").toLowerCase();
    if (DEFINITE_NO_PRINT_TITLES.some((t) => title.includes(t))) {
        return true;
    }
    const body = String(result?.message?.body || "").toLowerCase();
    return DEFINITE_NO_PRINT_BODY.test(body);
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
     *    (`order.updateLastOrderChange()`) and persists it to the server (in the
     *    background, so the Send button isn't blocked by the Odoo.sh round-trip),
     *    UNLESS the
     *    print was a *definite* total failure (printer unreachable / out of paper /
     *    cover open — see isDefiniteNoPrint), in which case the items stay pending to
     *    be re-sent (no lost order, and no duplicate since nothing printed). An
     *    *ambiguous* failure — chiefly an IoT timeout on the slow Odoo.sh fallback,
     *    which usually means the ticket DID print — is treated as sent, so a page
     *    refresh or a second device cannot re-send and DUPLICATE it. The Retry/
     *    Reprint popup (printChanges) covers both: it reprints the same ticket
     *    without creating a new diff. (Core marks sent on every send but skips the
     *    server sync on failure, so its sent-state is lost on refresh → duplicate.)
     *  - Fix B (self-healing double-send guard): concurrent/rapid sends for the same
     *    order are coalesced; the guard auto-releases after 30s so a hung print/sync
     *    can never freeze the Send button until a page refresh (and that refresh was
     *    what dropped the local sent-state and caused a duplicate).
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
            // Tell staff it is working, so the dead-looking Send button isn't spammed.
            this.notification?.add(_t("Still sending the previous ticket — please wait…"), {
                type: "warning",
            });
            return;
        }
        this.sendingInPreparation.add(order.uuid);
        // Self-healing guard: a hung IoT print or order-sync (a promise that never
        // settles) must NEVER pin this guard forever. If it did, the Send button
        // stays dead until a full page refresh — and that refresh is exactly what
        // drops the locally-marked "sent" state and causes a duplicate on the next
        // send. Auto-release after a bounded time so the order can be retried IN
        // PLACE, where the local sent-state still suppresses re-printing the
        // already-sent lines (so no refresh, no duplicate).
        let guardReleased = false;
        let guardTimer;
        const releaseGuard = (reason) => {
            if (guardReleased) {
                return;
            }
            guardReleased = true;
            clearTimeout(guardTimer);
            this.sendingInPreparation.delete(order.uuid);
            if (reason === "timeout") {
                this.logRobustnessEvent("send_guard_timeout", order, {
                    severity: "warning",
                    message:
                        "Send did not confirm within 30s; the in-flight guard was auto-released so the order is not frozen. Verify the kitchen ticket before re-sending.",
                });
            }
        };
        guardTimer = setTimeout(() => releaseGuard("timeout"), 30000);
        // When set, the kitchen ticket prints in the BACKGROUND and releases the
        // guard once it settles; the synchronous paths release it in the `finally`.
        let backgroundPrint = null;
        try {
            let categoryCount = [];
            if (!opts.cancelled) {
                categoryCount = this.getCategoryCount?.(order) || [];
            }

            this.logRobustnessEvent("kitchen_send_attempt", order);

            const printerPath = Boolean(
                this.config.printerCategories.size && !opts.byPassPrint
            );

            // Compute what to print (identical to core). `orderChange` is the diff;
            // `reprint` means there were no new changes so we reprint the last ticket.
            let reprint = false;
            let orderChange = null;
            if (printerPath) {
                orderChange = changesToOrder(
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
            }

            // Reprint / cancellation / no-printer keep the original AWAITED flow:
            // these are rare and not on the snappy table-close path, so we don't
            // reorder them — the sent-state is decided from the real print result.
            if (!printerPath || reprint || opts.cancelled) {
                let printResult = { anyPrinted: false, allPrinted: false };
                if (printerPath) {
                    try {
                        printResult = await this.printChanges(order, orderChange, reprint);
                    } catch (e) {
                        this._robustnessLogPrintException(order, e);
                        printResult = { anyPrinted: false, allPrinted: false };
                    }
                }
                this._robustnessApplySentState(order, printResult, printerPath, categoryCount);
                return;
            }

            // Normal new send — snappy AND multi-device-correct.
            // 1) Snapshot the pre-send kitchen state so we can roll back if the
            //    background print turns out to be a definite total failure.
            const prevPrepChange = JSON.parse(
                JSON.stringify(order.last_order_preparation_change)
            );
            // 2) Mark the order sent and push it to the server NOW (synchronously),
            //    BEFORE this method returns. This is what lets the caller close the
            //    table / free the Send button immediately while OTHER DEVICES viewing
            //    the same table see the items as sent right away (instead of "not
            //    sent" until the printer round-trip finished — which risked a
            //    duplicate re-send from the second device).
            order.updateLastOrderChange();
            this._robustnessPushSentState(order);
            this._robustnessSentToKitchenToast(order, categoryCount);
            this.logRobustnessEvent("kitchen_send_dispatched", order, {
                message:
                    "Order marked sent and pushed to the server; the kitchen ticket is printing in the background.",
            });
            // 3) Print the ticket in the BACKGROUND; reconcile (roll back on a
            //    definite failure) when it settles, then release the in-flight guard.
            backgroundPrint = this._robustnessPrintAndReconcile(
                order,
                orderChange,
                prevPrepChange
            ).finally(() => releaseGuard("done"));
        } finally {
            if (!backgroundPrint) {
                releaseGuard("done");
            }
        }
    },

    /** Persist the order's (already-set) sent-state to the server in the
     * background so other devices converge. Skipped when a preparation display is
     * in use (it owns that state). Never blocks the caller and never throws. */
    _robustnessPushSentState(order) {
        if (this.models["pos.prep.display"]?.length) {
            return;
        }
        this.syncAllOrders({ orders: [order] }).catch((e) => {
            this.logRobustnessEvent("sent_state_sync_deferred", order, {
                severity: "warning",
                message:
                    "Background sent-state sync failed; kept locally, will retry. " +
                    (e?.message || String(e)),
            });
        });
    },

    /** Restaurant "X, sent to the kitchen" toast (replicated from the
     * pos_restaurant override, which we bypass). */
    _robustnessSentToKitchenToast(order, categoryCount) {
        if (this.config.module_pos_restaurant && categoryCount.length) {
            const categorySummary = categoryCount
                .map((cat) => `${cat.count} ${cat.name}`)
                .join(_t(", "))
                .replace(/, ([^,]*)$/, _t(" and $1"));
            this.notification.add(_t("%s, sent to the kitchen", categorySummary), {
                type: "success",
            });
        }
    },

    _robustnessLogPrintException(order, e) {
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
    },

    /** Fix A "smart sent-state" decision for the AWAITED paths (no-printer,
     * cancellation, reprint): mark sent + push UNLESS the print was a *definite*
     * total failure (then leave the items pending to be re-sent — no duplicate, no
     * lost order); an ambiguous failure (e.g. a timeout) is treated as sent. */
    _robustnessApplySentState(order, printResult, printerPath, categoryCount) {
        const definiteTotalFailure = printerPath && printResult.definiteTotalFailure;
        if (!definiteTotalFailure) {
            order.updateLastOrderChange();
            this._robustnessPushSentState(order);
            if (printerPath && !printResult.allPrinted) {
                this.logRobustnessEvent("mark_sent_forced", order, {
                    severity: "warning",
                    message: printResult.anyPrinted
                        ? "Partial kitchen print: items marked sent; reprint the failed printer(s) from the popup."
                        : "Kitchen print unconfirmed (likely a timeout): items marked sent to prevent a duplicate. Use Reprint if nothing printed.",
                });
            }
            this._robustnessSentToKitchenToast(order, categoryCount);
        } else {
            this.logRobustnessEvent("mark_sent_skipped", order, {
                severity: "warning",
                message:
                    "Definite kitchen print failure (printer unreachable / no paper / cover open): items left pending and will be re-sent. No duplicate risk.",
            });
        }
    },

    /** Background half of the snappy send: print the (already-marked-sent) ticket,
     * then reconcile. On a DEFINITE total failure roll the optimistic sent-state
     * back to `prevPrepChange` so the items are re-sent (no lost ticket); an
     * ambiguous failure (e.g. a timeout) is kept sent so a refresh or a second
     * device can't re-send and duplicate it. Never throws. */
    async _robustnessPrintAndReconcile(order, orderChange, prevPrepChange) {
        let printResult = { anyPrinted: false, allPrinted: false };
        try {
            printResult = await this.printChanges(order, orderChange, false);
        } catch (e) {
            this._robustnessLogPrintException(order, e);
            printResult = { anyPrinted: false, allPrinted: false };
        }

        if (printResult.definiteTotalFailure) {
            // Roll back the optimistic sent-state: restore the pre-send snapshot,
            // recompute the per-line "to send" flags against it, and push the
            // reverted state so other devices revert too. The Retry/Reprint popup
            // (raised by printChanges) also lets staff reprint.
            order.last_order_preparation_change = prevPrepChange;
            try {
                this.getOrderChanges(order);
            } catch {
                // recompute is best-effort; reactivity refreshes it on the next render
            }
            order._markDirty?.();
            this._robustnessPushSentState(order);
            this.logRobustnessEvent("mark_sent_rolled_back", order, {
                severity: "warning",
                message:
                    "Definite kitchen print failure after an optimistic send: the sent-state was rolled back so the items are re-sent. No duplicate risk.",
            });
        } else if (!printResult.allPrinted) {
            this.logRobustnessEvent("mark_sent_forced", order, {
                severity: "warning",
                message: printResult.anyPrinted
                    ? "Partial kitchen print: items kept sent; reprint the failed printer(s) from the popup."
                    : "Kitchen print unconfirmed (likely a timeout): items kept sent to prevent a duplicate. Use Reprint if nothing printed.",
            });
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
        // Per-failure classification drives BOTH the wording and the action:
        //  - definite no-print (offline / no paper / cover open): nothing came out,
        //    so Retry is safe and correct.
        //  - ambiguous (chiefly an IoT timeout): the job has usually already reached
        //    the box and printed — the POS just gave up waiting for the ack — so
        //    Retry would print a SECOND copy. We never offer Retry for these; the
        //    order is already kept "sent", so we only show a non-blocking notice.
        const definiteFailures = []; // { printer, name }
        const ambiguousFailures = []; // { printer, name }

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
                        if (result.warningCode) {
                            this.displayPrinterWarning(result, printer.config.name);
                        }
                    } else if (isDefiniteNoPrint(result)) {
                        definiteFailures.push({ printer, name: printer.config.name });
                    } else {
                        ambiguousFailures.push({ printer, name: printer.config.name });
                    }
                }
            }
        }

        const unsuccessfulCount = definiteFailures.length + ambiguousFailures.length;
        const allPrinted = isPrinted && unsuccessfulCount === 0;
        // A "definite total failure" = nothing printed AND every failure was a
        // definite no-print. Only then is it safe to leave the items pending for an
        // automatic re-send (the printer certainly didn't print, so re-sending can't
        // duplicate, and not re-sending would lose the order).
        const definiteTotalFailure =
            !isPrinted && definiteFailures.length > 0 && ambiguousFailures.length === 0;
        // Only definite no-print printers are safe to retry; an ambiguous timeout has
        // most likely already printed, so retrying it would duplicate.
        const retryPrinters = new Set(definiteFailures.map((f) => f.printer));
        const uniqueNames = (list) => [...new Set(list.map((f) => f.name))];
        const definiteNames = uniqueNames(definiteFailures);
        const ambiguousNames = uniqueNames(ambiguousFailures);
        const failedNames = uniqueNames([...definiteFailures, ...ambiguousFailures]);

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
                    message:
                        "Some kitchen printers failed. Definite no-print: " +
                        (definiteNames.join(", ") || "none") +
                        "; unconfirmed/timeout: " +
                        (ambiguousNames.join(", ") || "none"),
                });
            } else {
                this.logRobustnessEvent("kitchen_print_fail", order, {
                    severity: "error",
                    printer_name: failedNames.join(", "),
                    message:
                        "All kitchen printers failed. Definite no-print: " +
                        (definiteNames.join(", ") || "none") +
                        "; unconfirmed/timeout: " +
                        (ambiguousNames.join(", ") || "none"),
                });
            }
        }

        // Ambiguous (timeout) failures: the ticket most likely printed and the order
        // is already kept "sent", so don't raise the blocking popup and NEVER offer
        // Retry (it would duplicate). A non-blocking notice is enough.
        if (ambiguousFailures.length) {
            this.notification.add(
                _t(
                    "%s: sent, but the print wasn't confirmed (slow IoT link). It most likely printed — only reprint from the order if nothing came out.",
                    ambiguousNames.join(_t(", "))
                ),
                { type: "warning" }
            );
        }

        // Definite no-print failures: nothing came out, so this is the real safety
        // net — a blocking popup whose Retry re-sends ONLY those printers.
        if (definiteFailures.length) {
            this.dialog.add(RetryPrintPopup, {
                title: _t("Kitchen ticket didn't print"),
                message: _t(
                    "%s did not print — check the printer is powered on, has paper, and its cover is closed.",
                    definiteNames.join(_t(", "))
                ),
                canRetry: true,
                retry: async () => {
                    this.logRobustnessEvent("kitchen_print_retry", order, {
                        printer_name: definiteNames.join(", "),
                        message: "User retried the failed kitchen printer(s).",
                    });
                    // Retry targets only the printers that definitely did not print,
                    // so neither the printers that already succeeded nor the ambiguous
                    // (likely-printed) ones are re-hit — no duplicate.
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
