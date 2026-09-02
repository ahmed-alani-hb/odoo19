# Part of Honey Bird. See LICENSE file for full copyright and licensing details.
from .common import TestRobustnessCommon


class TestPosConfigLoad(TestRobustnessCommon):
    """Regression test for the POS frontend data load of pos.config.

    pos.config is special among POS models: its base ``_load_pos_data_fields``
    returns ``[]``, which makes ``records.read([])`` load *every* field. A custom
    field must therefore NOT override ``_load_pos_data_fields`` to return a
    non-empty list (a pattern that is correct for most other models): doing so
    strips the core fields (``use_pricelist``, ``pricelist_id``, ``currency_id``,
    ...) and makes ``_load_pos_data_read`` raise ``KeyError: 'use_pricelist'``,
    which breaks loading of the Point of Sale entirely.
    """

    def test_load_pos_data_keeps_all_config_fields(self):
        config = self.main_pos_config
        # Exercise the exact seam the frontend loader uses:
        # mixin._load_pos_data_read -> _load_pos_data_fields -> records.read(...).
        read_records = self.env['pos.config']._load_pos_data_read(config, config)
        self.assertTrue(read_records, "pos.config should return a loaded record")
        record = read_records[0]

        # Core fields that the bad override stripped. POS load crashed on the
        # first of these (KeyError: 'use_pricelist'); the frontend then failed on
        # the missing currency_id.
        for field_name in ('use_pricelist', 'pricelist_id', 'currency_id', 'company_id'):
            self.assertIn(
                field_name, record,
                "pos.config frontend data must include core field %r" % field_name,
            )

        # ...and our custom field must still reach the frontend (no override needed).
        self.assertIn(
            'close_table_after_order', record,
            "the custom close_table_after_order field must be delivered to the frontend",
        )
        self.assertTrue(
            record['close_table_after_order'],
            "default must preserve the stock 'close table after sending' behaviour",
        )
