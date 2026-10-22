# Jantrik School — Project Guide for Claude

## What we are building
A multi-tenant SaaS for education institutes in Bangladesh (later other countries):
general schools (NCTB Bangla & English version), English medium, Aliya / model / Qawmi / Hifz madrasas,
coaching centres, technical & vocational institutes, kindergartens.

Each institute ("tenant") picks its **institute type** at signup. The type loads a **template**
(classes, subjects, grading scheme, calendar, labels). Features are **modules** that can be
enabled per tenant and are billed separately (attendance, fees, exams, hostel, transport, AI tutor...).

## Current phase: Phase 1 — MVP
Scope ONLY:
- Core: tenants, branches, academic years, users + roles, classes, sections, subjects, students, guardians
- Attendance module
- Fees module (fee heads, invoices, payments; bKash/SSLCommerz later in the phase)
- Exams & results module (marks entry, grading by scheme, report card PDF)
- Guardian notifications (SMS + app)
Launch institute types for MVP: **coaching centre** and **NCTB school (Bangla/English version)**.
Do NOT build hostel, transport, AI tutor, virtual labs yet.

## Tech stack (decided — do not change without asking)
- Monorepo: pnpm workspaces + Turborepo
- `apps/web` — Next.js (App Router) + TypeScript + Tailwind + shadcn/ui
- `apps/api` — NestJS (TypeScript), one Nest module per product module
- `apps/mobile` — React Native (Expo) — later in Phase 1
- `packages/db` — Prisma + PostgreSQL 16
- `packages/shared` — shared types and zod schemas
- Redis + BullMQ for queues (SMS, PDFs, imports)
- Local dev: docker-compose (Postgres, Redis)
- Auth: JWT access + refresh tokens, phone-number login (OTP) for guardians

## Architecture rules (non-negotiable)
1. **Every tenant-owned table has `tenant_id`.** Every query is scoped by tenant.
   PostgreSQL Row-Level Security is enabled on tenant tables as a second safety net.
2. **No hard-coded institute-type logic.** Never write `if (type === 'qawmi')` in business code.
   Differences live in data: grading schemes, academic structure, labels, templates.
3. **Module gating:** every API route and UI page belongs to a module; check
   `tenant.enabledModules` via a guard/middleware.
4. **Modular monolith:** modules talk through service interfaces, not each other's tables.
5. **Slow work goes to the queue** (SMS, bulk PDFs, imports). Never block a request.
6. **Audit log** every create/update/delete on marks, fees, payments, attendance.
7. **i18n from day one:** all UI strings via translation keys (bn, en; ar later).
8. Money stored as integer paisa. Dates stored in UTC; display in Asia/Dhaka.
9. Secrets only in `.env` (never committed). Provide `.env.example`.

## Conventions
- Digits: Bangla digits (০-৯) in the bn UI for dates, times, counts and amounts; ASCII digits
  always for phone numbers, student_code, roll numbers, birth registration numbers and any IDs
  (people copy them into dialers/WhatsApp). Use the formatters in packages/shared (`format.ts`:
  `formatCount`, `formatTaka`, `formatDate`, `formatIdentifier`; `phone.ts`: `formatBdPhone`), never raw Intl.
- Input: accept Bangla digits everywhere a user types numbers; normalise with `toAsciiDigits` /
  `normalizeBdPhone` (packages/shared) before validating or searching.
- UI labels that differ by institute type (Section vs Batch, Class vs Course) come from
  `tenant_labels` (`useLabel()` in the web app), never from institute-type checks.
- New screens must use the v3 kit, themes and tokens (docs/design.md). Deferred design work and
  open decisions: docs/design-backlog.md.

## How Claude should work in this repo
- **Plan first only for large or risky changes**: propose the plan, wait for approval, then
  implement.
- **Always present a plan and wait for approval for any database, auth, security or API
  change**, even if the brief is detailed.
- **Never bypass or tamper with auth:** don't edit OTPs, sessions, tokens, passwords or
  permissions in Redis or the database to get access. If you need a login for testing, ask, or
  use the test SMS outbox (e2e: `SMS_PROVIDER=outbox`) or the seeded demo users.
- Keep changes small and focused on the task asked. Don't refactor unrelated code.
- Write tests for business logic (grading, fee calculation, tenant isolation).
- After finishing, list: files changed, how to run/test it, and anything left undone.
- During a phase, run only the affected tests; run the full gates (lint, typecheck, format, all
  tests, build and all of Playwright) once at the end of each step. CI runs everything on every
  push.
- Use a review subagent only for security, auth, RLS, money and database changes, not for pure
  UI.
- Screenshot checks during work: bn at 1366 and 390 px only. The full matrix (widths, languages,
  themes, modes) only when the owner asks for a gallery.
- If something in this file conflicts with a request, ask before proceeding.

## Commands
Run from the repo root (see README.md for first-time setup).
- `docker compose up -d --wait` — start Postgres 16 + Redis
- `pnpm dev` — run web (:3000) + api (:4000, `GET /health`) in watch mode
- `pnpm build` — build everything
- `pnpm test` — Vitest; packages/db integration tests need Docker (jantrik_test DB)
- `pnpm lint` / `pnpm typecheck` / `pnpm format:check` — must pass before a task is done
- `pnpm db:generate` — regenerate Prisma client after schema changes
- `pnpm db:migrate` — `prisma migrate dev` in packages/db
- `pnpm db:seed` — templates + demo tenants (shapla-school, alo-coaching)
- `pnpm db:reset` — drop + re-migrate + re-seed the local `jantrik` DB only (refuses production,
  remote hosts and any other DB name; `--dry-run` to check). Destructive: ask before running it
- Database rules, RLS and the new-table checklist: docs/database.md
- Auth, request pipeline, Db.tx / afterCommit rules for services: docs/auth.md
- UI design system (colours, Bangla type scale, density, components): docs/design.md
- `pnpm e2e` — Playwright (build first; stop dev servers on 3000/4000); resets and seeds jantrik_e2e every run
- Attendance rules, drafts/offline sync, absent SMS: docs/attendance.md
- Single package: `pnpm --filter @jantrik/api <script>`
