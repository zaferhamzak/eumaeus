import { z } from "zod";

export const loginBodySchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
  })
  .strict();

export const loginMfaBodySchema = z
  .object({
    pendingToken: z.string().min(1),
    code: z.string().min(1),
  })
  .strict();

export const mfaConfirmBodySchema = z
  .object({
    code: z.string().min(1),
  })
  .strict();

export const mfaDisableBodySchema = z
  .object({
    code: z.string().min(1),
  })
  .strict();

export const acceptInviteBodySchema = z
  .object({
    token: z.string().min(1),
    // Strength (MIN_PASSWORD_LENGTH) is enforced in modules/auth/authService.ts,
    // the one place that rule lives, so the message is consistent everywhere.
    password: z.string().min(1),
  })
  .strict();

export const changePasswordBodySchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(1),
  })
  .strict();
