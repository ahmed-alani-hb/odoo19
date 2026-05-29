/* @odoo-module */

import { BasePrinter } from "@point_of_sale/app/utils/printer/base_printer";
import { rpc } from "@web/core/network/rpc";

export class CrPrinter extends BasePrinter {
    setup({rpc, ip ,port}) {
        super.setup(...arguments);
        this.rpc = rpc;
        this.ip = ip;
        this.port = port;
    }

    openCashbox() {
        let result;
        let printer = {
            'ip': this.ip,
            'port': parseInt(this.port) || 9100,
        }
        rpc('/open_cash_drawer', {
            printer
        }).then(function (res) {
            result = res;
        }).catch(function (err) {
            console.error(err);
            result = false;
        });
    }

    async sendPrintingJob(img) {
        if (!this.ip) {            
            return false
        }
        let receipt = {
            'ip': this.ip,
            'port': parseInt(this.port) || 9100,
            'img': img
        }        
        let result;
        await rpc(
            '/cr_print_receipt',{
            receipt 
        }).then(function (res) {
            result = res;
        }).catch(function (err) {
            console.error(err);
            result = false;
        });

        return { result ,printerErrorCode: false};
    }
}
