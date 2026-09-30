import { z } from "zod";

/** How many of the newest messages a mailbox's first sync reads when MAIL_INITIAL_SYNC_LIMIT is unset. */
export const DEFAULT_INITIAL_SYNC_LIMIT = 200;

// Single validated read of process.env. Fails fast and loudly at startup rather than
// letting a missing/malformed var surface later as a confusing runtime error deep in
// an IMAP or queue call.
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  DEFAULT_TENANT_NAME: z.string().min(1).default("Local Dev Tenant"),

  // Legacy single-mailbox setup, used only by the sync-once CLI script (mailboxes are added in the app).
  MAIL_HOST: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().min(1).optional()),
  MAIL_PORT: z.coerce.number().int().positive().default(993),
  MAIL_TLS: z
    .string()
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  // Legacy single-mailbox setup, used only by the sync-once CLI script (mailboxes are added in the app).
  MAIL_USERNAME: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().min(1).optional()),
  // Deliberately required only at runtime (not stored anywhere) — see
  // modules/mail-providers/imap/client.ts for where this is used and
  // architecture-review.md §Q for why this is never persisted to the database.
  // Legacy single-mailbox setup, used only by the sync-once CLI script (mailboxes are added in the app).
  MAIL_PASSWORD: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().min(1).optional()),
  MAIL_FOLDER: z.string().min(1).default("INBOX"),

  // An empty string (env var present but blank, as .env.example ships it) must be
  // treated the same as "not set," not as an invalid number.
  // Unset means DEFAULT_INITIAL_SYNC_LIMIT, not "everything": a first sync of
  // a years-old inbox would otherwise download and send every message to Jev.
  // "all" keeps the old behavior deliberately.
  MAIL_INITIAL_SYNC_LIMIT: z.preprocess(
    (v) => (v === "" || v === undefined ? DEFAULT_INITIAL_SYNC_LIMIT : v === "all" ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),

  // Phase 2: how often the durable reconciliation scheduler re-syncs each active
  // mailbox. 60s is a sensible development default; production deployments against
  // a real mail server should set this deliberately (implementation-plan.md's own
  // reconciliation guidance suggests 3-5 minutes) rather than hammering IMAP.
  MAIL_SYNC_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  // 1.1 (C): keep one IMAP connection open per mailbox (IDLE) so new mail is
  // fetched within seconds. While a mailbox's connection is live, its polling
  // slows to MAIL_POLL_FALLBACK_SECONDS (a safety net); when it drops, polling
  // returns to the normal interval. MAIL_IDLE_MAX_CONNECTIONS caps the open
  // connections (servers limit them — Gmail allows 15 per account).
  MAIL_IDLE_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  MAIL_POLL_FALLBACK_SECONDS: z.coerce.number().int().positive().default(300),
  MAIL_IDLE_MAX_CONNECTIONS: z.coerce.number().int().min(0).default(50),

  // --- Phase 3: Jev ---
  // Never logged, never persisted anywhere (see modules/jev/client.ts).
  JEV_API_KEY: z.string().min(1, "JEV_API_KEY is required"),
  // Deliberately explicit and pinned (docs.typesafe.ai/models.md, verified
  // 2026-09-23): "jev-latest" currently resolves to "jev-1.13.0", but the alias is
  // documented as floating — a future TypeSafe-side upgrade could silently change
  // classification behavior if we depended on the alias. The default here is the
  // resolved version string, not the alias, and changing it is a deliberate,
  // reviewed config change (architecture-review.md §2).
  JEV_MODEL_VERSION: z.string().min(1).default("jev-1.13.0"),
  // Verified endpoint is POST {base}/v1/systemone (docs.typesafe.ai/api.md).
  JEV_API_BASE_URL: z.string().min(1).default("https://api.typesafe.ai"),
  // Total retry budget per analysis call, matching TypeSafe's own documented SDK
  // default (docs.typesafe.ai/sdk/python/api/retries.md: 30.0s "total retry budget
  // ... including the initial attempt and delays").
  JEV_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),

  // --- Phase 5B: Destination secrets (Webhook channel) ---
  // Base64-encoded 256-bit (32-byte) AES-256-GCM key — application-level
  // encryption of DestinationSecret.encryptedValue (modules/secrets/secretCrypto.ts).
  // Deliberately fails startup (not a lazily-discovered runtime error) if missing
  // or the wrong length: a webhook destination's secret is unusable without it, and
  // discovering that only when the first webhook fires would be exactly the kind of
  // "confusing runtime error deep in a call" this module's own header comment
  // already warns against. Generate one with: openssl rand -base64 32
  SECRET_ENCRYPTION_KEY: z
    .string()
    .min(1, "SECRET_ENCRYPTION_KEY is required")
    .refine((v) => {
      try {
        return Buffer.from(v, "base64").length === 32;
      } catch {
        return false;
      }
    }, "SECRET_ENCRYPTION_KEY must be a base64-encoded 256-bit (32-byte) key"),

  // Per-attempt HTTP timeout for the webhook executor — mirrors
  // modules/destinations/idempotency.ts's ARCHIVE_EXECUTOR_TIMEOUT_MS pattern
  // (a bounded, configurable per-channel budget, not the platform default).
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),

  // --- Phase 6: Control Plane API ---
  API_PORT: z.coerce.number().int().positive().default(3000),
  API_HOST: z.string().min(1).default("0.0.0.0"),
  // Requests per minute per client address, across all API replicas (1.0).
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
  // 1.1: the API emails system administrators when the worker's heartbeat
  // has been missing this many minutes (and again when it is back). 0 = off.
  WORKER_WATCHDOG_MINUTES: z.coerce.number().int().min(0).default(5),
  // Where system-level emails (the watchdog) go: comma-separated addresses.
  // Empty = every active system administrator's account address.
  SYSTEM_ALERT_EMAILS: z
    .string()
    .optional()
    .transform((v) => (v ?? "").split(",").map((a) => a.trim()).filter(Boolean))
    .pipe(z.array(z.string().email())),
  // Language of those emails when an address has no account of its own ("en" | "tr").
  SYSTEM_ALERT_LOCALE: z.enum(["en", "tr"]).default("en"),
  // Behind a reverse proxy the client's address is in X-Forwarded-For. Unset =
  // don't trust it (direct exposure). "true", a hop count, or a comma list of
  // proxy addresses/CIDRs (the Docker setup trusts the private networks, so
  // Caddy → web → API hops resolve to the real client).
  TRUST_PROXY: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v === "true" ? true : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v),
    z.union([z.boolean(), z.number().int().positive(), z.string().min(1)]).optional(),
  ),

  // --- Phase 7: reliability hardening ---
  // Hard upper bound for graceful shutdown (§2) — after this many ms, the
  // process force-exits regardless of what's still in-flight. 15s is
  // deliberately generous relative to any single job's own per-attempt
  // timeout in this codebase (webhook: WEBHOOK_TIMEOUT_MS=10s default,
  // archive: 15s) so a currently-executing action gets a real chance to reach
  // one of its own terminal states before being cut off.
  SHUTDOWN_GRACE_PERIOD_MS: z.coerce.number().int().positive().default(15_000),

  // --- Phase 11: Authentication ---
  // Redis-backed session TTL (sliding — refreshed on every authenticated
  // request, see modules/auth/sessionStore.ts) and the cookie's own maxAge,
  // kept in sync so the cookie never confusingly outlives (or dies before)
  // the Redis key backing it.
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  SESSION_COOKIE_NAME: z.string().min(1).default("jm_session"),
  // "false" only for local plain-HTTP dev — see docker-compose.yml/.env.example.
  // Any real deployment must run this true, which requires HTTPS.
  SESSION_COOKIE_SECURE: z
    .string()
    .default("true")
    .transform((v) => v === "true" || v === "1"),

  // Idempotent bootstrap-superAdmin creation (modules/auth/bootstrapAdmin.ts),
  // run once at API startup — see src/server.ts. Both optional: an
  // already-provisioned deployment can leave these unset, and an existing
  // user's password is never overwritten on restart even if set.
  BOOTSTRAP_ADMIN_EMAIL: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.string().email().optional(),
  ),
  BOOTSTRAP_ADMIN_PASSWORD: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.string().min(8).optional(),
  ),

  // The frontend's own public origin — used ONLY to build the accept-invite
  // link put in an invite email (modules/email/inviteEmail.ts). Distinct
  // from any IMAP MAIL_* var: this has nothing to do with the incoming
  // mailbox this product ingests, it's "where does a human click to accept
  // an invite this backend just emailed them."
  APP_BASE_URL: z.string().min(1).default("http://localhost:3001"),

  // --- Phase 11.1: outbound invite email (SMTP) ---
  // All optional — sendInviteEmail() (modules/email/mailer.ts) is a no-op
  // (invite still succeeds, the raw link is still returned in the API
  // response for the admin to share manually) whenever SMTP_HOST is unset.
  // Deliberately a distinct SMTP_* prefix, never MAIL_* — MAIL_* already
  // names the INCOMING IMAP mailbox this product polls; this is unrelated
  // outbound mail, sent through a real mail server's SMTP submission port,
  // e.g. Gmail (smtp.gmail.com:587, an App Password) or Hostinger
  // (smtp.hostinger.com:465).
  SMTP_HOST: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().min(1).optional()),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  SMTP_USERNAME: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().min(1).optional()),
  SMTP_PASSWORD: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().min(1).optional()),
  // Defaults to SMTP_USERNAME (the common case: you send-as the account you
  // authenticate as) — only set this separately if your provider allows
  // sending from a different address than the one you log in with.
  SMTP_FROM_ADDRESS: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().email().optional()),
  SMTP_FROM_NAME: z.string().min(1).default("Eumaeus"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
