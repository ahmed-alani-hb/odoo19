/** @odoo-module */
import { PosStore } from "@point_of_sale/app/services/pos_store";
import { EpsonPrinter } from "@point_of_sale/app/utils/printer/epson_printer";
import { patch } from "@web/core/utils/patch";

/**
 * Route every creyox "cr_network_printer" device through Odoo's NATIVE
 * Epson ePOS-Print driver, which prints from the BROWSER (on the restaurant LAN)
 * instead of from the Odoo server. This is what makes printing work on Odoo.sh:
 * the cloud server never opens a socket to the printer — the browser does.
 *
 * This module depends on cr_pos_network_printer_res, so these patches load AFTER
 * the creyox ones and therefore take precedence (super() falls back to creyox /
 * core for any non-creyox printer type).
 *
 * REQUIREMENT: the printers must support the Epson ePOS-Print HTTP API. Generic
 * ESC/POS-over-9100-only printers cannot be reached from a browser and need an
 * IoT Box or a local print-relay agent instead.
 */
patch(PosStore.prototype, {
    // Kitchen / preparation printers (pos.printer records).
    createPrinter(config) {
        if (config.printer_type === "cr_network_printer" && config.cr_network_printer_ip) {
            return new EpsonPrinter({ ip: config.cr_network_printer_ip });
        }
        return super.createPrinter(...arguments);
    },

    // Receipt / bill printer (+ cash drawer) configured directly on the POS.
    afterProcessServerData() {
        return super.afterProcessServerData(...arguments).then(() => {
            const config = this.config;
            if (config.other_devices && config.cr_network_printer_ip) {
                this.hardwareProxy.printer = new EpsonPrinter({
                    ip: config.cr_network_printer_ip,
                });
            }
        });
    },
});
