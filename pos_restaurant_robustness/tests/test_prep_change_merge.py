# Part of Honey Bird. See LICENSE file for full copyright and licensing details.
import json

from odoo.tests import tagged
from .common import TestRobustnessCommon


@tagged('post_install', '-at_install')
class TestPrepChangeMerge(TestRobustnessCommon):
    """Deterministic tests for the concurrent kitchen sent-state merge that
    prevents the two-device duplicate ticket. These exercise the pure merge
    helper directly (no browser / second device needed)."""

    def _blob(self, lines, server_date):
        return json.dumps({'lines': lines, 'metadata': {'serverDate': server_date}})

    def test_union_keeps_both_devices_lines(self):
        # Server already recorded line X as sent; an OLDER incoming change from a
        # second device recorded line Y. Core would discard Y (older) -> the 2nd
        # device re-sends Y -> duplicate. The merge must keep BOTH.
        server = self._blob({'X': {'uuid': 'x', 'quantity': 2}}, '2026-06-02 10:00:01')
        local = self._blob({'Y': {'uuid': 'y', 'quantity': 3}}, '2026-06-02 10:00:00')
        merged = json.loads(self.env['pos.order']._merge_preparation_changes(server, local))
        self.assertIn('X', merged['lines'], "server's sent line must be kept")
        self.assertIn('Y', merged['lines'], "the older device's sent line must NOT be lost")
        self.assertEqual(merged['lines']['Y']['quantity'], 3)

    def test_same_line_keeps_greater_quantity(self):
        # The greater sent quantity is the more-complete sent state.
        server = self._blob({'X': {'uuid': 'x', 'quantity': 5}}, '2026-06-02 10:00:00')
        local = self._blob({'X': {'uuid': 'x', 'quantity': 2}}, '2026-06-02 10:00:01')
        merged = json.loads(self.env['pos.order']._merge_preparation_changes(server, local))
        self.assertEqual(merged['lines']['X']['quantity'], 5)

    def test_returns_none_when_incoming_has_no_metadata(self):
        # Caller keeps core behaviour (don't merge a non-kitchen write).
        server = self._blob({'X': {'uuid': 'x', 'quantity': 2}}, '2026-06-02 10:00:00')
        local = json.dumps({'lines': {'Y': {'uuid': 'y', 'quantity': 3}}})  # no metadata
        self.assertIsNone(self.env['pos.order']._merge_preparation_changes(server, local))

    def test_newer_incoming_still_keeps_server_only_lines(self):
        # Even when the incoming change is NEWER, a line that only the server had
        # must survive the merge (core would drop it by taking the incoming wholesale).
        server = self._blob({'X': {'uuid': 'x', 'quantity': 2}}, '2026-06-02 10:00:00')
        local = self._blob({'Y': {'uuid': 'y', 'quantity': 1}}, '2026-06-02 10:00:09')  # newer
        merged = json.loads(self.env['pos.order']._merge_preparation_changes(server, local))
        self.assertIn('X', merged['lines'])
        self.assertIn('Y', merged['lines'])
