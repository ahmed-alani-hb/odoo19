# Part of Odoo. See LICENSE file for full copyright and licensing details.
import odoo.tests
from odoo import fields
from odoo.addons.pos_restaurant.tests.test_frontend import TestFrontendCommon


@odoo.tests.tagged('post_install', '-at_install')
class TestRobustnessCommon(TestFrontendCommon):
    """Restaurant test setup + a SECOND kitchen printer so partial-success
    (one printer OK, one printer failing) can be exercised, plus a small
    `sync_from_ui` payload builder used by the concurrency simulator."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.drinks_category = cls.env['pos.category'].search([('name', '=', 'Drinks')], limit=1)
        cls.food_category = cls.env['pos.category'].search([('name', '=', 'Food')], limit=1)

        # A second, independent kitchen printer routed to the Food category.
        # TestFrontendCommon already created a "Preparation Printer" for Drinks.
        cls.food_printer = cls.env['pos.printer'].create({
            'name': 'Kitchen Printer',
            'epson_printer_ip': '127.0.0.2',
            'printer_type': 'epson_epos',
            'product_categories_ids': [cls.food_category.id],
        })
        cls.pos_config.write({'printer_ids': [(4, cls.food_printer.id)]})

        cls.burger_test = cls.env['product.product'].create({
            'available_in_pos': True,
            'list_price': 8.0,
            'name': 'Test Burger',
            'pos_categ_ids': [(4, cls.food_category.id)],
            'taxes_id': [(6, 0, [])],
        })

    # ------------------------------------------------------------------
    # sync_from_ui payload helpers (modelled on point_of_sale's
    # TestPoSCommon.create_ui_order_data, kept minimal for draft orders).
    # ------------------------------------------------------------------
    def _make_line(self, product, qty, line_uuid):
        subtotal = product.list_price * qty
        return (0, 0, {
            'uuid': line_uuid,
            'product_id': product.id,
            'qty': qty,
            'price_unit': product.list_price,
            'price_subtotal': subtotal,
            'price_subtotal_incl': subtotal,
            'tax_ids': [(6, 0, [])],
            'pack_lot_ids': [],
        })

    def _make_order_payload(self, order_uuid, table_id, line_specs, state='draft'):
        """line_specs: list of (product, qty, line_uuid)."""
        session = self.main_pos_config.current_session_id
        lines = [self._make_line(p, q, u) for (p, q, u) in line_specs]
        total = sum(line[2]['price_subtotal_incl'] for line in lines)
        return {
            'uuid': order_uuid,
            'access_token': order_uuid,  # _process_order does `del order['access_token']`
            'name': 'Order %s' % order_uuid,
            'session_id': session.id,
            'table_id': table_id,
            'state': state,
            'lines': lines,
            'payment_ids': [],
            'amount_paid': 0.0,
            'amount_return': 0.0,
            'amount_tax': 0.0,
            'amount_total': total,
            'date_order': fields.Datetime.to_string(fields.Datetime.now()),
            'fiscal_position_id': False,
            'pricelist_id': self.main_pos_config.pricelist_id.id,
            'partner_id': False,
            'user_id': self.env.uid,
            'to_invoice': False,
            'last_order_preparation_change': '{}',
        }
