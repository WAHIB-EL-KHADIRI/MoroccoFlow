# Production runbook

## Required managed services

- PostgreSQL 18 with encrypted connections, point-in-time recovery and a dedicated migration role.
- Redis 8 with TLS and ACL credentials; do not expose it publicly.
- Private S3-compatible storage with encryption, versioning and lifecycle rules.
- A malware scanner that calls the protected file scan-result endpoint.
- TLS termination, centralized logs, Prometheus scraping and alerting.

Docker files are provided as an optional deployment reference. They are not required for local
Node development and were not used for the final local verification at the user's request.

## First deployment

1. Copy `.env.example` into the platform secret manager and replace every sample secret.
2. Use separate database credentials for migrations and runtime; the runtime login must be allowed
   to `SET ROLE moroccoflow_app` but must not own tables or have `BYPASSRLS`.
3. Run `npm ci`, `npm run db:migrate`, then start the API with `npm run api:start`.
4. Build the web app with `VITE_API_BASE_URL=/api/v1 npm run build` and serve `dist/` behind HTTPS.
5. Create the first workspace through `/api/v1/auth/bootstrap`, then rotate the bootstrap token.
6. Disable API documentation in production unless it is protected by the edge proxy.

## Backup and restore

`npm run db:backup` invokes `pg_dump` without a shell, writes a custom-format backup and creates a
SHA-256 checksum. `pg_dump` must be installed and `DATABASE_URL`/`BACKUP_DIR` configured.

Backups must be encrypted by the storage platform, copied to a separate account/region and tested
quarterly. A restore drill uses a new empty database:

```bash
pg_restore --clean --if-exists --no-owner --dbname "$RESTORE_DATABASE_URL" backup.dump
npm run db:migrate
```

After restoration, verify tenant isolation, login, invoice totals, file metadata and audit history
before switching traffic.

## Incident controls

- Revoke a user's active sessions by setting `refresh_tokens.revoked_at` inside their tenant scope.
- Rotate JWT, cookie, MFA encryption, metrics, bootstrap and scanner secrets independently.
- A JWT-secret rotation invalidates access tokens within 15 minutes; revoke refresh sessions too.
- Treat a reused refresh token, RLS failure, audit mutation attempt or infected upload as an alert.
- Never include passwords, tokens, cookies, MFA secrets or raw IP addresses in logs.

## Pre-launch gates

The repository cannot replace organization-specific approval. Before accepting real customer data,
complete an external penetration test, backup-restore drill, load test, DPIA/privacy review,
Moroccan CNDP/legal review, accessibility audit with assistive technology and an incident-response
exercise. See [production readiness](production-readiness.md).
