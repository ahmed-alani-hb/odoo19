# Part of Odoo. See LICENSE file for full copyright and licensing details.
import logging
from datetime import timedelta

from odoo import api, fields, models

_logger = logging.getLogger(__name__)

# Fields a frontend client is allowed to set when persisting an event.
_CLIENT_WRITABLE_FIELDS = {
    'event_type', 'severity', 'source', 'order_uuid', 'order_id', 'pos_reference',
    'table_id', 'config_id', 'session_id', 'user_id', 'device_identifier',
    'printer_name', 'cashier', 'message', 'payload', 'event_date',
}


class PosOrderEvent(models.Model):
    _name = 'pos.order.event'
    _description = 'POS Kitchen/Sync Observability Event'
    _order = 'event_date desc, id desc'

    event_type = fields.Selection(
        selection=[
            # --- frontend: kitchen printing ---
            ('kitchen_send_attempt', 'Kitchen Send Attempt'),
            ('kitchen_print_ok', 'Kitchen Print OK'),
            ('kitchen_print_partial', 'Kitchen Print Partial'),
            ('kitchen_print_fail', 'Kitchen Print Failed'),
            ('kitchen_print_retry', 'Kitchen Print Retry'),
            ('mark_sent_skipped', 'Mark-Sent Skipped (print failed)'),
            ('double_send_blocked', 'Double Send Blocked'),
            # --- backend/frontend: multi-employee concurrency (observed only) ---
            ('sync_table_match_diff_order', 'Sync Matched Different Order (by table)'),
            ('order_lines_overwritten', 'Order Lines Overwritten'),
            ('order_consolidated', 'Order Consolidated/Deleted'),
            ('prep_change_conflict', 'Preparation Change Conflict'),
        ],
        string='Event', required=True, index=True)
    severity = fields.Selection(
        selection=[('info', 'Info'), ('warning', 'Warning'), ('error', 'Error')],
        string='Severity', default='info', required=True, index=True)
    source = fields.Selection(
        selection=[('frontend', 'Frontend'), ('backend', 'Backend')],
        string='Source', default='frontend', required=True, index=True)

    order_uuid = fields.Char(string='Order UUID', index=True)
    # ondelete='set null' everywhere: the events we record are precisely about orders
    # being deleted/consolidated, so the audit trail must outlive the order record.
    order_id = fields.Many2one('pos.order', string='Order', ondelete='set null', index='btree_not_null')
    pos_reference = fields.Char(string='Receipt Ref')
    table_id = fields.Many2one('restaurant.table', string='Table', ondelete='set null', index='btree_not_null')
    config_id = fields.Many2one('pos.config', string='Point of Sale', ondelete='set null', index='btree_not_null')
    session_id = fields.Many2one('pos.session', string='Session', ondelete='set null', index='btree_not_null')
    user_id = fields.Many2one('res.users', string='POS User', ondelete='set null')
    # Kept as plain text so the module does not force a dependency on hr / pos_hr.
    cashier = fields.Char(string='Cashier / Employee')
    device_identifier = fields.Char(string='Device', index=True)
    printer_name = fields.Char(string='Printer(s)')
    message = fields.Char(string='Message')
    payload = fields.Text(string='Details (JSON)')
    event_date = fields.Datetime(
        string='Event Date', default=fields.Datetime.now, required=True, index=True)

    @api.model
    def create_events(self, events):
        """Persist a batch of observability events coming from the POS frontend.

        Called via ``pos_data.silentCall`` (fire-and-forget); it must never raise
        back to the UI and only accepts whitelisted fields and valid selections.

        :param list events: list of dicts, each with at least a valid ``event_type``.
        :return: ids of the created records.
        """
        if not events:
            return []
        valid_types = dict(self._fields['event_type'].selection)
        valid_severities = dict(self._fields['severity'].selection)
        vals_list = []
        for event in events:
            if not isinstance(event, dict):
                continue
            if event.get('event_type') not in valid_types:
                continue
            vals = {
                key: value
                for key, value in event.items()
                if key in _CLIENT_WRITABLE_FIELDS and value not in (None, '')
            }
            if vals.get('severity') not in valid_severities:
                vals.pop('severity', None)
            if vals.get('source') not in dict(self._fields['source'].selection):
                vals['source'] = 'frontend'
            vals_list.append(vals)
        if not vals_list:
            return []
        try:
            return self.sudo().create(vals_list).ids
        except Exception:
            # Telemetry must never break the POS; log server-side and drop the batch.
            _logger.exception("pos_restaurant_robustness: failed to persist %s event(s)", len(vals_list))
            return []

    @api.model
    def _gc_events(self, days=None):
        """Cron entrypoint: purge events older than the configured retention."""
        if days is None:
            days = int(self.env['ir.config_parameter'].sudo().get_param(
                'pos_restaurant_robustness.retention_days', 90))
        if not days or days <= 0:
            return 0
        limit_date = fields.Datetime.now() - timedelta(days=days)
        old_events = self.sudo().search([('event_date', '<', limit_date)])
        count = len(old_events)
        old_events.unlink()
        return count
