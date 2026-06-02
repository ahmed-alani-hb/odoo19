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

    test("ambiguous results — may have printed (must NOT auto-resend)", () => {
        // The exact IoT-timeout message from the field.
        expect(
            isDefiniteNoPrint({
                message: { body: "Timeout waiting for IoT Box response, please try again." },
            })
        ).toBe(false);
        // Unknown / empty results default to ambiguous (favour no-duplicate).
        expect(isDefiniteNoPrint({})).toBe(false);
        expect(isDefiniteNoPrint({ errorCode: "SOME_UNKNOWN_CODE" })).toBe(false);
        expect(isDefiniteNoPrint(undefined)).toBe(false);
    });
});
