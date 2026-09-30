import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSystemSettings, SettingsValidationError, updateSystemSettings } from "../../modules/settings/systemSettings.js";
import { MailerNotConfiguredError, sendTestEmail } from "../../modules/email/mailer.js";
import { classifySmtpError } from "../../modules/destinations/executors/smtpErrors.js";
import { ValidationError } from "../errors/ApiError.js";
import { serializeSettings } from "../serializers/settingsSerializer.js";
import { updateSettingsBodySchema } from "../schemas/settings.js";
import { requireSuperAdmin } from "../plugins/requirePermission.js";

/**
 * Registered inside the tenant-scoped child for consistency with every other
 * route module, but these settings are genuinely GLOBAL (not per-organization)
 * — request.tenantId is never read here. superAdmin-only (requireSuperAdmin),
 * same reasoning as organization creation: there's no per-organization
 * Membership concept that could apply to "the whole system's SMTP settings."
 */
export function registerSettingsRoutes(app: FastifyInstance): void {
  app.get("/api/v1/settings", { preHandler: requireSuperAdmin }, async () => {
    return serializeSettings(await getSystemSettings());
  });

  app.patch("/api/v1/settings", { preHandler: requireSuperAdmin }, async (request) => {
    const body = updateSettingsBodySchema.parse(request.body);
    try {
      return serializeSettings(await updateSystemSettings(body, request.user?.email));
    } catch (error) {
      if (error instanceof SettingsValidationError) throw new ValidationError(error.message, { field: "smtpSecure", confirmable: true });
      throw error;
    }
  });

  // Sends one real email with the SAVED settings. Defaults to the caller's
  // own address. Always 200 — a failed send is a result to show, not an API
  // error — with a plain-language hint for the common failures.
  app.post("/api/v1/settings/smtp-test", { preHandler: requireSuperAdmin }, async (request) => {
    const body = z.object({ to: z.string().email().optional() }).strict().parse(request.body ?? {});
    const to = body.to ?? request.user?.email;
    if (!to) throw new ValidationError("No recipient: pass \"to\"");
    try {
      await sendTestEmail(to);
      return { ok: true, to };
    } catch (error) {
      if (error instanceof MailerNotConfiguredError) return { ok: false, to, errorClass: "not_configured", message: "SMTP host is not set.", hint: "Enter an SMTP host and save first." };
      const failure = classifySmtpError(error);
      return { ok: false, to, errorClass: failure.errorClass, message: failure.message, hint: smtpHint(failure.errorClass, failure.message) };
    }
  });
}

function smtpHint(errorClass: string, message: string): string | undefined {
  if (/wrong version number|ssl3_get_record|tls_validate_record_header/i.test(message)) {
    return 'TLS mismatch: port 587 needs "implicit TLS" off, port 465 needs it on.';
  }
  if (errorClass === "smtp_auth") return "The server rejected the username or password. Some providers need an app password.";
  if (errorClass === "connection") return "Couldn't reach the server. Check the host and port, and that the server allows connections from here.";
  if (errorClass === "smtp_rejected") return "The server refused the message. Check the From address is one this account may send as.";
  return undefined;
}
