# Part of Odoo. See LICENSE file for full copyright and licensing details.
from odoo.tests import tagged
from .common import TestRobustnessCommon


@tagged('post_install', '-at_install')
class TestSyncConcurrencySim(TestRobustnessCommon):
    """Pure-Python (no browser) simulator for the multi-employee/same-table
    scenario. It calls `pos.order.sync_from_ui` for two "devices" editing the
    same restaurant table and verifies:

      1. the "no order line silently lost" invariant at the database level, and
      2. that the observability events we added actually capture the
         table-merge / overwrite mechanism.

    This is the regression gate for any future concurrency fix: if a change ever
    causes a line to be dropped during a same-table sync, assertion (1) fails.
    """

    def _events(self, event_type):
        return self.env['pos.order.event'].search([('event_type', '=', event_type)])

    def test_two_devices_same_table_preserve_lines_and_log_events(self):
        self.main_pos_config.open_ui()
        table = self.main_floor_table_5
        Order = self.env['pos.order']

        # Device A opens the table and sends a Coca-Cola (line L1).
        payload_a = self._make_order_payload(
            'uuid-device-A', table.id, [(self.coca_cola_test, 1, 'line-A1')])
        Order.with_context(device_identifier='deviceA').sync_from_ui([payload_a])

        order_a = Order.search([('uuid', '=', 'uuid-device-A')], limit=1)
        self.assertTrue(order_a, "Device A's order should have been created")

        # Device B (a different waiter on a different device) opens the *same*
        # table and sends a Burger (line L2) under a different order uuid.
        payload_b = self._make_order_payload(
            'uuid-device-B', table.id, [(self.burger_test, 1, 'line-B1')])
        Order.with_context(device_identifier='deviceB').sync_from_ui([payload_b])

        # --- Observability: the table-merge mechanism must have been recorded. ---
        self.assertTrue(
            self._events('sync_table_match_diff_order'),
            "Device B's sync should have matched device A's order by table and been logged")
        self.assertTrue(
            self._events('order_lines_overwritten'),
            "Rewriting device A's order lines during device B's sync should be logged")
        # The cross-order overwrite must be flagged as a warning (the dangerous case).
        overwrite = self._events('order_lines_overwritten')[0]
        self.assertEqual(overwrite.severity, 'warning')
        self.assertEqual(overwrite.device_identifier, 'deviceB')

        # --- Invariant: no order line was silently lost. ---
        sent_line_uuids = {'line-A1', 'line-B1'}
        surviving = self.env['pos.order.line'].search([
            ('order_id.table_id', '=', table.id),
            ('order_id.state', '!=', 'cancel'),
            ('uuid', 'in', list(sent_line_uuids)),
        ]).mapped('uuid')
        lost = sent_line_uuids - set(surviving)
        self.assertFalse(
            lost,
            "Order lines were silently lost during a same-table concurrent sync: %s" % lost)

    def test_same_order_resync_is_not_flagged_cross_order(self):
        """Re-syncing the *same* order (same uuid) must NOT raise the
        cross-order warning, so the warning stays a high-signal indicator."""
        self.main_pos_config.open_ui()
        table = self.main_floor_table_5
        Order = self.env['pos.order']

        payload = self._make_order_payload(
            'uuid-resync', table.id, [(self.coca_cola_test, 1, 'line-r1')])
        Order.sync_from_ui([payload])
        # Same order (same uuid), adding a new line (a realistic re-sync).
        payload2 = self._make_order_payload(
            'uuid-resync', table.id, [(self.burger_test, 1, 'line-r2')])
        Order.sync_from_ui([payload2])

        # Matching by uuid (not by a different table order) -> no cross-order warning.
        self.assertFalse(
            self._events('sync_table_match_diff_order'),
            "A same-uuid re-sync must not be flagged as a cross-order/table match")
