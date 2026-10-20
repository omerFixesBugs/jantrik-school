# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Institute staff at a desk, most of the day:** owners and principals (OWNER), office admins
  (ADMIN) and accountants (ACCOUNTANT). They admit students, fix records, import Excel sheets,
  read attendance and, later, collect fees and publish results. Typical screens are office
  laptops and desktops, from 1366 × 768 up to 1920 × 1080.
- **Teachers (TEACHER):** mostly on their own Android phones in the classroom, taking attendance
  for their sections, often one-handed and in bright light.
- **Guardians (GUARDIAN):** parents on phones, signing in with an SMS code only, to see their
  children's attendance and notices.
- **Jantrik platform staff:** run the service from a desk in `/platform`: institutes, owner
  invitations, plans, invoices, SMS usage and costs.

Many institute users are not comfortable with software and read Bangla first.

## Product Purpose

A multi-tenant SaaS for education institutes in Bangladesh (later other countries): general
schools (NCTB Bangla and English version), English medium, Aliya, model, Qawmi and Hifz
madrasas, coaching centres, technical and vocational institutes, kindergartens. It runs the
institute's office work: students and guardians, classes and sections, attendance with absent
SMS, then fees, exams and results, and guardian notifications. Success: an office can run its
day in it faster than on paper and Excel, and guardians trust what it tells them.

## Positioning

- Bangla first, in the words the office already uses, with English alongside.
- Each institute type loads a template (classes, subjects, grading, calendar, labels), so a
  coaching centre reads "Course and Batch" and a school "Class and Section", from data, never
  from special cases.
- Features are modules, enabled and billed per institute.
- Guardians need no password: an SMS code on the phone number the institute has on file.

## Operating Context

- School and madrasa offices: shared laptops, slow or unreliable internet, printed registers
  (A4 landscape), Excel sheets handed over by the previous system.
- Classrooms: a teacher marking 40–60 students on a phone; attendance drafts survive a lost
  connection.
- Outdoors and in bright rooms: phone screens in sunlight.
- The Bangla academic and civil calendar (the Bangla date appears beside the Gregorian one).

## Capabilities and Constraints

- Phase 1 (MVP) scope only: core (tenants, branches, academic years, users and roles, classes,
  sections, subjects, students, guardians), attendance, fees, exams and results, guardian
  notifications. Fees and exams screens are placeholders until those modules are built. No
  hostel, transport or AI tutor yet.
- MVP launch types: coaching centre and NCTB school.
- Stack is decided: Next.js (App Router) + Tailwind + shadcn/ui, NestJS, Prisma + PostgreSQL 16
  with row-level security, Redis + BullMQ. A mobile app (Expo) comes later in Phase 1.
- Languages: Bangla and English now; Arabic later (right-to-left must stay possible).
- Digits: Bangla digits in the Bangla UI for dates, times, counts and money; ASCII digits always
  for phone numbers, student codes, roll numbers, registration numbers and IDs.
- Money is integer paisa, shown in taka (৳). Dates are stored in UTC and shown in Asia/Dhaka.
- Every page belongs to a module and a set of roles; screens show only what the role may see.

## Brand Commitments

- Name: **Jantrik School** / **যন্ত্রিক স্কুল**.
- Voice: Bangla written the way people speak to a respected colleague (আপনি), buttons are verbs,
  no apologies in errors, no hype.
- Open for design v2 (decided 2026-10-21): the colours, the mark and the alphabet-chart pattern
  may be reworked, not only density, layout and typography.

## Evidence on Hand

- Only seeded demo data: two demo institutes (শাপলা উচ্চ বিদ্যালয়, আলো কোচিং সেন্টার) with
  demo staff, students and guardians (`docs/demo-accounts.md`).
- No real customers, testimonials, usage numbers or press yet. Do not invent any.

## Product Principles

1. **Numbers must be unmistakable.** Counts, money, dates and rolls are read and acted on (a
   guardian called, a fee collected); a digit that can be misread is a defect, not a style issue.
2. **The office's time is the product.** Staff who work in it all day get dense, fast, keyboard-
   friendly screens; nothing makes them scroll or click for what one screen could show.
3. **The phone is a first-class tool.** Teachers and guardians get large, calm, thumb-friendly
   screens with one obvious next action.
4. **Never fake it.** A module that is not running says so and what will appear; no placeholder
   numbers or charts.
5. **Every institute sees only itself.** Names, labels and data come from the institute's own
   records and template.

## Accessibility & Inclusion

- WCAG 2.2 AA: text contrast at least 4.5:1, visible focus on everything, full keyboard use.
- Touch targets at least 44 × 44 px on phones.
- Bangla text never smaller than the readable minimum, never letter-spaced, never clipped.
- Status never by colour alone (sunlight, colour blindness): always a word or an icon too.
- Works on low-end Android phones and slow networks.
