import { TOTP, Secret } from "otpauth";
import QRCode from "qrcode";

/**
 * TOTP (RFC 6238) generation/verification for optional per-user MFA.
 * User.mfaSecret stores the base32 secret PACKED THROUGH
 * modules/secrets/secretCrypto.ts's encryptSecret/decryptSecret (same
 * AES-256-GCM, same SECRET_ENCRYPTION_KEY) — this module never encrypts
 * anything itself, it only generates/verifies TOTP codes against an
 * already-decrypted secret the caller supplies.
 *
 * Enroll/confirm is deliberately two steps (see api/routes/auth.ts):
 * generateTotpSecret() + buildEnrollmentUri() happen at /auth/mfa/enroll,
 * verifyTotpCode() at /auth/mfa/confirm — User.mfaEnabled only flips true
 * after a successful confirm, so a bad QR scan can't lock someone out.
 */
const ISSUER = "Eumaeus";

export function generateTotpSecret(): string {
  return new Secret().base32;
}

export function buildEnrollmentUri(email: string, base32Secret: string): string {
  const totp = new TOTP({ issuer: ISSUER, label: email, secret: base32Secret });
  return totp.toString();
}

/** Renders the enrollment URI as a scannable QR code, `data:image/png;base64,...` — generated server-side so the frontend never needs to know anything about the otpauth:// URI format, just render an <img src>. */
export function buildQrCodeDataUri(otpauthUri: string): Promise<string> {
  return QRCode.toDataURL(otpauthUri);
}

/**
 * `window: 1` accepts a code from one 30-second step before/after the
 * server's current time (the standard clock-skew allowance for TOTP) —
 * generous enough for real-world clock drift without accepting codes from
 * many minutes away. Returns true/false only; the actual delta (`validate()`
 * returning a step-offset number or null) is not exposed since callers only
 * ever need "was this code valid," never "how far off was it."
 */
export function verifyTotpCode(base32Secret: string, code: string): boolean {
  const totp = new TOTP({ issuer: ISSUER, secret: base32Secret });
  return totp.validate({ token: code, window: 1 }) !== null;
}
