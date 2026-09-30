import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { SUPPORTED_LOCALES } from "../../modules/i18n/locales.js";
import { loadEnv } from "../../config/env.js";
import { prisma } from "../../db/client.js";
import {
  login,
  loginMfa,
  logout,
  enrollMfa,
  confirmMfa,
  disableMfa,
  acceptInvite,
  changePassword,
  WeakPasswordError,
  InvalidCredentialsError,
  InvalidMfaCodeError,
  InvalidOrExpiredInviteError,
  MfaNotEnrolledError,
  MfaAlreadyEnabledError,
} from "../../modules/auth/authService.js";
import { loginBodySchema, loginMfaBodySchema, mfaConfirmBodySchema, mfaDisableBodySchema, acceptInviteBodySchema, changePasswordBodySchema } from "../schemas/auth.js";
import { UnauthorizedError, ValidationError, RateLimitedError, NotFoundError } from "../errors/ApiError.js";
import { TooManyAttemptsError } from "../../modules/auth/loginThrottle.js";
import { listUserSessions, deleteUserSessionById, deleteAllUserSessions, type SessionMeta } from "../../modules/auth/sessionStore.js";
import { idParamSchema } from "../schemas/common.js";
import { getSystemSettings } from "../../modules/settings/systemSettings.js";
import { completeSso, SSO_STATE_COOKIE, ssoEnabled, SsoError, startSso } from "../../modules/auth/sso.js";
import { isOAuthProvider, OAuthNotConfiguredError } from "../../modules/mail-providers/oauth/providers.js";
import { OAuthError } from "../../modules/mail-providers/oauth/tokens.js";
import { logger } from "../../logger.js";

async function setSessionCookie(reply: FastifyReply, token: string): Promise<void> {
  const env = loadEnv();
  const settings = await getSystemSettings();
  reply.setCookie(env.SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.SESSION_COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
    maxAge: settings.sessionTtlSeconds,
  });
}

function sessionMeta(request: FastifyRequest): SessionMeta {
  const userAgent = request.headers["user-agent"];
  return { ip: request.ip, userAgent: typeof userAgent === "string" ? userAgent.slice(0, 300) : undefined };
}

function currentSessionToken(request: FastifyRequest): string | undefined {
  return request.cookies[loadEnv().SESSION_COOKIE_NAME];
}

/** Maps the auth module's own lockout error to the API's existing 429 shape (same code/Retry-After detail the rate limiter already uses). */
function rethrowLockout(error: unknown): void {
  if (error instanceof TooManyAttemptsError) throw new RateLimitedError(error.message, error.retryAfterSeconds);
}

function clearSessionCookie(reply: FastifyReply): void {
  const env = loadEnv();
  reply.clearCookie(env.SESSION_COOKIE_NAME, { path: "/" });
}

/**
 * Registered at the TOP LEVEL of api/server.ts (outside the tenant-scoped
 * child) — none of these routes have an organization/X-Organization-Id
 * concept: you log in before any organization is selected. Session identity
 * (request.user) is resolved by authContext.ts, which runs for every route
 * including these.
 */
export function registerAuthRoutes(app: FastifyInstance): void {
  // --- Phase 20: single sign-on with Google / Microsoft -------------------
  // Browser navigations, not XHR: start answers with a redirect to the
  // provider, the callback with a redirect back into the app.
  app.get("/api/v1/auth/sso/providers", async () => {
    const settings = await getSystemSettings();
    return { google: ssoEnabled("google", settings), microsoft: ssoEnabled("microsoft", settings) };
  });

  app.get("/api/v1/auth/sso/:provider/start", async (request, reply) => {
    const settings = await getSystemSettings();
    const base = settings.appBaseUrl.replace(/\/$/, "");
    const { provider } = request.params as { provider: string };
    try {
      if (!isOAuthProvider(provider)) throw new SsoError(`Unknown sign-in provider "${provider}"`);
      const { authorizationUrl, state } = await startSso(provider);
      reply.setCookie(SSO_STATE_COOKIE, state, { httpOnly: true, secure: loadEnv().SESSION_COOKIE_SECURE, sameSite: "lax", path: "/api/v1/auth/sso/", maxAge: 600 });
      return reply.redirect(authorizationUrl);
    } catch (error) {
      const known = error instanceof SsoError || error instanceof OAuthNotConfiguredError;
      if (!known) logger.error({ event: "sso_start_failed", err: error }, "SSO start failed");
      return reply.redirect(`${base}/login?${new URLSearchParams({ ssoError: known ? (error as Error).message : "Sign-in could not be started. Try again." })}`);
    }
  });

  app.get("/api/v1/auth/sso/:provider/callback", async (request, reply) => {
    const settings = await getSystemSettings();
    const base = settings.appBaseUrl.replace(/\/$/, "");
    const toLogin = (params: Record<string, string>) => reply.redirect(`${base}/login?${new URLSearchParams(params)}`);
    const browserState = request.cookies[SSO_STATE_COOKIE];
    reply.clearCookie(SSO_STATE_COOKIE, { path: "/api/v1/auth/sso/" });
    const query = request.query as Record<string, unknown>;
    const { provider } = request.params as { provider: string };
    try {
      if (!isOAuthProvider(provider)) throw new SsoError(`Unknown sign-in provider "${provider}"`);
      if (typeof query.error === "string") return toLogin({ ssoError: typeof query.error_description === "string" ? query.error_description : `Sign-in was not completed (${query.error}).` });
      if (typeof query.code !== "string" || typeof query.state !== "string") throw new SsoError("The sign-in response was incomplete.");
      const result = await completeSso({ provider, code: query.code, state: query.state, browserState, meta: sessionMeta(request) });
      if ("pendingToken" in result) return toLogin({ mfaToken: result.pendingToken });
      await setSessionCookie(reply, result.sessionToken);
      return reply.redirect(`${base}/`);
    } catch (error) {
      const known = error instanceof SsoError || error instanceof OAuthError || error instanceof OAuthNotConfiguredError;
      if (!known) logger.error({ event: "sso_callback_failed", err: error }, "SSO callback failed");
      return toLogin({ ssoError: known ? (error as Error).message : "Signing in failed. Try again." });
    }
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
    const body = loginBodySchema.parse(request.body);
    try {
      const result = await login(body.email, body.password, sessionMeta(request));
      if ("sessionToken" in result) {
        await setSessionCookie(reply, result.sessionToken);
        return { mfaRequired: false as const };
      }
      return { mfaRequired: true as const, pendingToken: result.pendingToken };
    } catch (error) {
      rethrowLockout(error);
      if (error instanceof InvalidCredentialsError) throw new ValidationError("Invalid email or password");
      throw error;
    }
  });

  app.post("/api/v1/auth/login/mfa", async (request, reply) => {
    const body = loginMfaBodySchema.parse(request.body);
    try {
      const result = await loginMfa(body.pendingToken, body.code, sessionMeta(request));
      await setSessionCookie(reply, result.sessionToken);
      return { mfaRequired: false as const };
    } catch (error) {
      rethrowLockout(error);
      if (error instanceof InvalidMfaCodeError) throw new ValidationError(error.message);
      throw error;
    }
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const env = loadEnv();
    const token = request.cookies[env.SESSION_COOKIE_NAME];
    if (token) await logout(token, request.user?.id ?? null);
    clearSessionCookie(reply);
    return reply.status(204).send();
  });

  // Phase 21: the signed-in person's language (interface and the emails sent to them).
  app.put("/api/v1/auth/me/locale", async (request) => {
    if (!request.user) throw new UnauthorizedError("Not logged in");
    const { locale } = z.object({ locale: z.enum(SUPPORTED_LOCALES).nullable() }).strict().parse(request.body);
    await prisma.user.update({ where: { id: request.user.id }, data: { locale } });
    return { locale };
  });

  app.get("/api/v1/auth/me", async (request) => {
    if (!request.user) throw new UnauthorizedError("Not logged in");

    const [userMfaStatus, memberships] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: request.user.id }, select: { mfaEnabled: true, locale: true } }),
      prisma.membership.findMany({ where: { userId: request.user.id, status: "active" }, include: { tenant: true } }),
    ]);

    return {
      user: { id: request.user.id, email: request.user.email, isSuperAdmin: request.user.isSuperAdmin, mfaEnabled: userMfaStatus.mfaEnabled, locale: userMfaStatus.locale },
      memberships: memberships.map((m) => ({
        organizationId: m.tenantId,
        organizationName: m.tenant.name,
        permissions: m.permissions,
        status: m.status,
      })),
    };
  });

  app.post("/api/v1/auth/mfa/enroll", async (request) => {
    if (!request.user) throw new UnauthorizedError("Not logged in");
    try {
      const { otpauthUri, qrCodeDataUri } = await enrollMfa(request.user.id, request.user.email);
      return { otpauthUri, qrCodeDataUri };
    } catch (error) {
      if (error instanceof MfaAlreadyEnabledError) throw new ValidationError(error.message);
      throw error;
    }
  });

  app.post("/api/v1/auth/mfa/confirm", async (request) => {
    if (!request.user) throw new UnauthorizedError("Not logged in");
    const body = mfaConfirmBodySchema.parse(request.body);
    try {
      await confirmMfa(request.user.id, body.code);
      return { mfaEnabled: true };
    } catch (error) {
      if (error instanceof InvalidMfaCodeError || error instanceof MfaNotEnrolledError || error instanceof MfaAlreadyEnabledError) {
        throw new ValidationError(error.message);
      }
      throw error;
    }
  });

  // Requires the CURRENT TOTP code (not just an active session) — a
  // hijacked session must not be able to silently strip the second factor.
  app.post("/api/v1/auth/mfa/disable", async (request) => {
    if (!request.user) throw new UnauthorizedError("Not logged in");
    const body = mfaDisableBodySchema.parse(request.body);
    try {
      await disableMfa(request.user.id, body.code);
      return { mfaEnabled: false };
    } catch (error) {
      if (error instanceof InvalidMfaCodeError || error instanceof MfaNotEnrolledError) throw new ValidationError(error.message);
      throw error;
    }
  });

  app.post("/api/v1/auth/accept-invite", async (request, reply) => {
    const body = acceptInviteBodySchema.parse(request.body);
    try {
      const result = await acceptInvite(body.token, body.password, sessionMeta(request));
      await setSessionCookie(reply, result.sessionToken);
      return { mfaRequired: false as const };
    } catch (error) {
      if (error instanceof InvalidOrExpiredInviteError) throw new ValidationError("This invite link is invalid or has expired");
      if (error instanceof WeakPasswordError) throw new ValidationError(error.message);
      throw error;
    }
  });

  app.post("/api/v1/auth/password", async (request) => {
    const token = currentSessionToken(request);
    if (!request.user || !token) throw new UnauthorizedError("Not logged in");
    const body = changePasswordBodySchema.parse(request.body);
    try {
      return await changePassword(request.user.id, body.currentPassword, body.newPassword, token);
    } catch (error) {
      rethrowLockout(error);
      if (error instanceof InvalidCredentialsError) throw new ValidationError("Current password is incorrect");
      if (error instanceof WeakPasswordError) throw new ValidationError(error.message);
      throw error;
    }
  });

  // The caller's OWN sessions only — the per-user index in sessionStore.ts
  // is keyed by request.user.id, so there's no path to anyone else's.
  app.get("/api/v1/auth/sessions", async (request) => {
    if (!request.user) throw new UnauthorizedError("Not logged in");
    return { data: await listUserSessions(request.user.id, currentSessionToken(request)) };
  });

  app.delete("/api/v1/auth/sessions/:id", async (request, reply) => {
    if (!request.user) throw new UnauthorizedError("Not logged in");
    const params = idParamSchema.parse(request.params);
    const revoked = await deleteUserSessionById(request.user.id, params.id);
    if (!revoked) throw new NotFoundError("No such session");
    return reply.status(204).send();
  });

  app.post("/api/v1/auth/sessions/revoke-others", async (request) => {
    const token = currentSessionToken(request);
    if (!request.user || !token) throw new UnauthorizedError("Not logged in");
    return { revoked: await deleteAllUserSessions(request.user.id, token) };
  });
}
