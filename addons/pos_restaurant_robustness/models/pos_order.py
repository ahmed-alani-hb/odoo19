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

    @api.model
    def _merge_preparation_changes(self, server_raw, local_raw):
        """Union two ``last_order_preparation_change`` blobs so that no device's
        already-sent kitchen lines are lost.

        Core keeps the *newer* blob and DISCARDS the older one when two devices
        send to the kitchen at the same moment; the discarded device then loses
        its 'already sent' state and re-sends on the next refresh -> duplicate
        ticket. Here we keep the union of the ``lines`` from both blobs (for a
        line present in both, the entry with the greater sent quantity, i.e. the
        more-complete sent state), stamped with a fresh ``serverDate``.

        Returns the merged JSON string, or ``None`` when the inputs are not both
        valid kitchen states (the caller then keeps core's behaviour).
        """
        try:
            server_change = json.loads(server_raw or '{}')
            local_change = json.loads(local_raw or '{}')
        except (TypeError, ValueError):
            return None
        if not (isinstance(server_change, dict) and server_change.get('metadata')):
            return None
        if not (isinstance(local_change, dict) and local_change.get('metadata')):
            return None

        merged_lines = dict(server_change.get('lines') or {})
        for key, line in (local_change.get('lines') or {}).items():
            existing = merged_lines.get(key)
            if existing is None or (line.get('quantity') or 0) > (existing.get('quantity') or 0):
                merged_lines[key] = line

        server_date = fields.Datetime.from_string(server_change['metadata'].get('serverDate'))
        local_date = fields.Datetime.from_string(local_change['metadata'].get('serverDate'))
        # Base the non-line fields (notes, sittingMode) on whichever side is newer;
        # always union the lines and stamp a fresh serverDate.
        base = local_change if (local_date and server_date and local_date >= server_date) else server_change
        merged = dict(base)
        merged['lines'] = merged_lines
        merged['metadata'] = {'serverDate': fields.Datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
        return json.dumps(merged)

    def _ensure_to_keep_last_preparation_change(self, vals):
        """Merge concurrent kitchen sent-state instead of discarding the older
        copy (which is what makes a second device re-send and duplicate the
        ticket). Falls back to core's keep-newer behaviour on anything we can't
        safely merge, and never raises."""
        incoming_raw = vals.get('last_order_preparation_change')
        for record in self:
            try:
                if not record.last_order_preparation_change:
                    continue
                merged = self._merge_preparation_changes(record.last_order_preparation_change, incoming_raw)
                if merged is None:
                    # Not both valid kitchen states: mirror core — when the server
                    # has a kitchen state and the incoming one doesn't, keep the
                    # server's so it isn't wiped.
                    server_change = json.loads(record.last_order_preparation_change or '{}')
                    if isinstance(server_change, dict) and server_change.get('metadata'):
                        vals['last_order_preparation_change'] = record.last_order_preparation_change
                    continue
                before = len(json.loads(record.last_order_preparation_change).get('lines') or {})
                after = len(json.loads(merged).get('lines') or {})
                vals['last_order_preparation_change'] = merged
                if after > before:
                    self._log_robustness_event({
                        'event_type': 'prep_change_merged',
                        'severity': 'warning',
                        'source': 'backend',
                        'order_uuid': record.uuid,
                        'order_id': record.id,
                        'pos_reference': record.pos_reference,
                        'table_id': record.table_id.id if 'table_id' in record._fields else False,
                        'config_id': record.config_id.id,
                        'session_id': record.session_id.id,
                        'device_identifier': self._device_identifier(),
                        'message': "Merged concurrent kitchen sent-state (%d -> %d lines) "
                                   "to avoid a duplicate re-send." % (before, after),
                    })
            except Exception:
                _logger.exception("pos_restaurant_robustness: prep-change merge failed; keeping server copy")
                vals['last_order_preparation_change'] = record.last_order_preparation_change
        return
