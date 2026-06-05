"""Keep IoT-Box CUPS printers from getting permanently stuck after a printer error.

WHY THIS EXISTS
---------------
The Odoo IoT Box adds printers to CUPS without a ``printer-error-policy``
(see ``iot_drivers/iot_handlers/interfaces/printer_interface_L.py`` ->
``set_up_printer_in_cups`` which calls ``enablePrinter``/``acceptJobs`` only at
detection time and never sets an error policy). CUPS therefore uses its default
``stop-printer`` policy: the first failed job — e.g. a kitchen printer that was
briefly powered off, out of paper, or had its cover open — **pauses that print
queue**, and nothing in the Box ever re-enables it. Result: nothing prints, even
after the printer is back on, until the Box is restarted.

WHAT THIS DOES
--------------
This file is an IoT *handler*: the Box downloads it from the connected Odoo server
(``/iot/get_handlers``) and executes it (``helpers.load_iot_handlers``). It starts a
single, guarded background thread that every few seconds:

  1. sets each CUPS printer's error policy to ``retry-job`` so a failed job is
     retried (queue stays enabled) instead of pausing the queue; and
  2. re-enables and resumes any printer queue CUPS has already stopped — which also
     auto-recovers a queue that is *currently* stuck.

It is **purely additive**: it does not touch the Box's own setup/print paths, and
every CUPS call is wrapped, so if anything is unavailable (non-CUPS system, API
change, transient error) it simply logs at debug and no-ops — it can never break
normal printing. ``_L`` suffix => loaded on Linux (Raspberry Pi) IoT Boxes.

To disable: remove this file from the module and let the Box re-download handlers
(restart the Box), which reverts to stock behaviour.
"""
import logging
import threading
import time

_logger = logging.getLogger(__name__)

_THREAD_NAME = "pos_robustness_cups_retry_policy"
# Apply the policy quickly after boot so a printer can't pause before retry-job is
# set, then keep re-asserting it fast: the Box resets the policy whenever it
# (re)detects a printer, so frequent passes both prevent the pause and auto-resume
# any queue within a few seconds — no Box restart ever needed.
_INITIAL_DELAY_SECONDS = 5
_POLL_SECONDS = 10
_CUPS_STATE_STOPPED = 5  # IPP printer-state: 3=idle, 4=processing, 5=stopped


def _apply_once():
    """One pass: enforce retry-job + resume any stopped queue. Best-effort."""
    # Imported lazily: the Box loads interfaces before drivers, and we also delay the
    # first pass, so ``conn``/``cups_lock`` (module-level in the printer interface) are
    # ready. Reusing them keeps us consistent with the driver's own CUPS locking.
    from odoo.addons.iot_drivers.iot_handlers.interfaces.printer_interface_L import (
        conn,
        cups_lock,
    )

    with cups_lock:
        printers = conn.getPrinters()

    for name, attrs in printers.items():
        try:
            with cups_lock:
                if attrs.get("printer-error-policy") != "retry-job":
                    try:
                        conn.setPrinterErrorPolicy(name, "retry-job")
                    except Exception:
                        # Older/alternate pycups: fall back to the option default.
                        conn.addPrinterOptionDefault(
                            name, "printer-error-policy", "retry-job"
                        )
                if attrs.get("printer-state") == _CUPS_STATE_STOPPED:
                    conn.enablePrinter(name)
                    conn.acceptJobs(name)
                    _logger.info(
                        "pos_restaurant_robustness: re-enabled stopped CUPS printer %s",
                        name,
                    )
        except Exception as e:  # noqa: BLE001 - never let one printer break the rest
            _logger.debug(
                "pos_restaurant_robustness: could not update printer %s: %s", name, e
            )


def _loop():
    # First pass shortly after boot (gives the Box time to import the printer
    # interface and detect printers), then keep enforcing it on a tight interval.
    time.sleep(_INITIAL_DELAY_SECONDS)
    while True:
        try:
            _apply_once()
        except Exception as e:  # noqa: BLE001 - watchdog must never die/affect printing
            _logger.debug("pos_restaurant_robustness: retry-policy pass failed: %s", e)
        time.sleep(_POLL_SECONDS)


# Start exactly once, even if the Box re-loads handlers (which re-executes this file).
try:
    if not any(t.name == _THREAD_NAME for t in threading.enumerate()):
        threading.Thread(target=_loop, name=_THREAD_NAME, daemon=True).start()
        _logger.info(
            "pos_restaurant_robustness: CUPS retry-job / auto-resume watchdog started"
        )
except Exception as e:  # noqa: BLE001
    _logger.warning(
        "pos_restaurant_robustness: could not start CUPS watchdog: %s", e
    )
