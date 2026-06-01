# IoT Printing — Slow / "cannot contact your IoT" / "Timeout waiting for IoT Box"

**Setup:** Odoo backend on **Odoo.sh (cloud)** · **Windows Virtual IoT** on a Windows 11 PC on the
restaurant LAN · **Xprinter** ESC/POS printers · POS on the Windows PC **and** Android tablets.

## What the symptoms mean
- **"POS cannot contact your IoT through the local network — fallback with web socket connection"**
  → the device's browser cannot reach the Virtual IoT **directly on the LAN**, so Odoo relays the
  print job **through Odoo.sh (cloud)**. That fallback is slow.
- **"Barista: Timeout waiting for IoT Box response"** → the slow cloud-relay path didn't get a reply
  in time, so that kitchen ticket timed out.

## Why the PC works but the Android tablet doesn't
The PC **is** the Virtual IoT host, so its POS reaches the printer via `localhost` — which bypasses
the Windows firewall *and* the HTTPS-certificate check. A separate Android tablet must instead cross
the PC's **Windows firewall** and connect over **HTTPS with a valid/trusted certificate**. If either
fails, that device is forced onto the slow cloud fallback → delays + timeouts.

## One quick test to isolate the cause
On the **Android tablet's browser**, open: `http://<PC-LAN-IP>:8069`
- **Page does NOT load** → it's the **network/firewall** (Section A). Start there.
- **Page loads (IoT homepage) but printing still falls back** → it's the **HTTPS certificate**
  (Section B), because the POS runs on HTTPS and must reach the IoT over `https://`.

Find `<PC-LAN-IP>` on the PC: `ipconfig` → IPv4 Address (e.g. 192.168.1.50).

---

## Section A — make the Virtual IoT reachable on the LAN (fixes the slow Android path)
1. **Windows Firewall — allow inbound ports.** On the PC: *Windows Defender Firewall with Advanced
   Security → Inbound Rules → New Rule → Port → TCP → 8069, 80, 443 → Allow → tick **Private**.*
   (This is the #1 cause: the PC's own localhost isn't firewalled, but other devices are blocked.)
2. **Set the network profile to "Private"** (Settings → Network → Wi‑Fi → your network → Private),
   not Public — Public blocks inbound LAN connections.
3. **Same Wi‑Fi / same subnet, no isolation.** Put the tablets and the PC on the **same** Wi‑Fi, and
   on the router/access point **disable "AP isolation" / "client isolation"** (common on guest and
   business Wi‑Fi — it blocks device‑to‑device traffic).
4. **Give the PC a fixed IP** (DHCP reservation on the router) so the IoT address never changes.
5. Re‑run the test above. `http://<PC-LAN-IP>:8069` should load from the tablet.

## Section B — fix the HTTPS certificate (needed for direct HTTPS from the tablets)
The POS page is HTTPS (Odoo.sh), so each device must reach the IoT over HTTPS with a trusted cert.
The Virtual IoT obtains this automatically (an `…​.odoo-iot.com` certificate) by contacting odoo.com
on restart. Common blockers:
1. **IoT subscription required.** A valid IoT HTTPS certificate needs an **active IoT subscription
   line** on the Odoo.sh database. Without it, no cert is issued → permanent slow fallback. Check
   your Odoo subscription; add an IoT line if missing.
2. **Don't install the Virtual IoT under a user folder.** Odoo explicitly warns that installing it in
   `C:\Users\…` breaks certificate generation. Install it in e.g. `C:\odoo` (reinstall if needed).
3. **Let the certificate generate.** A firewall/AV can block the cert request to odoo.com. Temporarily
   allow it, **restart the IoT service**, and confirm on the IoT homepage that the certificate is
   valid. The IoT homepage also shows its HTTPS address.
4. On each Android tablet once: open `https://<PC-LAN-IP>` (or the IoT's `…odoo-iot.com` address) and
   confirm it loads without a certificate warning.

## After A + B
- The **"cannot contact your IoT"** warning should disappear — the POS now talks to the IoT
  **directly on the LAN** instead of via the cloud, so printing is fast on the tablets too.

## If printing is still a bit slow (even on the PC)
- **Receipt rendering:** Odoo renders receipts/tickets as **images** (HTML → bitmap). Heavy logos,
  large images, or complex layouts make this slow. Simplify the receipt/kitchen-ticket layout and
  remove large images to speed it up.
- **ESC* raster fallback:** if a specific Xprinter prints rasters slowly or wrong, set its name on the
  IoT using Odoo's `…__IMC_<params>__` convention to force the `ESC *` image command.
- **Printer link:** in POS settings, confirm each kitchen printer points to the correct **IoT device**
  (not a stale/duplicate entry).

## Note on the "Printing failed — Continue / Retry" dialog
That dialog is Odoo's **native** kitchen‑print failure handling (and what `pos_restaurant_robustness`
hardens). It is a *safety net for genuine transient failures* — it is **not** the fix for this issue.
The real fix is Sections A + B, which stop the failures from happening in the first place.

## Sources
- Odoo 19 — Windows virtual IoT (firewall ports 8069/80/443; don't install under a user dir):
  https://www.odoo.com/documentation/19.0/applications/general/iot/windows_iot.html
- Odoo 19 — IoT troubleshooting (same network; certificate; firewall blocking cert generation):
  https://www.odoo.com/documentation/19.0/applications/general/iot/iot_advanced/troubleshooting.html
- Odoo — HTTPS certificate (IoT) (cert generated via odoo.com; needs IoT subscription):
  https://www.odoo.com/documentation/19.0/applications/general/iot/iot_advanced/https_certificate_iot.html
- Odoo 19 — IoT system connection to Odoo:
  https://www.odoo.com/documentation/19.0/applications/general/iot/connect.html
