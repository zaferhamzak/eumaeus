import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePermission } from "../plugins/requirePermission.js";
import { NotFoundError, UnauthorizedError, ValidationError } from "../errors/ApiError.js";
import { getSystemSettings } from "../../modules/settings/systemSettings.js";
import { isOAuthProvider, OAuthNotConfiguredError, providerSpec } from "../../modules/mail-providers/oauth/providers.js";
import { completeOAuth, returnPathFor, startOAuth } from "../../modules/mail-providers/oauth/flow.js";
import { OAuthError } from "../../modules/mail-providers/oauth/tokens.js";
import { MailboxValidationError } from "../../modules/mail-providers/imap/manageMailboxConnections.js";
import { logger } from "../../logger.js";

const providerParamSchema = z.object({ provider: z.string() });
const startBodySchema = z
  .object({
    folder: z.string().min(1).max(200).optional(),
    name: z.string().min(1).max(200).optional(),
    mailboxConnectionId: z.string().min(1).max(200).optional(),
    returnTo: z.enum(["organization"]).optional(),
  })
  .strict();

function parseProvider(params: unknown) {
  const { provider } = providerParamSchema.parse(params);
  if (!isOAuthProvider(provider)) throw new NotFoundError(`Unknown sign-in provider "${provider}"`);
  return provider;
}

/**
 * Phase 17, tenant-scoped: which providers are set up, and starting a
 * sign-in. Starting is an XHR (it needs the X-Organization-Id header); the
 * browser then navigates to the returned URL.
 */
export function registerMailboxOAuthRoutes(app: FastifyInstance): void {
  app.get("/api/v1/mailboxes/oauth/providers", { preHandler: requirePermission("mailboxes:read") }, async () => {
    const settings = await getSystemSettings();
    const configured = (p: "google" | "microsoft") => {
      try {
        providerSpec(p, settings);
        return true;
      } catch {
        return false;
      }
    };
    return { google: configured("google"), microsoft: configured("microsoft") };
  });

  app.post("/api/v1/mailboxes/oauth/:provider/start", { preHandler: requirePermission("mailboxes:write") }, async (request) => {
    const provider = parseProvider(request.params);
    const body = startBodySchema.parse(request.body ?? {});
    try {
      return await startOAuth({ provider, tenantId: request.tenantId, userId: request.user!.id, actor: request.user!.email, ...body });
    } catch (error) {
      if (error instanceof OAuthNotConfiguredError) throw new ValidationError(error.message);
      if (error instanceof OAuthError && error.code === "not_found") throw new NotFoundError(error.message);
      throw error;
    }
  });
}

/**
 * Where Google / Microsoft send the browser back. A top-level navigation, so
 * it can't carry X-Organization-Id: it lives outside the tenant scope, and the
 * organization comes from the one-time state instead (which also has to
 * belong to the signed-in user — see flow.ts). Always answers with a redirect
 * back to the Mailboxes page (or the organization's page it was started from),
 * carrying the result for the page to show.
 */
export function registerMailboxOAuthCallbackRoute(app: FastifyInstance): void {
  app.get("/api/v1/mailboxes/oauth/:provider/callback", async (request, reply) => {
    const settings = await getSystemSettings();
    const query = request.query as Record<string, unknown>;
    // Started from an organization's page → back to it; otherwise Mailboxes.
    const path = typeof query.state === "string" ? await returnPathFor(query.state).catch(() => "/mailboxes") : "/mailboxes";
    const back = (params: Record<string, string>) => reply.redirect(`${settings.appBaseUrl.replace(/\/$/, "")}${path}?${new URLSearchParams(params).toString()}`);
    try {
      if (!request.user) throw new UnauthorizedError("Sign in to Eumaeus first, then connect the mailbox again.");
      const provider = parseProvider(request.params);
      if (typeof query.error === "string") {
        // The person declined, or the provider refused the request.
        return back({ oauthError: typeof query.error_description === "string" ? query.error_description : `Sign-in was not completed (${query.error}).` });
      }
      if (typeof query.code !== "string" || typeof query.state !== "string") throw new ValidationError("The sign-in response was incomplete.");
      const result = await completeOAuth({ provider, code: query.code, state: query.state, userId: request.user.id });
      return back({ connected: result.emailAddress, ...(result.created ? {} : { reconnected: "1" }) });
    } catch (error) {
      const known = error instanceof OAuthError || error instanceof OAuthNotConfiguredError || error instanceof MailboxValidationError || error instanceof ValidationError || error instanceof UnauthorizedError || error instanceof NotFoundError;
      if (!known) logger.error({ event: "mailbox_oauth_callback_failed", err: error }, "mailbox OAuth callback failed");
      return back({ oauthError: known ? (error as Error).message : "Connecting the mailbox failed. Try again." });
    }
  });
}
