import { describe, test, expect } from "@odoo/hoot";
import { isIotBoxFallbackWarning } from "@pos_restaurant_robustness/app/overrides/suppress_iot_box_warning";

// The suppressor demotes ONLY the informational "IoT Box Warning" (LAN->websocket
// fallback) popup; every other dialog must pass through untouched.
describe("pos_restaurant_robustness: IoT Box Warning suppression", () => {
    test("matches only the IoT Box Warning popup", () => {
        expect(isIotBoxFallbackWarning({ title: "IoT Box Warning" })).toBe(true);
        expect(isIotBoxFallbackWarning({ title: "IoT Box Warning", body: "anything" })).toBe(true);

        // critical: the Retry-print safety net and everything else pass through
        expect(isIotBoxFallbackWarning({ title: "Printing failed" })).toBe(false);
        expect(isIotBoxFallbackWarning({ title: "Kitchen ticket didn't print" })).toBe(false);
        expect(isIotBoxFallbackWarning({ title: "Connection to IoT Box failed" })).toBe(false);
        expect(isIotBoxFallbackWarning({})).toBe(false);
        expect(isIotBoxFallbackWarning(undefined)).toBe(false);
    });
});
