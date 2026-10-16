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

## How Claude should work in this repo
- For any non-trivial task: **propose a plan first**, wait for approval, then implement.
- Keep changes small and focused on the task asked. Don't refactor unrelated code.
- Write tests for business logic (grading, fee calculation, tenant isolation).
- After finishing, list: files changed, how to run/test it, and anything left undone.
- Run lint, typecheck and tests before saying a task is done.
- If something in this file conflicts with a request, ask before proceeding.

## Commands
(Fill in once the monorepo is scaffolded.)
- `pnpm dev` —
- `pnpm test` —
- `pnpm lint` —
- `pnpm db:migrate` —
