# Part of Odoo. See LICENSE file for full copyright and licensing details.
from odoo.tests import tagged
from .common import TestRobustnessCommon


@tagged('post_install', '-at_install')
class TestKitchenPrintRobustness(TestRobustnessCommon):
    """Browser (tour) tests. They drive the real POS UI, so they require a
    headless browser and run in CI. The kitchen printers in the test setup point
    at unreachable IPs, so `printChanges` fails naturally — which is exactly the
    false-failure condition that used to cause duplicate tickets; we assert the
    items are now marked sent (durable) instead of left pending."""

    def test_kitchen_print_definite_failure_keeps_pending(self):
        self.main_pos_config.open_ui()
        self.start_pos_tour('test_kitchen_print_definite_failure_keeps_pending')
        Event = self.env['pos.order.event']
        self.assertTrue(
            Event.search_count([('event_type', '=', 'kitchen_print_fail')]),
            "The failed kitchen print should have been logged")
        self.assertTrue(
            Event.search_count([('event_type', '=', 'mark_sent_skipped')]),
            "On a DEFINITE print failure (printer unreachable) the items must be "
            "left pending (mark_sent_skipped) so the order is re-sent, not lost")

    def test_double_send_is_blocked(self):
        self.main_pos_config.open_ui()
        self.start_pos_tour('test_double_send_blocked')
        self.assertTrue(
            self.env['pos.order.event'].search_count([('event_type', '=', 'double_send_blocked')]),
            "A concurrent/rapid second send for the same order must be blocked and logged")

    # NOTE: the multi-employee / same-table concurrency behaviour is covered
    # deterministically (and without a browser) by
    # tests/test_sync_concurrency_sim.py, which is the authoritative regression
    # gate for that scenario.
