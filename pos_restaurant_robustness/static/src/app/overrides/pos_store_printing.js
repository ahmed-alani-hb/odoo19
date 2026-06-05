import { patch } from "@web/core/utils/patch";
import { PosStore, CONSOLE_COLOR } from "@point_of_sale/app/services/pos_store";
import { changesToOrder } from "@point_of_sale/app/models/utils/order_change";
import { logPosMessage } from "@point_of_sale/app/utils/pretty_console_log";
import { FailedPrintsPopup } from "@pos_restaurant_robustness/app/overrides/failed_prints_popup";
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
        // Max time to wait for a kitchen print to confirm before the optimistic send's
        // "pending" marker is surfaced as UNCONFIRMED (so a hung/lost print is never
        // silent). Instance property so tests can shorten it.
        this.printConfirmTimeoutMs = 25000;
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
            // Persist an "unconfirmed" marker NOW (before the print is even attempted)
            // so that a hung print, a lost IoT status event, or a refresh/crash before
            // the background print settles can NEVER leave the ticket silently
            // unprinted: the marker stays in uiState and is converted to a surfaced
            // failure either by the reconcile timeout below, or — if this session dies
            // first — by the startup sweep after the next reload. An in-flight pending
            // marker does not alarm; only its converted (failed/unconfirmed) form does.
            const pendingId = this._recordPendingPrint(order, orderChange, false);
            this.logRobustnessEvent("kitchen_send_dispatched", order, {
                message:
                    "Order marked sent and pushed to the server; the kitchen ticket is printing in the background.",
            });
            // 3) Print the ticket in the BACKGROUND; reconcile (resolve the pending
            //    marker, roll back on a definite failure) when it settles OR when the
            //    confirmation times out, then release the in-flight guard.
            backgroundPrint = this._robustnessPrintAndReconcile(
                order,
                orderChange,
                prevPrepChange,
                pendingId
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
     * then reconcile the pre-created `pendingId` marker. The IoT (pos_iot) print
     * promise only settles when a status event comes back, and a powered-off / stuck
     * printer or a lost event can leave it pending FOREVER — which is exactly what let
     * a send be marked sent with nothing printed and NOTHING flagged. So we bound the
     * wait: within the window we resolve the marker from the real result (remove on
     * success, convert to a surfaced failure otherwise, rolling the optimistic
     * sent-state back on a definite total failure); on timeout we convert the marker
     * to a surfaced "unconfirmed" failure so it can never be silent. Never throws. */
    async _robustnessPrintAndReconcile(order, orderChange, prevPrepChange, pendingId) {
        let printResult = null;
        // record:false — we own `pendingId` and convert it in place from the returned
        // failure lists, so printChanges must not record a second entry.
        const printPromise = this.printChanges(order, orderChange, false, this.unwatched.printers, {
            record: false,
        })
            .then((r) => (printResult = r))
            .catch((e) => {
                this._robustnessLogPrintException(order, e);
                printResult = {
                    anyPrinted: false,
                    allPrinted: false,
                    definiteTotalFailure: false,
                    definiteFailures: [],
                    ambiguousFailures: [],
                };
            });

        const timeout = new Promise((resolve) =>
            setTimeout(resolve, this.printConfirmTimeoutMs ?? 25000)
        );
        await Promise.race([printPromise, timeout]);

        if (printResult) {
            this._reconcilePending(order, pendingId, printResult, prevPrepChange);
        } else {
            // No answer from the printer within the window: surface it NOW so it is
            // never silent. Keep listening — a late success clears the marker; a late
            // failure refines its reason.
            this._convertPendingToUnconfirmed(order, pendingId);
            this.logRobustnessEvent("kitchen_print_unconfirmed", order, {
                severity: "error",
                printer_name: this._pendingPrinterNames(order, pendingId),
                message:
                    "No confirmation from the printer within " +
                    Math.round((this.printConfirmTimeoutMs ?? 25000) / 1000) +
                    "s; kept sent and flagged UNCONFIRMED. Reprint from the table if nothing came out.",
            });
            printPromise.then(() => {
                if (printResult) {
                    this._reconcilePending(order, pendingId, printResult, prevPrepChange);
                }
            });
        }
    },

    /** Resolve a pending print marker from a settled print result. */
    _reconcilePending(order, pendingId, printResult, prevPrepChange) {
        if (printResult.allPrinted) {
            // Printed fine — drop the marker.
            this.clearFailedPrint(order, pendingId);
            return;
        }
        // Failure — convert the marker into a surfaced failed entry with reasons.
        this._convertPending(
            order,
            pendingId,
            printResult.definiteFailures || [],
            printResult.ambiguousFailures || []
        );
        if (printResult.definiteTotalFailure) {
            // Roll back the optimistic sent-state so the items are re-sent (no lost
            // ticket); recompute per-line flags and push so other devices revert too.
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
        } else {
            this.logRobustnessEvent("mark_sent_forced", order, {
                severity: "warning",
                message: printResult.anyPrinted
                    ? "Partial kitchen print: items kept sent; reprint the failed printer(s) from the table panel."
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
    async printChanges(order, orderChange, reprint = false, printers = this.unwatched.printers, opts = {}) {
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

        // Record any failure as a persistent, per-order "failed prints" entry. This
        // drives the on-table bubble (floor screen), the retry/clear panel shown when
        // the table is opened (see setTableFromUi), and the persistent alert banner —
        // far harder to miss than a transient popup. A brief toast gives immediate
        // feedback; the actual recovery (retry only the failed printers -> no
        // duplicate, or clear) happens from the table panel.
        //
        // `opts.record === false` is used by the optimistic background reconcile,
        // which owns a pre-created "pending" entry it converts in place (so we don't
        // record a SECOND entry here); it reads `definiteFailures`/`ambiguousFailures`
        // off the return value instead.
        if (opts.record !== false && (definiteFailures.length || ambiguousFailures.length)) {
            this._recordFailedPrint(order, orderChange, reprint, definiteFailures, ambiguousFailures);
            this.notification.add(
                definiteFailures.length
                    ? _t("%s didn't print — open the table to retry.", definiteNames.join(_t(", ")))
                    : _t(
                          "%s: print not confirmed — open the table to check.",
                          ambiguousNames.join(_t(", "))
                      ),
                { type: "warning" }
            );
        }

        return {
            anyPrinted: isPrinted,
            allPrinted,
            retryPrinters,
            failedNames,
            definiteTotalFailure,
            definiteFailures,
            ambiguousFailures,
        };
    },

    // --- Failed-print tracker (per-order, device-local; survives refresh via uiState) ---

    /** The order's failed-print entries, lazily initialised. */
    getFailedPrints(order) {
        if (!order?.uiState) {
            return [];
        }
        if (!order.uiState.failedPrints) {
            order.uiState.failedPrints = [];
        }
        return order.uiState.failedPrints;
    },

    /** The order's SURFACED failed prints (excludes in-flight "pending" markers). */
    getActiveFailedPrints(order) {
        return this.getFailedPrints(order).filter((e) => !e.pending);
    },

    /** Total surfaced failed prints across a table's open orders (for the bubble).
     * In-flight pending markers are excluded so a normal send doesn't flash a badge. */
    getFailedPrintCount(table) {
        let count = 0;
        try {
            for (const o of this.models["pos.order"].filter(
                (o) => o.table_id?.id === table.id && !o.finalized
            )) {
                count += (o.uiState?.failedPrints || []).filter((e) => !e.pending).length;
            }
        } catch {
            // observability helper must never break the floor screen
        }
        return count;
    },

    /** Active kitchen-print alerts across all open orders, for the persistent banner.
     * Each: { orderUuid, order, table, printers, reason, entryId }. Never throws. */
    getKitchenAlerts() {
        const alerts = [];
        try {
            for (const o of this.models["pos.order"].filter((o) => !o.finalized)) {
                for (const e of o.uiState?.failedPrints || []) {
                    if (e.pending) {
                        continue;
                    }
                    alerts.push({
                        orderUuid: o.uuid,
                        order: o,
                        table: o.table_id?.table_number ?? o.table_id?.name ?? "",
                        printers: (e.printers || [])
                            .map((p) => p.name)
                            .filter(Boolean)
                            .join(", "),
                        reason:
                            e.reason ||
                            ((e.printers || []).some((p) => p.definite)
                                ? _t("didn't print")
                                : _t("not confirmed")),
                        entryId: e.id,
                    });
                }
            }
        } catch {
            // banner must never break the chrome
        }
        return alerts;
    },

    /** Open the retry/clear panel for a banner alert's order (works from any screen). */
    openKitchenAlert(alert) {
        try {
            if (alert?.order) {
                this.dialog.add(FailedPrintsPopup, { order: alert.order });
            }
        } catch {
            // never let the banner break the chrome
        }
    },

    /** Record a failed print so it can be retried/cleared later from the table. */
    _recordFailedPrint(order, orderChange, reprint, definiteFailures = [], ambiguousFailures = []) {
        try {
            const printers = [
                ...definiteFailures.map((f) => ({
                    id: f.printer?.config?.id,
                    name: f.name,
                    definite: true,
                })),
                ...ambiguousFailures.map((f) => ({
                    id: f.printer?.config?.id,
                    name: f.name,
                    definite: false,
                })),
            ];
            this.getFailedPrints(order).push({
                id: `${order.uuid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
                change: orderChange,
                reprint: Boolean(reprint),
                printers,
                when: Date.now(),
            });
        } catch {
            // bookkeeping must never break printing
        }
    },

    /** Record an in-flight "pending" marker the instant an optimistic send is
     * dispatched, so the print can never be silently lost (it is converted to a
     * surfaced failure by the reconcile timeout, or by the startup sweep after a
     * reload). Returns the entry id. Targets all kitchen printers (the actual failed
     * set replaces them on conversion). Never throws. */
    _recordPendingPrint(order, orderChange, reprint) {
        try {
            const id = `${order?.uuid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const printers = (this.unwatched.printers || []).map((p) => ({
                id: p.config?.id,
                name: p.config?.name,
                definite: false,
            }));
            this.getFailedPrints(order).push({
                id,
                change: orderChange,
                reprint: Boolean(reprint),
                printers,
                pending: true,
                when: Date.now(),
            });
            return id;
        } catch {
            return null;
        }
    },

    /** Convert a pending marker into a surfaced failed entry with the real failed
     * printers + a human reason. No-op if the marker is gone (e.g. user cleared it). */
    _convertPending(order, pendingId, definiteFailures = [], ambiguousFailures = []) {
        try {
            const entry = this.getFailedPrints(order).find((e) => e.id === pendingId);
            if (!entry) {
                return;
            }
            const printers = [
                ...definiteFailures.map((f) => ({ id: f.printer?.config?.id, name: f.name, definite: true })),
                ...ambiguousFailures.map((f) => ({ id: f.printer?.config?.id, name: f.name, definite: false })),
            ];
            if (printers.length) {
                entry.printers = printers;
            }
            entry.pending = false;
            entry.unconfirmed = ambiguousFailures.length > 0 && definiteFailures.length === 0;
            entry.reason = definiteFailures.length ? _t("Didn't print") : _t("Print not confirmed");
        } catch {
            // ignore
        }
    },

    /** Convert a pending marker into a surfaced "unconfirmed" failure (the printer
     * never answered within the timeout). Targeted printers are kept. */
    _convertPendingToUnconfirmed(order, pendingId) {
        try {
            const entry = this.getFailedPrints(order).find((e) => e.id === pendingId);
            if (!entry) {
                return;
            }
            entry.pending = false;
            entry.unconfirmed = true;
            entry.reason = _t("No response from printer — not confirmed");
        } catch {
            // ignore
        }
    },

    _pendingPrinterNames(order, pendingId) {
        try {
            const e = this.getFailedPrints(order).find((x) => x.id === pendingId);
            return (e?.printers || [])
                .map((p) => p.name)
                .filter(Boolean)
                .join(", ");
        } catch {
            return "";
        }
    },

    clearFailedPrint(order, entryId) {
        try {
            const list = this.getFailedPrints(order);
            const idx = list.findIndex((e) => e.id === entryId);
            if (idx >= 0) {
                list.splice(idx, 1);
            }
        } catch {
            // ignore
        }
    },

    clearAllFailedPrints(order) {
        try {
            this.getFailedPrints(order).length = 0;
        } catch {
            // ignore
        }
    },

    /** Reprint a failed entry to ONLY the printers that failed (no duplicate of the
     * printers that already succeeded). On full success the entry is removed and the
     * items are confirmed sent; a fresh entry is recorded by printChanges if it
     * fails again. */
    async retryFailedPrint(order, entryId) {
        const entry = this.getFailedPrints(order).find((e) => e.id === entryId);
        if (!entry) {
            return;
        }
        const ids = new Set((entry.printers || []).map((p) => p.id));
        const printers = this.unwatched.printers.filter((p) => ids.has(p.config.id));
        if (!printers.length) {
            // the printer is no longer configured; nothing to retry
            this.clearFailedPrint(order, entryId);
            return;
        }
        this.logRobustnessEvent("kitchen_print_retry", order, {
            printer_name: (entry.printers || []).map((p) => p.name).join(", "),
            message: "User retried failed kitchen print(s) from the table panel.",
        });
        let res;
        try {
            res = await this.printChanges(order, entry.change, entry.reprint, printers);
        } catch {
            // keep the entry so it can be retried again
            return;
        }
        // Remove the entry we just retried (printChanges recorded a fresh one if it
        // failed again).
        this.clearFailedPrint(order, entryId);
        if (res && res.allPrinted) {
            order.updateLastOrderChange();
            if (!this.models["pos.prep.display"]?.length) {
                this.syncAllOrders({ orders: [order] }).catch(() => {});
            }
        }
    },

    async retryAllFailedPrints(order) {
        for (const entry of [...this.getFailedPrints(order)]) {
            await this.retryFailedPrint(order, entry.id);
        }
    },

    /**
     * @override — after orders are loaded, sweep any "pending" print markers left by
     * a previous session that died mid-send (refresh/close/crash before the
     * background print settled). Their in-memory reconcile is gone, so they would
     * otherwise linger forever; convert them to surfaced "unconfirmed" failures so the
     * (possibly unprinted) ticket is visible on the table + banner. Never throws.
     */
    async afterProcessServerData() {
        const res = await super.afterProcessServerData(...arguments);
        try {
            this._sweepOrphanPendingPrints();
        } catch {
            // sweep must never break POS startup
        }
        return res;
    },

    _sweepOrphanPendingPrints() {
        for (const o of this.models["pos.order"].getAll()) {
            for (const e of o.uiState?.failedPrints || []) {
                if (e.pending) {
                    e.pending = false;
                    e.unconfirmed = true;
                    e.reason = _t("Not confirmed before reload — reprint if nothing printed");
                }
            }
        }
    },

    /**
     * @override (pos_restaurant) — after a waiter opens a table, surface any
     * unresolved failed kitchen prints for its current order so they can retry
     * (without duplication) or clear them. Wrapped so it can never break opening a
     * table.
     */
    async setTableFromUi(table, orderUuid = null) {
        await super.setTableFromUi(table, orderUuid);
        try {
            const order = this.getOrder();
            if (order && this.getFailedPrints(order).length) {
                this.dialog.add(FailedPrintsPopup, { order });
            }
        } catch {
            // never let the panel break table opening
        }
    },
});
