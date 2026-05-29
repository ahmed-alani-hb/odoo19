To: apps@odoo.com (and/or your Odoo support ticket)
Subject: Apps Store request — please indicate Odoo.sh (cloud) compatibility for POS hardware/printing apps

Hello Odoo Apps team,

We are an Odoo customer migrating our restaurant POS to **Odoo.sh**. We'd like to
raise a constructive request about App Store compatibility information, based on a
real and costly surprise we hit.

THE ISSUE
We purchased a third-party POS network-printer app marketed as "print to IP-based
ESC/POS printers — no IoT Box needed." After buying and reviewing it, we found it
prints **server-side**: the Odoo server itself opens a TCP socket to the printer's
LAN IP. That is fine on a local/on-premise Odoo server, but it is **fundamentally
incompatible with Odoo.sh**, where the Odoo server is in the cloud and cannot reach
a customer's private LAN printers. Nothing in the listing indicated this, and it is
not obvious to a non-developer buyer.

OUR REQUEST
Please make **Odoo.sh (cloud) compatibility** explicit on App Store listings —
ideally a clear indicator/badge or a required field — especially for apps that:
- open network sockets or talk to hardware **from the server side**, or otherwise
  assume the Odoo server is on the customer's local network;
- declare server-side `external_dependencies` for device I/O (e.g. python-escpos);
- provide POS/printing/IoT functionality.

A simple "Works on Odoo.sh: yes / no / with a local bridge" signal would prevent
buyers like us from purchasing apps that cannot run on our chosen hosting, and would
push authors toward client-side or IoT-Box-compatible designs.

SECONDARY (security) NOTE
We also noticed such hardware apps can expose unauthenticated HTTP endpoints
(`auth="none"`) that open sockets to arbitrary host:port supplied by the caller — an
SSRF/abuse risk that is much more serious on an internet-facing Odoo.sh instance
than on a LAN-only server. Some review guidance or a policy nudge for hardware
endpoints (require authentication, validate targets) would improve safety for
Odoo.sh customers.

We're big fans of Odoo.sh and want to keep building on it — clearer cloud
compatibility on the Apps Store would make that much smoother.

Thank you,
[Your name]
Honey Bird
admin@honey-bird.net
[Odoo.sh subscription / database name, if available]
