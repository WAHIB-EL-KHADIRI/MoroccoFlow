# MoroccoFlow

**Business, in flow.** An original, bilingual business-management platform for Moroccan companies,
designed and engineered by **WAHIB EL KHADIRI**.

[![Quality](https://github.com/WAHIB-EL-KHADIRI/MoroccoFlow-/actions/workflows/ci.yml/badge.svg)](https://github.com/WAHIB-EL-KHADIRI/MoroccoFlow-/actions/workflows/ci.yml)

![MoroccoFlow dashboard](docs/screenshots/dashboard-light.png)

## What it includes

- CRM, Moroccan customer records and sales pipeline
- Project and keyboard-accessible Kanban task management
- Quotes, invoices, expenses and revenue tracking in Moroccan dirhams
- Dashboard, Chart.js reports, CSV export and printable PDF layouts
- Team invitations, server-enforced RBAC and append-only audit history
- French and Arabic, RTL/LTR, light/dark themes and responsive layouts
- IndexedDB offline cache, mutation outbox, Service Worker and installable PWA
- Rotating sessions, account lockout, Argon2id passwords and TOTP MFA
- S3-compatible documents with content validation and malware quarantine

All demo companies and people are fictional. Demo financial values intentionally display `0 dh`.
No template or third-party product source code was copied.

## Runtime modes

- **Portfolio mode** requires no server. It seeds fictional data in IndexedDB and is suitable for
  GitHub Pages.
- **Company mode** is enabled by `VITE_API_BASE_URL=/api/v1`. It uses the Fastify API,
  PostgreSQL row-level security, Redis and private S3-compatible storage while retaining offline
  operation.

## Stack

Frontend: HTML5, CSS3, Vanilla JavaScript ES2026, Web Components, ES Modules, IndexedDB,
Service Worker/PWA, Chart.js 4 and Vite 8.

Backend: Node.js 22, Fastify 5, PostgreSQL 18, Redis 8, S3 API, Argon2id, JWT, Prometheus metrics
and checksummed SQL migrations.

Quality: Vitest 4, Playwright 1.61, axe, ESLint 10, Prettier 3 and GitHub Actions.

## Quick start: portfolio mode

Requires Node.js 22.12 or newer.

```bash
npm ci
npm run dev
```

## Company mode without Docker

Provide your own PostgreSQL, Redis and S3-compatible services. Copy `.env.example` to `.env`,
replace every sample credential, and set the service URLs. Then run:

```bash
npm ci
npm run db:migrate
npm run api:dev
npm run dev
```

The API is available at `http://127.0.0.1:3000`; Vite proxies `/api`. Interactive API docs are at
`/documentation` in development. Docker manifests remain an optional deployment reference and are
not required for development.

Useful commands:

```bash
npm run check          # lint, frontend/backend tests and production build
npm run test:e2e       # desktop and mobile Chromium journeys with axe
npm run test:coverage  # frontend coverage
npm run api:test       # backend security and HTTP tests
npm run db:backup      # custom-format pg_dump plus SHA-256 checksum
npm run format:check
```

## Architecture and security

```text
Browser: Web Components → observable store → IndexedDB/outbox
                                    ↓ HTTPS
API: Fastify → JWT/MFA/RBAC → tenant transaction → PostgreSQL forced RLS
              ↘ Redis rate limits  ↘ S3 quarantine  ↘ metrics/audit
```

Access tokens remain in memory. Refresh tokens are opaque, hashed, rotated and revocable. Offline
mutations use client UUIDs and transactional `Idempotency-Key` records. The runtime database role
cannot bypass tenant RLS or update/delete audit records. The Service Worker excludes API and
authenticated responses from caching.

Read the complete [architecture](docs/architecture.md), [operations runbook](docs/runbook.md) and
[production-readiness assessment](docs/production-readiness.md).

## Accessibility and performance

The UI targets WCAG 2.2 AA with semantic landmarks, visible focus, keyboard Kanban controls,
44-pixel targets, reduced-motion support, non-color status labels and responsive RTL. The saved
mobile audit reports **Performance 95, Accessibility 100 and Best Practices 100**; see the
[Lighthouse report](docs/lighthouse-report.json).

## CI and deployment

The quality workflow runs dependency audit, checksummed migrations, PostgreSQL RLS integration
tests, unit/integration tests, production build and Playwright/axe. The Pages workflow publishes
portfolio mode. Company mode requires a separate API deployment and managed service credentials.

## Screens

| Dashboard                                          | Accessible Kanban                      | Arabic mobile / dark                                      |
| -------------------------------------------------- | -------------------------------------- | --------------------------------------------------------- |
| ![Dashboard](docs/screenshots/dashboard-light.png) | ![Kanban](docs/screenshots/kanban.png) | ![Arabic mobile](docs/screenshots/mobile-arabic-dark.png) |

© 2026 WAHIB EL KHADIRI.
