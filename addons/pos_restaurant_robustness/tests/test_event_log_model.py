# Part of Odoo. See LICENSE file for full copyright and licensing details.
from odoo.tests import TransactionCase, tagged


@tagged('post_install', '-at_install')
class TestPosOrderEventModel(TransactionCase):
    """Unit tests for the pos.order.event log model and its create_events()
    entrypoint (the seam the POS frontend uses to persist telemetry)."""

    def test_create_events_whitelists_and_validates(self):
        Event = self.env['pos.order.event']
        ids = Event.create_events([
            {
                'event_type': 'kitchen_print_fail',
                'severity': 'error',
                'message': 'IoT unreachable',
                'printer_name': 'Bar Printer',
                'order_uuid': 'abc-123',
                'not_a_real_field': 'should be ignored',  # injected key must be dropped
            },
            {'event_type': 'totally_invalid_type', 'message': 'drop me'},  # invalid selection
            {'message': 'no event_type, drop me'},
            'not even a dict',
        ])
        self.assertEqual(len(ids), 1, "Only the single valid event should be persisted")
        rec = Event.browse(ids)
        self.assertEqual(rec.event_type, 'kitchen_print_fail')
        self.assertEqual(rec.severity, 'error')
        self.assertEqual(rec.printer_name, 'Bar Printer')
        self.assertEqual(rec.order_uuid, 'abc-123')
        self.assertEqual(rec.message, 'IoT unreachable')

    def test_create_events_applies_defaults(self):
        Event = self.env['pos.order.event']
        ids = Event.create_events([
            {'event_type': 'kitchen_send_attempt'},
            # invalid severity should fall back to the default, not raise
            {'event_type': 'kitchen_print_ok', 'severity': 'bogus'},
        ])
        recs = Event.browse(ids)
        self.assertEqual(len(recs), 2)
        for rec in recs:
            self.assertEqual(rec.severity, 'info')
            self.assertEqual(rec.source, 'frontend')
            self.assertTrue(rec.event_date)

    def test_create_events_never_raises_on_empty(self):
        Event = self.env['pos.order.event']
        self.assertEqual(Event.create_events([]), [])
        self.assertEqual(Event.create_events([{'message': 'x'}]), [])

    def test_gc_events_purges_old_records(self):
        Event = self.env['pos.order.event']
        old = Event.create({'event_type': 'kitchen_print_ok', 'event_date': '2000-01-01 00:00:00'})
        recent = Event.create({'event_type': 'kitchen_print_ok'})
        purged = Event._gc_events(days=30)
        self.assertGreaterEqual(purged, 1)
        self.assertFalse(old.exists(), "Old event should have been purged")
        self.assertTrue(recent.exists(), "Recent event should be kept")

    def test_gc_events_disabled_when_retention_zero(self):
        Event = self.env['pos.order.event']
        old = Event.create({'event_type': 'kitchen_print_ok', 'event_date': '2000-01-01 00:00:00'})
        self.assertEqual(Event._gc_events(days=0), 0)
        self.assertTrue(old.exists(), "Retention=0 must disable purging")
