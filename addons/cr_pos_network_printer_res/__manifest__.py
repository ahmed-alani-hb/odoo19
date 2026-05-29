# -*- coding: utf-8 -*-
# Part of Creyox Technologies

{
    'name': 'POS Network Printer | POS Order Receipt Printer | POS Kitchen Receipt Printers | ESC/POS Printer',
    'version': '19.0.0.0',
    "author": "Creyox Technologies",
    "website": "https://www.creyox.com",
    "support": "support@creyox.com",
    'live_test_url': 'https://www.creyox.com/helpdesk?module_tech_name=cr_pos_network_printer_res&version=19.0',
    'category': 'Sales/Point of Sale',
    'sequence': 10,
    'summary': """
        This module allow users to direct print the PoS order receipt within the same network,
        POS Network Printer,
        POS Network Printer in Odoo,
        IP Network Printer Drivers,
        IP Network Printer Drivers in Odoo,
        ESC/POS Printer in Odoo,
        ESC/POS Printer,
        Direct Printer PoS Order Receipt,
        Direct Printer PoS Order Receipt in Odoo,
        Direct Printer PoS Invoice Receipt,
        Direct Printer PoS Invoice Receipt in Odoo,
        Direct Printer PoS Restaurant Receipt in Odoo,
        Direct Printer PoS Restaurant Receipt,
        Best Network Printer in Odoo,
    """,
    'description': """

IP network ESC/POS printer drivers for point-of-sale
enables the use of your IP-based ESC/POS printer in conjunction with Odoo Point of Sale
You won't need an IoT Box after installing this app to print POS tickets and receipts.
Installing this app only requires connecting your POS printer to the same network as your Odoo POS.
Set the printer's IP address and port using the Point of Sale configuration menu.

""",
    'depends': ['cr_pos_network_printer', 'pos_restaurant'],
    'data': [
        'views/pos_printer_views.xml',
    ],
    'installable': True,
    'auto_install': True,
    'application': True,
    'assets': {
        'point_of_sale._assets_pos': [
            'cr_pos_network_printer_res/static/src/**/*',
        ],
    },
    "license": "OPL-1",
    "images": ["static/description/banner.png", ],
    "price": 21,
    "currency": "USD"
}
