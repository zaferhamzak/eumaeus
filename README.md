<p align="center"><img src="apps/web/app/icon.svg" width="72" height="72" alt="Eumaeus logo"></p>

<h1 align="center">Eumaeus</h1>

<p align="center">An email control plane: every message read, understood, routed — and accounted for.</p>

<p align="center"><a href="README.tr.md">Türkçe</a> · <a href="docs/eumaeus-1.0.0.md">Full documentation (TR)</a> · <a href="CHANGELOG.md">Changelog</a> · <a href="LICENSE">Apache-2.0</a></p>

---

Eumaeus watches your IMAP mailboxes, asks [Jev AI](https://api.typesafe.ai) a
fixed set of questions about every new email (is it spam? which category? does
it need a reply? how urgent?), decides what to do with it using your rules, and
does it: moves it to a folder, forwards it, posts it to a webhook, Slack,
Teams, Jira or Zendesk, or sends an auto-reply. Whatever it is not sure about
goes to a human review queue. Every step is written to an append-only audit
log.

It is multi-tenant: one installation serves many organizations, each with its
own mailboxes, rules, members and permissions.

*Eumaeus is the loyal swineherd of the Odyssey — the one who keeps watch and
greets whoever comes to the door.*

## Features

- **Ingestion** — IMAP (Gmail and Microsoft 365 by OAuth sign-in, anything else
  by password), scheduled sync, original MIME kept for a configurable time.
  SPF / DKIM / DMARC verdicts are captured from the provider's
  `Authentication-Results`.
- **Analysis** — Jev AI answers eight built-in questions per email;
  organizations can add their own questions (yes/no, choice, scale).
- **Decisions** — ordered rules or branching rule graphs over email fields,
  Jev answers, arrival context (business hours, first email from a sender,
  replies) and sender authentication. Try any change on past email before
  saving; risky changes need confirmation; every rule keeps its version history.
- **Actions** — move (never delete, one-click undo), flag/label, signed
  webhooks, forwarding (immediate or digest, recipient-confirmed), auto-reply,
  Slack/Teams, Jira/Zendesk.
- **Human review** — a queue with keyboard shortcuts, decide-similar, assignment
  with batched email notifications, notes, one-click decisions from the digest
  email; decisions feed allow/block and rule suggestions.
- **Operations** — dashboard, reports, alerts (email, webhook), reprocessing,
  mailbox and queue health, search.
- **Access** — invited users, per-organization granular permissions, TOTP MFA,
  Google/Microsoft sign-in, scoped API keys.
- **Privacy** — per-organization retention, GDPR/KVKK erasure by sender,
  permanent deletion, CSV audit export.
- **Interface** — English and Turkish; light and dark themes.

## Quick start (production)

Requirements: Docker with Compose v2, a DNS name pointing at the server, ports
80 and 443 open.

```sh
git clone <this repository> eumaeus && cd eumaeus
cp deploy/.env.example deploy/.env
# fill in DOMAIN, POSTGRES_PASSWORD, SECRET_ENCRYPTION_KEY (openssl rand -base64 32),
# JEV_API_KEY and BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

Then open `https://<your domain>`, sign in with the bootstrap administrator,
change the password (Security), set up SMTP (Settings) and add an organization
and its mailboxes.

The stack: PostgreSQL 16, Redis 7, the API, the background worker, the web app,
Caddy (automatic HTTPS via Let's Encrypt) and a backup service. Only Caddy is
published; everything restarts on its own and has a health check. Database
migrations run when the API starts.

**Keep `SECRET_ENCRYPTION_KEY` safe and backed up.** Mailbox passwords, OAuth
tokens and webhook secrets are encrypted with it; a database backup is useless
for those secrets without it.

### Backups

The `backup` service writes a `pg_dump` every `BACKUP_INTERVAL_HOURS` (default
24) to `deploy/backups/` and keeps `BACKUP_RETENTION_DAYS` (default 14) days —
older files are removed only after a successful backup. Restore into an empty
database with `deploy/backup/restore.sh` (steps in the documentation, §17.2).
Copy backups off the server as well.

## Development

Requirements: Node.js 22+, pnpm, PostgreSQL 16, Redis 7.

```sh
pnpm install
cp apps/api/.env.example apps/api/.env      # fill it in
pnpm fastrun          # checks Postgres/Redis, applies migrations, starts API :3000,
                      # worker and web :3001 with labelled logs; Ctrl+C stops all
pnpm test && pnpm typecheck && pnpm lint
```

`pnpm fastrun:bg` starts the same in the background (logs in `.run/`),
`pnpm fastrun:status` shows what runs and whether it's healthy,
`pnpm fastrun:stop` stops it. Each service can still be run on its own with
`pnpm api`, `pnpm worker` and `pnpm web`.

```
apps/api   Fastify 5 API, BullMQ worker, Prisma 6 schema and migrations
apps/web   Next.js 16 web app (React 19, React Query)
deploy/    Docker Compose production stack, Caddy, backup scripts
docs/      Full documentation (Turkish), architecture notes, load test
```

Tests run against a separate database (`DATABASE_URL_TEST`) and a separate
Redis database; no real IMAP, SMTP or Jev account is needed.

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability and a summary
of the security model.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
