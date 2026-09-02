# Part of Honey Bird. See LICENSE file for full copyright and licensing details.
from odoo import api, models


class PosConfig(models.Model):
    _inherit = "pos.config"

    @api.model
    def _load_pos_data_fields(self, config_id):
        # Ensure the creyox network-printer address is available on the frontend
        # config so the client-side receipt/bill printer override can use it.
        params = super()._load_pos_data_fields(config_id)
        for field_name in ("cr_network_printer_ip", "cr_network_printer_port"):
            if field_name in self._fields and field_name not in params:
                params.append(field_name)
        return params
