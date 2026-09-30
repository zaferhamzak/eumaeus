# Security

## Reporting a vulnerability

Please report security issues privately through GitHub's **Report a
vulnerability** (Security → Advisories) on this repository, not in a public
issue. Include the version, the steps to reproduce and the impact you expect.
You will get an acknowledgement within a few days.

## Security model (summary)

- **Authentication**: argon2id password hashes, optional TOTP MFA, session
  cookies (httpOnly, SameSite=Lax, Secure in production) backed by Redis,
  login lockout, Google/Microsoft sign-in for invited users only, scoped API
  keys stored as SHA-256 hashes.
- **Authorization**: every organization-scoped request is checked against the
  caller's membership and a closed catalogue of permissions.
- **Secrets at rest**: mailbox passwords, OAuth tokens and webhook signing
  secrets are encrypted with AES-256-GCM under `SECRET_ENCRYPTION_KEY`; they are
  never returned by the API or written to logs.
- **Untrusted email**: bodies are shown as plain text only; HTML is never
  rendered. Outbound webhooks and chat/ticket calls are protected against SSRF
  (private and internal addresses refused, re-checked after DNS resolution).
- **Transport and headers**: HTTPS with HSTS via Caddy; a strict
  Content-Security-Policy on the web app; nosniff / frame-deny headers on every
  response.
- **Abuse**: per-client rate limits shared across API replicas through Redis.
- **Audit**: every decision, action and administrative change is recorded in
  an append-only audit log.
- **Mail safety**: Eumaeus never deletes email from a mailbox; moves are
  undoable. Retention and erasure delete only Eumaeus's own copy.

## Operator checklist

- Generate `SECRET_ENCRYPTION_KEY` with `openssl rand -base64 32` and back it up
  separately from database backups.
- Remove `BOOTSTRAP_ADMIN_PASSWORD` from `deploy/.env` after the first login
  and change the password in the app; turn on MFA.
- Keep backups off the server.
- Keep the stack updated (`docker compose ... up -d --build`).
