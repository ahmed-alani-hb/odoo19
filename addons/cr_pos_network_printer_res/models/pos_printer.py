# -*- coding: utf-8 -*-
# Part of Creyox Technologies

from odoo import fields, models, api, _
from odoo.exceptions import ValidationError


class PosPrinter(models.Model):
    _inherit = 'pos.printer'

    printer_type = fields.Selection(selection_add=[('cr_network_printer', 'Use an Custom Network printer')])
    cr_network_printer_ip = fields.Char(
        string='Network Printer IP', default='192.168.1.87')
    cr_network_printer_port = fields.Char(
        string='Network Printer Port', default='9100')

    @api.constrains('cr_network_printer_ip')
    def _constrains_cr_network_printer_ip(self):
        for record in self:
            if record.printer_type == 'cr_network_printer' and not record.cr_network_printer_ip:
                raise ValidationError(_("Custom Network Printer IP Address cannot be empty."))

    @api.model
    def _load_pos_data_fields(self, config_id):
        params = super()._load_pos_data_fields(config_id)
        params += ['cr_network_printer_ip', 'cr_network_printer_port']
        return params
