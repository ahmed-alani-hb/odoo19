To: support@creyox.com
Subject: cr_pos_network_printer (v19) — server-side printing is incompatible with Odoo.sh; please clarify listing + consider a client-side/cloud build

Hello Creyox team,

We are a paying customer using your Odoo 19 apps:
- "Odoo POS Network Printer | Seamless ESC/POS Ticket & Receipt Printing" (cr_pos_network_printer, v19.0.0.8)
- "POS Kitchen Receipt Printers" (cr_pos_network_printer_res, v19)

We are a restaurant migrating from a local Odoo 17 server to Odoo 19 on **Odoo.sh
(cloud)**. During our pre-migration review we found a fundamental limitation we'd
like your help and guidance on.

WHAT WE FOUND
Your modules print **server-side**: the POS browser renders the ticket and calls
the Odoo route `/cr_print_receipt`, and then the **Odoo server** opens a TCP socket
to the printer's LAN IP via `python-escpos` `Network(ip, 9100)`. The cash drawer
(`/open_cash_drawer`) works the same way.

This works perfectly today because our Odoo 17 server sits on the same LAN as the
printers. But on **Odoo.sh the Odoo server runs in the cloud and cannot reach our
private LAN printer IPs (192.168.x.x:9100)** — so kitchen printing, receipt/bill
printing and the cash drawer all stop working. The browser, which IS on the LAN,
never touches the printer in your design.

OUR REQUESTS
1. App Store clarity: your listing markets "no IoT Box needed" and network printing
   without stating that it only works when the **Odoo server is on the same LAN as
   the printers** (i.e. on-premise / local server), and **not on Odoo.sh / cloud**.
   Please add a clear compatibility note so cloud customers know before purchase.
2. Cloud support: please consider a **client-side variant** (browser → printer, e.g.
   via the Epson ePOS-Print HTTP API) or an officially supported **local print-relay
   agent**, so the apps can work on Odoo.sh. Any guidance you can share for Odoo.sh
   customers would be very welcome.
3. Security: the `/cr_print_receipt` and `/open_cash_drawer` controller routes are
   declared `auth="none"` with `cors="*"`, and they will open a socket to **any
   ip:port supplied by the caller**. On an internet-facing Odoo.sh server this is an
   unauthenticated SSRF and a remote cash-drawer-open endpoint. Please require an
   authenticated POS session (`auth="user"`) and validate/whitelist the target IP.

Could you let us know (a) whether a cloud/client-side build is on your roadmap and a
rough timeline, and (b) your recommended setup for driving LAN ESC/POS printers from
an Odoo.sh-hosted POS? We're happy to share more technical detail or test a fix.

Thank you,
[Your name]
Honey Bird
admin@honey-bird.net
[Odoo.sh project / order reference, if available]
