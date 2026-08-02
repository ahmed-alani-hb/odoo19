/** @odoo-module */

import { PosStore } from "@point_of_sale/app/services/pos_store";
import { CrPrinter } from "@cr_pos_network_printer/app/printers";
import { patch } from "@web/core/utils/patch";

patch(PosStore.prototype, {
    afterProcessServerData() {
        var self = this;        
        return super.afterProcessServerData(...arguments).then(function () {
            if (self.config.other_devices && self.config.cr_network_printer_ip && self.config.cr_network_printer_port) {
                self.hardwareProxy.printer = new CrPrinter({
                    rpc:self.env.services.rpc,
                    ip: self.config.cr_network_printer_ip,
                    port: self.config.cr_network_printer_port
                });
            }
        });
    }
});
