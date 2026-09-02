import { describe, test, expect } from "@odoo/hoot";
import { isDefiniteNoPrint } from "@pos_restaurant_robustness/app/overrides/pos_store_printing";

// The classifier decides whether a failed kitchen print *certainly* did not print
// (so it is safe to auto-resend) or *may* have printed (so auto-resend would
// duplicate). This is the core of the duplicate-vs-lost-order trade-off.
describe("pos_restaurant_robustness: isDefiniteNoPrint classifier", () => {
    test("definite no-print results (safe to re-send)", () => {
        expect(isDefiniteNoPrint({ errorCode: "PRINTER_NOT_REACHABLE" })).toBe(true);
        expect(isDefiniteNoPrint({ errorCode: "EPTR_COVER_OPEN" })).toBe(true);
        expect(isDefiniteNoPrint({ errorCode: "EPTR_REC_EMPTY" })).toBe(true);
        expect(isDefiniteNoPrint({ errorCode: "DeviceNotFound" })).toBe(true);
        expect(isDefiniteNoPrint({ message: { body: "The printer is not reachable." } })).toBe(true);
        expect(isDefiniteNoPrint({ message: { body: "It seems the printer runs out of paper." } })).toBe(
            true
        );
    });

    test("real IoT-printer 'never printed' results are definite (keep the Retry popup)", () => {
        // Exact titles/bodies the IoT (and base) printer return when the job never
        // reached the printer — nothing printed, so retrying is safe and needed.
        expect(
            isDefiniteNoPrint({
                message: {
                    title: "Connection to IoT Box failed",
                    body: "Please ensure the IoT box is turned on and connected to the network before retrying.",
                },
            })
        ).toBe(true);
        expect(
            isDefiniteNoPrint({
                message: {
                    title: "No Internet Connection",
                    body: "Please ensure you are connected to the internet before retrying.",
                },
            })
        ).toBe(true);
        expect(
            isDefiniteNoPrint({
                message: {
                    title: "Connection to the printer failed",
                    body: "Your IoT box cannot find the printer, please ensure it is connected and turned on before retrying.",
                },
            })
        ).toBe(true);
        // IoT printer "disconnected": title is the generic "Printing failed".
        expect(
            isDefiniteNoPrint({
                message: {
                    title: "Printing failed",
                    body: "The IoT Box is connected, but the receipt printer isn't. In order to continue, ensure your printer is connected:",
                },
            })
        ).toBe(true);
        expect(
            isDefiniteNoPrint({
                message: { body: "Your IoT box is registered, but your browser could not reach it." },
            })
        ).toBe(true);
    });

    test("ambiguous results — may have printed (must NOT auto-resend)", () => {
        // The exact IoT-timeout message from the field.
        expect(
            isDefiniteNoPrint({
                message: { body: "Timeout waiting for IoT Box response, please try again." },
            })
        ).toBe(false);
        // A timeout keeps the generic "Printing failed" title but must stay ambiguous.
        expect(
            isDefiniteNoPrint({
                message: {
                    title: "Printing failed",
                    body: "Timeout waiting for IoT Box response, please try again.",
                },
            })
        ).toBe(false);
        // Unknown / empty results default to ambiguous (favour no-duplicate).
        expect(isDefiniteNoPrint({})).toBe(false);
        expect(isDefiniteNoPrint({ errorCode: "SOME_UNKNOWN_CODE" })).toBe(false);
        expect(isDefiniteNoPrint(undefined)).toBe(false);
    });
});
