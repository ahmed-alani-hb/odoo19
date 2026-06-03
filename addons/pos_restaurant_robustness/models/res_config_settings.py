# Part of Honey Bird. See LICENSE file for full copyright and licensing details.
from odoo import fields, models


class ResConfigSettings(models.TransientModel):
    _inherit = "res.config.settings"

    pos_close_table_after_order = fields.Boolean(
        related="pos_config_id.close_table_after_order", readonly=False,
    )
