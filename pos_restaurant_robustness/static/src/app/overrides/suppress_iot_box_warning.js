/** @odoo-module */
import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import { dialogService } from "@web/core/dialog/dialog_service";

/**
 * Suppress the purely-informational "IoT Box Warning" modal.
 *
 * The Enterprise `pos_iot` module pops a blocking AlertDialog
 * (IotHttpService._longpolling) EVERY time the POS can't reach the IoT Box over
 * the local network and falls back to the websocket path. That fallback is
 * automatic and printing keeps working, so the modal needs no action from staff —
 * it just blocks the screen and trains them to dismiss popups. We demote it to a
 * diagnostics event so the (real, useful) signal that the LAN link is degraded is
 * still recorded, without the blocking popup.
 *
 * Why patch the core dialog service instead of `pos_iot` directly: it keeps this
 * change to rock-solid `@web/core` imports only (no Enterprise `@iot` import that
 * could fail to resolve and break the whole POS asset bundle), it works whether or
 * not pos_iot is installed (the match simply never fires without it), and the
 * matcher is wrapped so a failure can only ever fall through to showing the dialog
 * normally — never break other dialogs (including the Retry-print popup).
 *
 * Matched by translated title, so it is language-independent: `_t("IoT Box
 * Warning")` resolves through the same catalog pos_iot used to build it.
 */
export function isIotBoxFallbackWarning(props) {
    return Boolean(props && props.title === _t("IoT Box Warning"));
}

patch(dialogService, {
    start(env) {
        const service = super.start(...arguments);
        const originalAdd = service.add;
        service.add = (dialogClass, props, options = {}) => {
            try {
                if (isIotBoxFallbackWarning(props)) {
                    env.services.pos?.logRobustnessEvent?.("iot_box_fallback", null, {
                        severity: "warning",
                        message:
                            "POS could not reach the IoT Box over the LAN and fell back to websocket (printing still works). Suppressed the blocking IoT Box Warning popup.",
                    });
                    // Return a no-op close handle, matching add()'s return type.
                    return () => {};
                }
            } catch {
                // Never let the suppression logic break dialogs.
            }
            return originalAdd(dialogClass, props, options);
        };
        return service;
    },
});
