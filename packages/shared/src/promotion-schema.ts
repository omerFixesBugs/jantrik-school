import { z } from 'zod';
import { isoDateSchema } from './dates-schema.js';
import { toAsciiDigits } from './digits.js';
import {
  LEAVE_STATUSES,
  PROMOTION_DECISIONS,
  PROMOTION_ROWS_PER_EDIT,
  ROLL_STRATEGIES,
} from './promotion.js';

// Request schemas of promotion (sprint 1 P5). Values and response types: promotion.ts.

/** A calendar date typed with ASCII or Bangla digits (YYYY-MM-DD only). */
const leaveDateSchema = z
  .string()
  .transform((v) => toAsciiDigits(v.trim()))
  .pipe(isoDateSchema);

const leaveReasonSchema = z
  .string()
  .trim()
  .max(500)
  .nullish()
  .transform((v) => v || null);

/** POST /students/:id/leave: leave with a status (never ACTIVE), a date and an optional reason. */
export const leaveSchema = z.object({
  status: z.enum(LEAVE_STATUSES),
  leftOn: leaveDateSchema,
  reason: leaveReasonSchema,
});
export type LeaveInput = z.infer<typeof leaveSchema>;

/** POST /promotions: a run for one class into the to-year. */
export const createPromotionRunSchema = z.object({
  fromYearId: z.uuid(),
  toYearId: z.uuid(),
  classLevelId: z.uuid(),
  rollStrategy: z.enum(ROLL_STRATEGIES).default('MERIT'),
  meritExamId: z
    .uuid()
    .nullish()
    .transform((v) => v ?? null),
});
export type CreatePromotionRunInput = z.infer<typeof createPromotionRunSchema>;

/** PATCH /promotions/:id. A merit exam of null means "no exam". */
export const updatePromotionRunSchema = z
  .object({
    rollStrategy: z.enum(ROLL_STRATEGIES).optional(),
    meritExamId: z.uuid().nullable().optional(),
  })
  .refine((v) => v.rollStrategy !== undefined || v.meritExamId !== undefined, {
    message: 'Nothing to change',
  });
export type UpdatePromotionRunInput = z.infer<typeof updatePromotionRunSchema>;

const rowEditSchema = z
  .object({
    id: z.uuid(),
    decision: z.enum(PROMOTION_DECISIONS),
    targetClassLevelId: z
      .uuid()
      .nullish()
      .transform((v) => v ?? null),
    targetSectionId: z
      .uuid()
      .nullish()
      .transform((v) => v ?? null),
    targetStudyGroupId: z
      .uuid()
      .nullish()
      .transform((v) => v ?? null),
    leaveStatus: z
      .enum(LEAVE_STATUSES)
      .nullish()
      .transform((v) => v ?? null),
    leftOn: leaveDateSchema.nullish().transform((v) => v ?? null),
    leaveReason: leaveReasonSchema,
  })
  .superRefine((r, ctx) => {
    if (r.decision === 'LEAVE') {
      if (r.targetClassLevelId || r.targetSectionId || r.targetStudyGroupId)
        ctx.addIssue({
          code: 'custom',
          message: 'A leaving row has no target',
          path: ['decision'],
        });
      if (!r.leaveStatus)
        ctx.addIssue({ code: 'custom', message: 'Required', path: ['leaveStatus'] });
      if (!r.leftOn) ctx.addIssue({ code: 'custom', message: 'Required', path: ['leftOn'] });
    } else {
      if (!r.targetClassLevelId)
        ctx.addIssue({ code: 'custom', message: 'Required', path: ['targetClassLevelId'] });
      if (r.leaveStatus || r.leftOn || r.leaveReason)
        ctx.addIssue({
          code: 'custom',
          message: 'Only a leaving row has these',
          path: ['decision'],
        });
    }
  });
export type PromotionRowEdit = z.infer<typeof rowEditSchema>;

/** PUT /promotions/:id/rows: bulk edit of pending rows. */
export const promotionRowsSchema = z.object({
  rows: z
    .array(rowEditSchema)
    .min(1)
    .max(PROMOTION_ROWS_PER_EDIT)
    .refine((rows) => new Set(rows.map((r) => r.id)).size === rows.length, {
      message: 'A row appears twice',
    }),
});
export type PromotionRowsInput = z.infer<typeof promotionRowsSchema>;

/** POST /promotions/:id/apply: the version of the apply-check the admin saw. */
export const applyPromotionSchema = z.object({ version: z.string().min(1).max(128) });

export const promotionsQuerySchema = z.object({ toYearId: z.uuid() });

export const rollsPreviewQuerySchema = z.object({ toYearId: z.uuid(), classLevelId: z.uuid() });

const rollValueSchema = z.preprocess(
  (v) => (typeof v === 'string' ? Number(toAsciiDigits(v.trim())) : v),
  z.number().int().min(1).max(9999),
);

/** PUT /promotions/rolls: rolls for enrolments that have none (MANUAL edits included). */
export const numberRollsSchema = z.object({
  toYearId: z.uuid(),
  classLevelId: z.uuid(),
  version: z.string().min(1).max(128),
  sections: z
    .array(
      z.object({
        sectionId: z.uuid(),
        rolls: z
          .array(z.object({ enrolmentId: z.uuid(), roll: rollValueSchema }))
          .max(2000)
          .superRefine((rolls, ctx) => {
            const seen = new Set<number>();
            const ids = new Set<string>();
            for (const [i, r] of rolls.entries()) {
              if (seen.has(r.roll))
                ctx.addIssue({ code: 'custom', message: 'Duplicate roll', path: [i, 'roll'] });
              if (ids.has(r.enrolmentId))
                ctx.addIssue({ code: 'custom', message: 'Duplicate', path: [i, 'enrolmentId'] });
              seen.add(r.roll);
              ids.add(r.enrolmentId);
            }
          }),
      }),
    )
    .min(1)
    .max(50),
});
export type NumberRollsInput = z.infer<typeof numberRollsSchema>;

export const switchCheckQuerySchema = z.object({ toYearId: z.uuid() });
