# -*- coding: utf-8 -*-
# Part of Creyox Technologies

from odoo import fields, models


class PosConfig(models.Model):
    _inherit = "pos.config"

    cr_network_printer_ip = fields.Char(string="Network Printer IP", default="192.168.1.87")
    cr_network_printer_port = fields.Char(string="Network Printer Port", default="9100")
