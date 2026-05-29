import { registry } from "@web/core/registry";
import { browser } from "@web/core/browser/browser";
import { serializeDateTime } from "@web/core/l10n/dates";

const { DateTime } = luxon;

// Flush when the buffer reaches this many events, or after this delay, whichever
// comes first. Keeps load to a trickle during rush hours (no RPC per event).
const FLUSH_THRESHOLD = 20;
const FLUSH_INTERVAL_MS = 10000;
// Hard cap so a long offline period can never grow the buffer without bound.
const MAX_BUFFER = 2000;

/**
 * Lightweight, fail-safe telemetry service for the POS frontend.
 *
 * It buffers structured observability events and flushes them to the
 * `pos.order.event` model through `pos_data.silentCall` (which swallows errors
 * and is offline-aware). Logging is strictly fire-and-forget: it must never
 * delay or break a kitchen ticket, so nothing here is awaited from the print
 * path and every operation is guarded.
 */
export const posTelemetryService = {
    dependencies: ["pos_data"],
    start(env, { pos_data }) {
        let buffer = [];
        let timer = null;

        const flush = async () => {
            if (timer) {
                browser.clearTimeout(timer);
                timer = null;
            }
            if (!buffer.length) {
                return;
            }
            const batch = buffer;
            buffer = [];
            const res = await pos_data.silentCall("pos.order.event", "create_events", [batch]);
            if (res === false) {
                // Persistence failed (offline / server error): keep the most recent
                // events to retry on the next flush, but respect the hard cap.
                buffer = [...batch, ...buffer].slice(-MAX_BUFFER);
            }
        };

        const scheduleFlush = () => {
            if (timer) {
                return;
            }
            timer = browser.setTimeout(() => {
                timer = null;
                flush();
            }, FLUSH_INTERVAL_MS);
        };

        const logEvent = (event) => {
            try {
                if (!event || !event.event_type) {
                    return;
                }
                buffer.push({
                    source: "frontend",
                    severity: "info",
                    event_date: serializeDateTime(DateTime.now()),
                    ...event,
                });
                if (buffer.length >= MAX_BUFFER) {
                    buffer = buffer.slice(-MAX_BUFFER);
                }
                if (buffer.length >= FLUSH_THRESHOLD) {
                    flush();
                } else {
                    scheduleFlush();
                }
            } catch {
                // Telemetry can never be allowed to break the POS.
            }
        };

        // Best-effort flush when the tab/app is closed.
        browser.addEventListener("beforeunload", () => {
            try {
                flush();
            } catch {
                // ignore
            }
        });

        return {
            logEvent,
            flush,
            // Exposed for tests/diagnostics.
            get bufferLength() {
                return buffer.length;
            },
        };
    },
};

registry.category("services").add("pos_telemetry", posTelemetryService);
