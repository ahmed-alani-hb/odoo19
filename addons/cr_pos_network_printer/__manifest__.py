# -*- coding: utf-8 -*-
# Part of Creyox Technologies
{
    "name": "Odoo POS Network Printer | Seamless ESC/POS Ticket & Receipt Printing",
    "author": "Creyox Technologies",
    "website": "https://www.creyox.com",
    "support": "support@creyox.com",
    'live_test_url': 'https://www.creyox.com/helpdesk?module_tech_name=cr_pos_network_printer&version=19.0',
    "category": "Sales/Point of Sale",
    "summary": """
    The POS Network Printer module for Odoo enables seamless, fast, and reliable receipt printing using 
    any IP-based ESC/POS printer—without needing an IoT Box. This Odoo POS ESC/POS Printer integration 
    allows businesses to connect their thermal receipt printer directly over the same network as their 
    Odoo Point of Sale, ensuring real-time printing of POS orders, bills, and customer receipts. 
    
    Easily configure the printer’s IP address and port from the POS settings and enjoy instant, 
    hassle-free printing with full ESC/POS compatibility. Ideal for retail, restaurants, cafés, supermarkets, 
    salons, and any business using Odoo POS, this solution improves checkout speed, reduces hardware cost, and 
    delivers smooth, uninterrupted printing. Boost POS performance with a powerful Odoo Network Printer integration 
    designed for accuracy, efficiency, and high-speed receipt printing.
    """,
    "license": "OPL-1",
    "version": "19.0.0.8",
    "description": """
    <h1>Odoo Network Printer for POS | Seamless ESC/POS Ticket & Receipt Printing</h1>
    <p>
    The Odoo POS Network Printer module enables fast, seamless, and reliable receipt printing using any IP-based ESC/POS thermal printer. 
    With this integration, you no longer need an IoT Box—simply connect your ESC/POS printer to the same network as your Odoo POS, configure the 
    IP address and port, and start printing receipts, order tickets, and kitchen slips instantly. Designed for high performance and ease of use, 
    this module ensures smooth and uninterrupted POS operations for retail, restaurants, cafés, and supermarkets.
    </p>
    <h2>Key Features</h2>
    <ul>
        <li>Works with any IP-based ESC/POS thermal printer</li>
        <li>Print POS receipts without needing the Odoo IoT Box</li>
        <li>Simple setup—connect the printer to the same network as Odoo POS</li>
        <li>Configure printer IP address and port directly from POS settings</li>
        <li>High-speed, ESC/POS command–compatible printing</li>
        <li>Supports receipts, order tickets, and kitchen/production printing</li>
        <li>Compatible with most popular ESC/POS network printers</li>
        <li>Reliable real-time printing for busy POS environments</li>
        <li>Ideal for retail stores, restaurants, cafés, and supermarkets</li>
    </ul>
    <h2>Benefits</h2>
    <ul>
        <li>Removes the cost and limitations of using the Odoo IoT Box</li>
        <li>Boosts checkout speed with instant receipt printing</li>
        <li>Reduces hardware dependency and simplifies POS setup</li>
        <li>Provides stable and error-free network-based printing</li>
        <li>Improves efficiency in multi-counter POS operations</li>
    </ul>
    <h2>Why Choose This Odoo POS Network Printer Integration?</h2>
    <p>
    This module offers the simplest and most efficient way to integrate IP-based ESC/POS printers with Odoo POS. 
    It ensures fast printing performance, easy configuration, and complete independence from the IoT Box—making it 
    perfect for businesses that need dependable, real-time receipt or order printing. Whether you're running a café, bar, retail shop, 
    or restaurant, this solution enhances your POS experience with smooth, trouble-free printing.
    </p>
    <h2>Related Apps</h2>
    <ul>
        <li><a href="https://apps.odoo.com/apps/modules/17.0/cr_pos_network_printer_all_in_one">All-in-One PoS Network & USB Printers</a></li>
        <li><a href="https://apps.odoo.com/apps/modules/17.0/cr_pos_network_printer_res">POS Kitchen Receipt Printers</a></li>
        <li><a href="https://apps.odoo.com/apps/modules/17.0/cr_pos_discount_limit">POS Discount Limit</a></li>
        <li><a href="httpsapps.odoo.com/apps/modules/17.0/cr_pos_discount">POS Discount</a></li>
        <li><a href="httpsapps.odoo.com/apps/modules/17.0/cr_pos_cash_transfer">Cash Transfer Management For POS</a></li>
    </ul>
    <p>For custom Odoo integrations, POS hardware support, or tailored development, visit <a href="https://creyox.com">creyox.com</a></p>
    <p>Watch the YouTube demo video: <a href="https://www.youtube.com/shorts/CK9iJLZcH7U">Odoo POS Network Printer</a></p>
    <p>Read the full blog post: <a href="https://www.creyox.com/blog/pos-network-printer-11/seamless-fast-receipt-printing-the-ultimate-pos-network-printer-solution-10">Read Blog Post of Odoo POS Network Printer</a></p>
""",
    "depends": ["point_of_sale"],
    "data": [
        "views/res_config_settings_views.xml",
        "views/pos_config_views.xml",
    ],
    "installable": True,
    "auto_install": False,
    "application": True,
    "external_dependencies": {
        "python": ["python-escpos"],
    },
    "assets": {
        "point_of_sale._assets_pos": [
            "cr_pos_network_printer/static/src/**/*",
        ],
    },
    "images": ["static/description/banner.png"],
    "price": 99,
    "currency": "USD",
}
