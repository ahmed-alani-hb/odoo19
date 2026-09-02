# Part of Honey Bird. See LICENSE file for full copyright and licensing details.
{
    'name': 'POS Network Printer — Client-side (Odoo.sh compatible)',
    'version': '19.0.1.0.0',
    'category': 'Sales/Point of Sale',
    'author': 'Honey Bird',
    'website': 'https://honey-bird.net',
    'summary': 'Drive creyox cr_network_printer devices CLIENT-SIDE (browser→printer via Epson ePOS) '
               'so kitchen/receipt printing works on the Odoo.sh cloud.',
    'description': """
POS Network Printer — Client-side bridge
========================================

The creyox *cr_pos_network_printer* modules print **server-side**: the Odoo server
opens a TCP socket to the printer's LAN IP. That cannot work when Odoo runs on
**Odoo.sh (cloud)**, because the cloud server cannot reach private LAN printers.

This add-on reroutes every printer of type *cr_network_printer* (kitchen printers
and the receipt/bill printer) through Odoo's **native Epson ePOS-Print** driver,
which prints **from the browser** (the browser is on the restaurant LAN). The
cloud server is never involved in the socket, so printing works on Odoo.sh.

REQUIREMENT
-----------
The printers must expose the **Epson ePOS-Print HTTP API**
(``http(s)://<printer-ip>/cgi-bin/epos/service.cgi``) — i.e. Epson TM-series
"intelligent"/ePOS printers, or printers that emulate that API. Generic
ESC/POS-over-raw-9100-only printers **cannot** be driven from a browser (browsers
have no raw TCP); those require an Odoo IoT Box or a local print-relay agent.

HTTPS note
----------
The Odoo.sh page is HTTPS, so the browser must reach the printer over HTTPS too:
either accept the printer's certificate once per POS device (visit
``https://<printer-ip>``), or enable Chrome **Local Network Access** and run Odoo
with ``use_lna`` so it can call the local HTTP device from the HTTPS page.

Reversible: uninstall this module to fall back to creyox's server-side printing.
""",
    'depends': ['cr_pos_network_printer_res'],
    'assets': {
        'point_of_sale._assets_pos': [
            'cr_pos_network_printer_clientside/static/src/**/*',
        ],
    },
    'installable': True,
    'license': 'LGPL-3',
}
