import { z } from 'zod';
import { NOTICE_AUDIENCES, NOTICE_LIMITS as L } from './notices.js';

// Request bodies of the notices API (sprint 1 P6a). Each rule matches a CHECK on `notices`, so a
// value the schema accepts is never refused by the database.

/** Line endings normalised; trailing spaces trimmed (the CHECK counts the trimmed title). */
const plain = (max: number) =>
  z
    .string()
    .transform((v) => v.replace(/\r\n?/g, '\n').trim())
    .pipe(z.string().min(1).max(max));

const instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

export const noticeTargetSchema = z.object({
  classLevelId: z.uuid(),
  sectionId: z
    .uuid()
    .nullish()
    .transform((v) => v ?? null),
});

/** POST /notices and PUT /notices/:id. */
export const noticeInputSchema = z.object({
  title: plain(L.title),
  body: plain(L.body),
  audience: z.enum(NOTICE_AUDIENCES),
  /** Guardians only (P6-G); empty = everyone of the audience. */
  targets: z.array(noticeTargetSchema).max(L.targets).default([]),
  expiresAt: instant.nullish().transform((v) => v ?? null),
  pinned: z.boolean().default(false),
});
export type NoticeInput = z.output<typeof noticeInputSchema>;
export type NoticeInputBody = z.input<typeof noticeInputSchema>;

/** POST /notices/:id/publish: now (no publishAt) or later, at most 30 days ahead. */
export const publishNoticeSchema = z.object({
  publishAt: instant.nullish().transform((v) => v ?? null),
});

/** POST /notices/:id/withdraw. */
export const withdrawNoticeSchema = z.object({
  reason: plain(L.withdrawnReason),
});
