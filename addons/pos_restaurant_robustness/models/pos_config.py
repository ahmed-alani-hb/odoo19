# Part of Honey Bird. See LICENSE file for full copyright and licensing details.
from odoo import fields, models


class PosConfig(models.Model):
    _inherit = "pos.config"

    close_table_after_order = fields.Boolean(
        string="Close Table After Sending",
        default=True,
        help="Return to the floor screen (close the table) after an order is sent to "
             "the kitchen. Disable to keep the table open for adding more items.",
    )
    # NB: do NOT override `_load_pos_data_fields` for pos.config. Unlike most
    # models, pos.config does not restrict the fields it sends to the frontend:
    # the base method returns [] so `records.read([])` loads *every* field.
    # Returning a non-empty list here strips all the other fields (use_pricelist,
    # pricelist_id, currency_id, ...) and breaks POS loading. This field is sent
    # to the frontend automatically, no loader override needed.
