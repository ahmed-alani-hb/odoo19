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
* **Duplicate & lost kitchen ticket fix (smart sent-state)**: kitchen-print
  failures are classified. An *ambiguous* failure (e.g. an IoT timeout, which
  usually means it DID print) marks the items sent and persists it, so a refresh or
  a second device can't re-send and duplicate the ticket. A *definite* failure
  (printer unreachable / out of paper / cover open) keeps the items pending so they
  are re-sent and never lost. The Retry/Reprint popup covers both.
* **Self-healing double-send guard**: a per-order in-flight guard prevents rapid
  double-clicks / parallel sends from printing the same ticket twice, and
  auto-releases after 30s so a hung IoT print / order-sync can never freeze the
  Send button until a page refresh (that refresh was what caused a duplicate).
* **Concurrent-send merge**: when two devices send to the kitchen for the same
  order at the same moment, the server MERGES their sent-states (union of lines)
  instead of discarding the older one, so neither device re-sends and duplicates
  the ticket. (Validate in staging with two devices before production.)
* **Snappy, multi-device-correct Send**: a normal send marks the order sent and
  pushes that state to the server SYNCHRONOUSLY (before the table closes), then
  prints the kitchen ticket in the BACKGROUND. The table closes / Send button
  frees immediately without waiting on the IoT printer round-trip, while a second
  device viewing the same table sees the items as sent right away (instead of
  "not sent" until the print finished — which risked a duplicate re-send). If the
  background print is a *definite* failure the sent-state is rolled back so the
  items are re-sent (no lost ticket). (Validate in staging with two devices.)
* **"Close table after sending" option**: a Settings toggle (Point of Sale,
  restaurant mode) controlling whether the POS returns to the floor (closes the
  table) after an order is sent. Turn it off to keep the table open for adding more
  items. Default on (current behaviour).
* **Observability**: a ``pos.order.event`` log records kitchen-print and
  order-sync events (frontend and backend), with a list / pivot / graph view
  under *Point of Sale > Reporting > Kitchen Diagnostics*.
* **Testing tools**: Hoot unit tests (kitchen-print failure classification,
  durable sent-state, double-send guard) plus a pure-Python concurrency
  simulator and event-log model tests.

All changes are additive (JS ``patch()`` / Python ``_inherit`` + ``super()``);
uninstalling the module fully restores stock behaviour.
""",
    'depends': ['pos_restaurant'],
    'data': [
        'security/ir.model.access.csv',
        'views/res_config_settings_views.xml',
        'views/pos_order_event_views.xml',
        'views/pos_order_event_menus.xml',
        'data/pos_order_event_data.xml',
    ],
    'assets': {
        'point_of_sale._assets_pos': [
            'pos_restaurant_robustness/static/src/app/**/*',
        ],
        'web.assets_unit_tests': [
            'pos_restaurant_robustness/static/tests/unit/**/*',
        ],
    },
    'installable': True,
    'license': 'LGPL-3',
}
