import type { Prisma } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { hashPassword, verifyPassword } from "./password.js";
import { generateTotpSecret, buildEnrollmentUri, buildQrCodeDataUri, verifyTotpCode } from "./mfa.js";
import { generateInviteToken, hashInviteToken } from "./inviteToken.js";
import { encryptSecret, decryptSecret } from "../secrets/secretCrypto.js";
import {
  createSession,
  createMfaPendingToken,
  readMfaPendingToken,
  consumeMfaPendingToken,
  deleteSession,
  deleteAllUserSessions,
  type SessionMeta,
} from "./sessionStore.js";
import { assertNotLocked, recordFailure, clearFailures } from "./loginThrottle.js";

export class AuthError extends Error {}
export class InvalidCredentialsError extends AuthError {}
export class MfaRequiredError extends AuthError {
  constructor(public readonly pendingToken: string) {
    super("MFA verification required");
  }
}
export class InvalidMfaCodeError extends AuthError {}
export class InvalidOrExpiredInviteError extends AuthError {}
export class MfaNotEnrolledError extends AuthError {}
export class MfaAlreadyEnabledError extends AuthError {}
export class WeakPasswordError extends AuthError {}

/** The one place password strength is decided — accept-invite and change-password both use it. Length is what actually matters against guessing; composition rules mostly produce "Password1!" and are deliberately not imposed. */
export const MIN_PASSWORD_LENGTH = 10;
function assertStrongEnough(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) throw new WeakPasswordError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
}

/**
 * A hash of a value nobody will ever type — argon2.verify() is run against
 * it when the email doesn't match any User, so an unknown-email login and a
 * known-email-wrong-password login take roughly the same amount of time
 * (argon2's cost dominates either way) and don't leak "does this email
 * exist" through a timing side channel. Regenerated once per process start
 * is unnecessary — it is never compared for equality against anything, only
 * used as verifyPassword's second argument to burn real argon2 work.
 */
let dummyHashPromise: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) dummyHashPromise = hashPassword("dummy-password-never-matches-anything");
  return dummyHashPromise;
}

export type LoginResult = { userId: string; sessionToken: string } | { userId: string; pendingToken: string };

/** Throws InvalidCredentialsError on any failure (unknown email OR wrong password — never distinguished in the thrown error, exactly matching the generic response the route returns). Returns a full session on success for a non-MFA user, or a pending token (see MfaRequiredError) for an MFA-enabled one. */
export async function login(email: string, password: string, meta: SessionMeta = {}): Promise<LoginResult> {
  await assertNotLocked("login", email);
  const user = await prisma.user.findUnique({ where: { email } });

  // A user with no passwordHash yet (invited, invite not accepted) is
  // indistinguishable from "doesn't exist" for login purposes — argon2.verify()
  // itself throws on an empty/malformed digest rather than returning false, so
  // this must be checked before calling it, not left to fall through.
  if (!user || user.status !== "active" || !user.passwordHash) {
    await verifyPassword(await getDummyHash(), password); // burn real work — see getDummyHash()
    await recordFailure("login", email);
    await recordAuthEvent(user?.id ?? null, "login_failed", user ? {} : { email });
    throw new InvalidCredentialsError();
  }

  const valid = await verifyPassword(user.passwordHash, password);
  if (!valid) {
    await recordFailure("login", email);
    await recordAuthEvent(user.id, "login_failed", {});
    throw new InvalidCredentialsError();
  }
  await clearFailures("login", email);

  if (user.mfaEnabled) {
    const pendingToken = await createMfaPendingToken(user.id);
    await recordAuthEvent(user.id, "mfa_challenge_issued", {});
    return { userId: user.id, pendingToken };
  }

  const sessionToken = await createSession(user.id, meta);
  await recordAuthEvent(user.id, "login_succeeded", { ip: meta.ip ?? null });
  return { userId: user.id, sessionToken };
}

/** Second step of login for an MFA-enabled user. Throws InvalidMfaCodeError (and does NOT consume the pending token — it may be retried until it expires) or InvalidOrExpiredInviteError-shaped "no such pending token." On success the pending token is deleted and a real session is created fresh — never promoted in place. */
export async function loginMfa(pendingToken: string, code: string, meta: SessionMeta = {}): Promise<{ userId: string; sessionToken: string }> {
  const userId = await readMfaPendingToken(pendingToken);
  if (!userId) throw new InvalidMfaCodeError("This MFA challenge has expired or does not exist — log in again");
  await assertNotLocked("mfa", userId);

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.mfaEnabled || !user.mfaSecret) throw new InvalidMfaCodeError("MFA is no longer configured for this account");

  const valid = verifyTotpCode(decryptSecret(user.mfaSecret), code);
  if (!valid) {
    await recordFailure("mfa", user.id);
    await recordAuthEvent(user.id, "mfa_failed", {});
    throw new InvalidMfaCodeError("Incorrect code");
  }

  await clearFailures("mfa", user.id);
  await consumeMfaPendingToken(pendingToken);
  const sessionToken = await createSession(user.id, meta);
  await recordAuthEvent(user.id, "mfa_succeeded", {});
  return { userId: user.id, sessionToken };
}

export async function logout(sessionToken: string, userId: string | null): Promise<void> {
  await deleteSession(sessionToken);
  await recordAuthEvent(userId, "logout", {});
}

/**
 * Requires the CURRENT password (a hijacked session alone must not be able
 * to take over the account by changing it), then signs out every OTHER
 * session — the standard "someone may have my password" response. The
 * session making the request stays logged in. Wrong current passwords count
 * toward the same login lockout as the login form, so this can't be used as
 * an unthrottled password-guessing oracle.
 */
export async function changePassword(userId: string, currentPassword: string, newPassword: string, currentSessionToken: string): Promise<{ otherSessionsRevoked: number }> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  await assertNotLocked("login", user.email);
  if (!user.passwordHash || !(await verifyPassword(user.passwordHash, currentPassword))) {
    await recordFailure("login", user.email);
    throw new InvalidCredentialsError();
  }
  assertStrongEnough(newPassword);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(newPassword) } });
  const otherSessionsRevoked = await deleteAllUserSessions(userId, currentSessionToken);
  await recordAuthEvent(userId, "password_changed", { otherSessionsRevoked });
  return { otherSessionsRevoked };
}

/** Step 1 of MFA enrollment — generates a secret, stores it encrypted with mfaEnabled still false (a bad QR scan must not lock the user out; see confirmMfa). Re-enrolling replaces any previously-enrolled-but-unconfirmed secret. */
export async function enrollMfa(userId: string, email: string): Promise<{ otpauthUri: string; qrCodeDataUri: string; secret: string }> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.mfaEnabled) throw new MfaAlreadyEnabledError("MFA is already enabled — disable it before re-enrolling");

  const secret = generateTotpSecret();
  await prisma.user.update({ where: { id: userId }, data: { mfaSecret: encryptSecret(secret) } });
  const otpauthUri = buildEnrollmentUri(email, secret);
  return { otpauthUri, qrCodeDataUri: await buildQrCodeDataUri(otpauthUri), secret };
}

/** Lets a user turn MFA off — e.g. after losing their authenticator device. Requires the current TOTP code (not just being logged in) so a hijacked session can't silently disable the second factor on its own. */
export async function disableMfa(userId: string, code: string): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.mfaEnabled || !user.mfaSecret) throw new MfaNotEnrolledError("MFA is not enabled on this account");
  if (!verifyTotpCode(decryptSecret(user.mfaSecret), code)) throw new InvalidMfaCodeError("Incorrect code");
  await prisma.user.update({ where: { id: userId }, data: { mfaEnabled: false, mfaSecret: null } });
  await recordAuthEvent(userId, "mfa_disabled", {});
}

/** Step 2 — verifies a code against the just-enrolled secret and flips mfaEnabled true. */
export async function confirmMfa(userId: string, code: string): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.mfaSecret) throw new MfaNotEnrolledError("Call /auth/mfa/enroll first");
  if (user.mfaEnabled) throw new MfaAlreadyEnabledError("MFA is already enabled");

  const valid = verifyTotpCode(decryptSecret(user.mfaSecret), code);
  if (!valid) throw new InvalidMfaCodeError("Incorrect code");

  await prisma.user.update({ where: { id: userId }, data: { mfaEnabled: true } });
  await recordAuthEvent(userId, "mfa_enrolled", {});
}

/** Creates (or finds) a User by email and a pending Membership carrying the given permissions, returning the RAW invite token once — never persisted anywhere, only its hash. Mirrors ensureBootstrapMailbox's find-or-create idiom for the User half. */
export async function createInvite(tenantId: string, email: string, permissions: string[]): Promise<{ rawToken: string; membershipId: string }> {
  const user = await prisma.user.upsert({
    where: { email },
    // A brand-new invitee has no password yet — acceptInvite() sets it. The
    // placeholder here is never a valid argon2 digest, so verifyPassword()
    // against it during a login attempt before the invite is accepted always
    // safely returns false, never throws.
    create: { email, passwordHash: "" },
    update: {},
  });

  const rawToken = generateInviteToken();
  const membership = await prisma.membership.upsert({
    where: { userId_tenantId: { userId: user.id, tenantId } },
    create: {
      userId: user.id,
      tenantId,
      permissions,
      status: "pending",
      inviteTokenHash: hashInviteToken(rawToken),
      inviteExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
    update: {
      permissions,
      status: "pending",
      inviteTokenHash: hashInviteToken(rawToken),
      inviteExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  await recordAuthEvent(user.id, "invite_sent", { tenantId, membershipId: membership.id });
  return { rawToken, membershipId: membership.id };
}

/** Activates a pending Membership via its invite token, setting the User's password if this is their first-ever accepted invite, then logs them in immediately (same session-creation path as login()). */
export async function acceptInvite(rawToken: string, password: string, meta: SessionMeta = {}): Promise<{ userId: string; sessionToken: string }> {
  const tokenHash = hashInviteToken(rawToken);
  const membership = await prisma.membership.findFirst({
    where: { inviteTokenHash: tokenHash, status: "pending" },
  });
  if (!membership || !membership.inviteExpiresAt || membership.inviteExpiresAt < new Date()) {
    throw new InvalidOrExpiredInviteError();
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: membership.userId } });
  // A user's FIRST accepted invite sets their password; a second invite
  // (different org) reuses the existing credential — they already have one.
  if (!user.passwordHash) {
    assertStrongEnough(password);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password) } });
  }

  await prisma.membership.update({
    where: { id: membership.id },
    data: { status: "active", acceptedAt: new Date(), inviteTokenHash: null, inviteExpiresAt: null },
  });

  await recordAuthEvent(user.id, "invite_accepted", { tenantId: membership.tenantId, membershipId: membership.id });
  const sessionToken = await createSession(user.id, meta);
  return { userId: user.id, sessionToken };
}

/**
 * Phase 20: the end of a single sign-on (Google / Microsoft). The identity was
 * proven by the provider; everything after is the same as a password login —
 * including the MFA step when the account has it on.
 */
export async function completeExternalLogin(userId: string, method: string, meta: SessionMeta = {}): Promise<LoginResult> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.mfaEnabled) {
    const pendingToken = await createMfaPendingToken(user.id);
    await recordAuthEvent(user.id, "mfa_challenge_issued", { method });
    return { userId: user.id, pendingToken };
  }
  const sessionToken = await createSession(user.id, meta);
  await recordAuthEvent(user.id, "login_succeeded", { ip: meta.ip ?? null, method });
  return { userId: user.id, sessionToken };
}

/** Phase 20: SSO sign-ins that were refused (unknown account, domain not allowed…). */
export async function recordSsoRefused(userId: string | null, payload: Prisma.InputJsonValue): Promise<void> {
  await recordAuthEvent(userId, "sso_login_refused", payload);
}

async function recordAuthEvent(userId: string | null, eventType: string, payload: Prisma.InputJsonValue): Promise<void> {
  await prisma.authEvent.create({ data: { userId, eventType, payload } });
}
