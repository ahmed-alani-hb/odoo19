import * as Dialog from "@point_of_sale/../tests/generic_helpers/dialog_util";
import * as ChromePos from "@point_of_sale/../tests/pos/tours/utils/chrome_util";
import * as ChromeRestaurant from "@pos_restaurant/../tests/tours/utils/chrome";
import * as FloorScreen from "@pos_restaurant/../tests/tours/utils/floor_screen_util";
import * as ProductScreenPos from "@point_of_sale/../tests/pos/tours/utils/product_screen_util";
import * as ProductScreenResto from "@pos_restaurant/../tests/tours/utils/product_screen_util";
import { registry } from "@web/core/registry";

const Chrome = { ...ChromePos, ...ChromeRestaurant };
const ProductScreen = { ...ProductScreenPos, ...ProductScreenResto };

// Flush the telemetry buffer so the backend assertions in the Python test can
// see the events synchronously (the service otherwise flushes on a timer).
function flushTelemetry() {
    return [
        {
            content: "flush POS telemetry buffer",
            trigger: "body",
            run: async () => {
                await window.posmodel.env.services.pos_telemetry.flush();
            },
        },
    ];
}

registry.category("web_tour.tours").add("test_kitchen_print_failure_keeps_pending", {
    steps: () =>
        [
            Chrome.startPoS(),
            Dialog.confirm("Open Register"),
            FloorScreen.clickTable("5"),
            // Coca-Cola is routed to the (unreachable) "Preparation Printer", so the
            // print will fail in the test environment.
            ProductScreen.clickDisplayedProduct("Coca-Cola", true),
            ProductScreen.orderlineIsToOrder("Coca-Cola"),
            ProductScreen.clickOrderButton(),
            // The print fails -> a retry/warning dialog is shown; acknowledge it.
            Chrome.closePrintingWarning(),
            // Fix A: because the print failed, the item must STILL be pending
            // ("to order"), not silently marked as sent. (Stock POS would show
            // orderlinesHaveNoChange() here.)
            ProductScreen.orderlineIsToOrder("Coca-Cola"),
            flushTelemetry(),
        ].flat(),
});

registry.category("web_tour.tours").add("test_double_send_blocked", {
    steps: () =>
        [
            Chrome.startPoS(),
            Dialog.confirm("Open Register"),
            FloorScreen.clickTable("4"),
            ProductScreen.clickDisplayedProduct("Coca-Cola", true),
            {
                content: "fire two sends-to-kitchen for the same order back-to-back",
                trigger: "body",
                run: () => {
                    const pos = window.posmodel;
                    const order = pos.getOrder();
                    // Do NOT await the first call: while it is in-flight (awaiting the
                    // printer), the second call must be coalesced by the guard (Fix B).
                    pos.sendOrderInPreparation(order);
                    pos.sendOrderInPreparation(order);
                },
            },
            // The (failed) print warning may appear; acknowledge if present.
            Chrome.closePrintingWarning(),
            flushTelemetry(),
        ].flat(),
});
