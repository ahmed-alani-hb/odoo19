# Part of Honey Bird. See LICENSE file for full copyright and licensing details.
from odoo import api, fields, models


class PosConfig(models.Model):
    _inherit = "pos.config"

    close_table_after_order = fields.Boolean(
        string="Close Table After Sending",
        default=True,
        help="Return to the floor screen (close the table) after an order is sent to "
             "the kitchen. Disable to keep the table open for adding more items.",
    )

    @api.model
    def _load_pos_data_fields(self, config):
        params = super()._load_pos_data_fields(config)
        if "close_table_after_order" not in params:
            params.append("close_table_after_order")
        return params
