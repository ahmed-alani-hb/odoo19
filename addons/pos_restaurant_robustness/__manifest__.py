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
* **Clear, duplicate-safe print-failure messages**: failures are routed by cause.
  A *definite no-print* (printer offline / out of paper / cover open) shows a
  blocking popup whose Retry re-sends ONLY the printers that truly didn't print.
  An *ambiguous timeout* (the IoT Box was reached but didn't confirm in time — the
  ticket most likely printed) shows a non-blocking notice and does NOT offer Retry,
  because retrying a job that already printed would duplicate it. The wording names
  the real culprit instead of blaming the IoT Box for a printer problem.
* **No more blocking "IoT Box Warning" popup**: the informational modal that
  Enterprise pos_iot raises every time the POS falls back from the local network to
  the websocket path (which keeps working) is demoted to a Kitchen Diagnostics
  event, so staff are no longer interrupted by a popup that needs no action. Done
  with a fail-safe hook on the core dialog service (it can only ever fall through to
  showing the dialog, never break other popups such as Retry-print).
* **Failed kitchen prints, surfaced on the table**: instead of a transient popup
  that's easy to miss (a printer that times out never showed one), any ticket that
  fails to print is recorded on the order and shown as a small warning bubble on
  the table in the floor screen. Opening the table presents a panel to Retry
  (reprints ONLY the printers that failed — never duplicating a ticket that already
  came out) or Clear each failed print, with each entry labelled "didn't print"
  (safe to retry) or "may have printed" (retry only if nothing came out). Device-
  local (survives a refresh on that device).
* **No silent kitchen prints (optimistic-send hardening)**: the fast "mark sent +
  print in the background" path could leave a ticket silently unprinted if the IoT
  print never reported back (promise hung forever) or the screen was refreshed
  before it settled — the order showed as sent with nothing printed and nothing
  flagged. Now every send writes a persisted "unconfirmed" marker the instant it is
  dispatched; the background print is bounded by a timeout (~25s) that converts the
  marker to a surfaced failure if no confirmation arrives, a confirmed print clears
  it, and a startup sweep surfaces any markers orphaned by a refresh/crash. A
  persistent on-screen alert banner (table + printer + reason), shown on every
  screen and clearing only when retried/dismissed, makes a delayed failure
  impossible to miss mid-rush.
* **IoT Box: stop kitchen print queues getting permanently stuck**: the Odoo IoT
  Box adds printers to CUPS with no error policy, so CUPS' default 'stop-printer'
  pauses the queue on the first failed job (printer briefly off / no paper / cover
  open) and never re-enables it — nothing prints, even after the printer is back,
  until the Box is restarted. A small IoT handler shipped with this module (served
  to the Box via /iot/get_handlers, see static/src/iot_handlers/) runs a guarded
  background watchdog on the Box that sets every printer's error policy to
  'retry-job' (a failed job retries instead of pausing the queue) and re-enables any
  queue CUPS has already stopped. Purely additive and fully wrapped, so it can never
  disturb normal printing; remove the file + restart the Box to revert.
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
