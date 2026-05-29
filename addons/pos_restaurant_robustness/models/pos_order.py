# Part of Odoo. See LICENSE file for full copyright and licensing details.
import json
import logging

from odoo import api, fields, models

_logger = logging.getLogger(__name__)


class PosOrder(models.Model):
    """Observability-only hooks around the order-sync logic.

    These overrides NEVER change the behaviour or the return value of the core
    methods: they call ``super()`` and only record a ``pos.order.event`` so the
    multi-employee concurrency behaviour (which we intentionally do not modify in
    this phase) becomes measurable. Each hook is wrapped so a logging failure can
    never break a sync.
    """
    _inherit = 'pos.order'

    def _log_robustness_event(self, vals):
        try:
            self.env['pos.order.event'].sudo().create(vals)
        except Exception:
            _logger.exception(
                "pos_restaurant_robustness: failed to log %s", vals.get('event_type'))

    def _device_identifier(self):
        return str(self.env.context.get('device_identifier') or '')

    def _get_open_order(self, order):
        result = super()._get_open_order(order)
        try:
            incoming_uuid = order.get('uuid')
            if result and incoming_uuid and result.uuid != incoming_uuid:
                # The sync for one order matched a *different* open order on the same
                # table (the restaurant table-merge domain). This is the mechanism by
                # which one employee's order can hijack/overwrite another's.
                self._log_robustness_event({
                    'event_type': 'sync_table_match_diff_order',
                    'severity': 'warning',
                    'source': 'backend',
                    'order_uuid': incoming_uuid,
                    'order_id': result.id,
                    'pos_reference': result.pos_reference,
                    'table_id': result.table_id.id if 'table_id' in result._fields else order.get('table_id'),
                    'config_id': result.config_id.id,
                    'session_id': result.session_id.id,
                    'device_identifier': self._device_identifier(),
                    'message': "Sync for order %s matched a different open order %s on the same table" % (
                        incoming_uuid, result.pos_reference or result.id),
                    'payload': json.dumps({
                        'incoming_uuid': incoming_uuid,
                        'matched_uuid': result.uuid,
                        'matched_id': result.id,
                        'table_id': order.get('table_id'),
                    }),
                })
        except Exception:
            _logger.exception("pos_restaurant_robustness: _get_open_order hook failed")
        return result

    @api.model
    def _process_order(self, order, existing_order):
        event_vals = False
        try:
            if existing_order and order.get('lines'):
                incoming_uuid = order.get('uuid')
                existing_uuid = existing_order.uuid
                cross_order = bool(incoming_uuid and existing_uuid and existing_uuid != incoming_uuid)
                event_vals = {
                    'event_type': 'order_lines_overwritten',
                    'severity': 'warning' if cross_order else 'info',
                    'source': 'backend',
                    'order_uuid': existing_uuid,
                    'order_id': existing_order.id,
                    'pos_reference': existing_order.pos_reference,
                    'table_id': existing_order.table_id.id if 'table_id' in existing_order._fields else False,
                    'config_id': existing_order.config_id.id,
                    'session_id': existing_order.session_id.id,
                    'device_identifier': self._device_identifier(),
                    'message': "Order %s lines rewritten during sync%s" % (
                        existing_order.pos_reference or existing_uuid,
                        " (cross-order / table merge)" if cross_order else ""),
                    'payload': json.dumps({
                        'existing_uuid': existing_uuid,
                        'incoming_uuid': incoming_uuid,
                        'cross_order': cross_order,
                        'existing_line_count': len(existing_order.lines),
                        'incoming_line_cmd_count': len(order.get('lines') or []),
                    }),
                }
        except Exception:
            event_vals = False
            _logger.exception("pos_restaurant_robustness: _process_order pre-hook failed")
        result = super()._process_order(order, existing_order)
        if event_vals:
            self._log_robustness_event(event_vals)
        return result

    def _ensure_to_keep_last_preparation_change(self, vals):
        conflicts = self.env['pos.order']
        try:
            raw_local = vals.get('last_order_preparation_change')
            if raw_local:
                local_change = json.loads(raw_local)
                local_meta = local_change.get('metadata') if isinstance(local_change, dict) else None
                if local_meta and local_meta.get('serverDate'):
                    local_date = fields.Datetime.from_string(local_meta.get('serverDate'))
                    for record in self:
                        if not record.last_order_preparation_change:
                            continue
                        change = json.loads(record.last_order_preparation_change)
                        meta = change.get('metadata') if isinstance(change, dict) else None
                        if meta and meta.get('serverDate'):
                            server_date = fields.Datetime.from_string(meta.get('serverDate'))
                            if server_date and local_date and server_date > local_date:
                                conflicts |= record
        except Exception:
            conflicts = self.env['pos.order']
            _logger.exception("pos_restaurant_robustness: prep-change conflict scan failed")
        result = super()._ensure_to_keep_last_preparation_change(vals)
        for record in conflicts:
            self._log_robustness_event({
                'event_type': 'prep_change_conflict',
                'severity': 'warning',
                'source': 'backend',
                'order_uuid': record.uuid,
                'order_id': record.id,
                'pos_reference': record.pos_reference,
                'table_id': record.table_id.id if 'table_id' in record._fields else False,
                'config_id': record.config_id.id,
                'session_id': record.session_id.id,
                'device_identifier': self._device_identifier(),
                'message': "Incoming preparation change was outdated; the server version was kept (possible lost kitchen update).",
            })
        return result
