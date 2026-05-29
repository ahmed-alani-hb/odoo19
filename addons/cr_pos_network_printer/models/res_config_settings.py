# -*- coding: utf-8 -*-
# Part of Creyox Technologies

from odoo import fields, models, api


class ResConfigSettings(models.TransientModel):
    _inherit = "res.config.settings"

    cr_network_printer_ip = fields.Char(related="pos_config_id.cr_network_printer_ip", store=True, readonly=False)
    cr_network_printer_port = fields.Char(related="pos_config_id.cr_network_printer_port", store=True, readonly=False)

    def _is_cashdrawer_displayed(self, res_config):
        return super()._is_cashdrawer_displayed(res_config) or (res_config.pos_other_devices and bool(
            res_config.pos_epson_printer_ip or res_config.cr_network_printer_ip))
