# Part of Odoo. See LICENSE file for full copyright and licensing details.
{
    'name': 'POS Restaurant Kitchen Printing Robustness',
    'version': '19.0.1.0.0',
    'category': 'Sales/Point of Sale',
    'author': 'Odoo S.A.',
    'summary': 'Robust kitchen printing plus observability/logging and testing tools for POS Restaurant',
    'description': """
POS Restaurant Robustness
=========================

A removable add-on that hardens the restaurant kitchen-printing flow and adds
durable, filterable observability so you can verify the stability of the POS,
especially during rush hours.

What it does
------------
* **Duplicate kitchen tickets fix (durable sent-state)**: an order's items are
  marked "sent to the kitchen" and that state is persisted to the server on every
  send, even when the print times out/fails. This prevents a page refresh or a
  second device from re-sending and printing a duplicate ticket (the common
  failure when the POS falls back to the slow Odoo.sh websocket relay). Genuine
  print failures stay recoverable via the Retry/Reprint popup.
* **Double-send guard**: a per-order in-flight guard prevents rapid
  double-clicks / parallel sends from printing the same ticket twice.
* **Observability**: a ``pos.order.event`` log records kitchen-print and
  order-sync events (frontend and backend), with a list / pivot / graph view
  under *Point of Sale > Reporting > Kitchen Diagnostics*.
* **Testing tools**: UI tours and a pure-Python concurrency simulator that
  reproduce and guard the print-failure, double-send and multi-employee
  table scenarios.

All changes are additive (JS ``patch()`` / Python ``_inherit`` + ``super()``);
uninstalling the module fully restores stock behaviour.
""",
    'depends': ['pos_restaurant'],
    'data': [
        'security/ir.model.access.csv',
        'views/pos_order_event_views.xml',
        'views/pos_order_event_menus.xml',
        'data/pos_order_event_data.xml',
    ],
    'assets': {
        'point_of_sale._assets_pos': [
            'pos_restaurant_robustness/static/src/app/**/*',
        ],
        'web.assets_tests': [
            'pos_restaurant_robustness/static/tests/tours/**/*',
        ],
        'point_of_sale.assets_debug': [
            'pos_restaurant_robustness/static/tests/tours/**/*',
        ],
        'web.assets_unit_tests': [
            'pos_restaurant_robustness/static/tests/unit/**/*',
        ],
    },
    'installable': True,
    'license': 'LGPL-3',
}
