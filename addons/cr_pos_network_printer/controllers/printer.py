# -*- coding: utf-8 -*-
# Part of Creyox Technologies

import time
from odoo import http
from escpos.printer import Network
from PIL import Image
from io import BytesIO
import base64
import logging
import socket
import threading

_logger = logging.getLogger(__name__)

# Global dictionary to store locks for each printer
cr_printer_locks = {}
cr_last_drawer_open = {}


class CrPrinterController(http.Controller):
    @http.route("/cr_print_receipt", type="jsonrpc", auth="none", cors="*")
    def cr_print_receipt(self, receipt, attempt=1):
        """
        Print receipt to thermal printer using ESC/POS commands.

        Args:
            receipt (dict): Contains 'ip', 'port', and 'img' (base64 encoded)
            attempt (int): Current retry attempt number

        Returns:
            bool: True if successful, False otherwise
        """
        ip = receipt.get("ip")
        port = receipt.get("port")

        # Validate required parameters
        if not ip or not port:
            _logger.error("`print_receipt`: Missing IP or port in receipt data")
            return False

        ip_key = f"{ip}:{port}"
        lock = cr_printer_locks.setdefault(ip_key, threading.Lock())

        # Check if drawer was recently opened and add safety delay
        if ip_key in cr_last_drawer_open:
            time_since_drawer = time.time() - cr_last_drawer_open[ip_key]
            if time_since_drawer < 1.0:  # If less than 1 second ago
                wait_time = 1.0 - time_since_drawer
                _logger.info(f"`print_receipt`: Waiting {wait_time:.2f}s for drawer operation to complete on {ip_key}")
                time.sleep(wait_time)

        with lock:
            _logger.info(f"`print_receipt`: Preparing print job for {ip_key} (Attempt {attempt})...")
            printer = None

            try:
                # Decode the image
                raw_image = receipt.get("img")
                if not raw_image:
                    _logger.error(f"`print_receipt`: No image data provided for {ip_key}")
                    return False

                image = Image.open(BytesIO(base64.b64decode(raw_image)))

                _logger.info(f"`print_receipt`: Connecting to printer {ip_key}...")
                printer = Network(ip, port, timeout=5)

                _logger.info(f"`print_receipt`: Printing to printer {ip_key}...")

                # Try to set center alignment if supported
                try:
                    # ESC/POS command for center alignment: ESC a 1
                    printer._raw(b"\x1b\x61\x01")  # Center align
                    printer.image(image)
                    printer._raw(b"\x1b\x61\x00")  # Left align (reset)
                    printer.print_and_feed(3)
                except AttributeError:
                    # If _raw method not available, fall back to default
                    _logger.info(f"`print_receipt`: Center alignment command not available for {ip_key}")
                    printer.image(image)
                    printer.print_and_feed(3)

                printer.cut()
                time.sleep(0.5)

                _logger.info(f"`print_receipt`: Print job to {ip_key} completed successfully.")
                return True

            except Exception as e:
                _logger.exception(f"`print_receipt`: Error while printing to {ip_key} [Attempt {attempt}]: {e}")
                # Don't retry here - will be handled outside the lock

            finally:
                # Ensure proper cleanup of printer connection
                if printer:
                    try:
                        # Attempt graceful socket shutdown
                        if (
                            hasattr(printer, "device")
                            and hasattr(printer.device, "connection")
                            and hasattr(printer.device.connection, "socket")
                        ):
                            try:
                                printer.device.connection.socket.shutdown(
                                    socket.SHUT_RDWR
                                )
                            except (OSError, AttributeError) as sock_err:
                                _logger.debug(f"`print_receipt`: Socket shutdown not needed for {ip_key}: {sock_err}")

                            try:
                                printer.device.connection.socket.close()
                            except (OSError, AttributeError) as sock_err:
                                _logger.debug(f"`print_receipt`: Socket close not needed for {ip_key}: {sock_err}")

                        # Close printer connection
                        printer.close()
                    except Exception as close_err:
                        _logger.warning(f"`print_receipt`: Error during printer cleanup for {ip_key}: {close_err}")

                    # Give OS time to release socket
                    time.sleep(0.4)

        # Retry logic OUTSIDE the lock to avoid deadlock and ensure proper cleanup
        if attempt < 2:
            _logger.info(f"`print_receipt`: Retrying print to {ip_key} (Attempt {attempt + 1})...")
            time.sleep(1)
            return self.cr_print_receipt(receipt, attempt + 1)
        else:
            _logger.warning(f"`print_receipt`: Max retries reached for {ip_key}. Giving up.")
            return False

    @http.route("/open_cash_drawer", type="jsonrpc", auth="none", cors="*")
    def open_cash_drawer(self, printer):
        """
            Open cash drawer connected to the thermal printer.
        """
        ip = printer.get("ip")
        port = printer.get("port")

        # Validate required parameters
        if not ip or not port:
            _logger.error("`open_cashbox`: Missing IP or port in printer data")
            return False

        ip_key = f"{ip}:{port}"
        lock = cr_printer_locks.setdefault(ip_key, threading.Lock())

        with lock:
            _logger.info(f"`open_cashbox`: Preparing to open cash drawer for {ip_key}...")
            printer_conn = None

            try:
                _logger.info(f"`open_cashbox`: Connecting to printer {ip_key}...")
                printer_conn = Network(ip, port, timeout=5)

                _logger.info(f"`open_cashbox`: Sending open cash drawer command to {ip_key}...")

                # ESC/POS command to open cash drawer: ESC p 0 25 250
                printer_conn._raw(b"\x1b\x70\x00\x19\xfa")
                time.sleep(0.3)

                _logger.info(f"`open_cashbox`: Cash drawer command sent to {ip_key} successfully.")

                # NEW: Record when drawer was opened
                cr_last_drawer_open[ip_key] = time.time()

                return True

            except Exception as e:
                _logger.exception(f"`open_cashbox`: Error while opening cash drawer for {ip_key}: {e}")
                return False

            finally:
                # Ensure proper cleanup of printer connection
                if printer_conn:
                    try:
                        # Attempt graceful socket shutdown
                        if (
                                hasattr(printer_conn, "device")
                                and hasattr(printer_conn.device, "connection")
                                and hasattr(printer_conn.device.connection, "socket")
                        ):
                            try:
                                printer_conn.device.connection.socket.shutdown(
                                    socket.SHUT_RDWR
                                )
                            except (OSError, AttributeError) as sock_err:
                                _logger.debug(
                                    f"`open_cashbox`: Socket shutdown not needed for {ip_key}: {sock_err}"
                                )

                            try:
                                printer_conn.device.connection.socket.close()
                            except (OSError, AttributeError) as sock_err:
                                _logger.debug(
                                    f"`open_cashbox`: Socket close not needed for {ip_key}: {sock_err}"
                                )

                        # Close printer connection
                        printer_conn.close()
                    except Exception as close_err:
                        _logger.warning(
                            f"`open_cashbox`: Error during printer cleanup for {ip_key}: {close_err}"
                        )

                    # Critical delay for socket release
                    time.sleep(0.5)
