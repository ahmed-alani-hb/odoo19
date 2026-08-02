/** @odoo-module */

import { PosStore } from "@point_of_sale/app/services/pos_store";
import { CrPrinter } from "@cr_pos_network_printer/app/printers";
import { patch } from "@web/core/utils/patch";
import { rpc } from "@web/core/network/rpc";

patch(PosStore.prototype, {
    createPrinter(config) {
        if (config.printer_type === "cr_network_printer") {
            console.log('rpc:', this.env.services.rpc, 'ip:', config.cr_network_printer_ip, 'port:', config.cr_network_printer_port);
            return new CrPrinter({rpc: this.env.services.rpc, ip: config.cr_network_printer_ip, port: config.cr_network_printer_port});
        } else {
            return super.createPrinter(...arguments);
        }
    },
});
