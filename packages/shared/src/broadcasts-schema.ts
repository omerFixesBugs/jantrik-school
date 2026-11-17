import { z } from 'zod';
import { BROADCAST_LIMITS, BROADCAST_RECIPIENTS } from './broadcasts.js';
import { noticeTargetSchema } from './notices-schema.js';

// Request bodies of the broadcasts API (sprint 1 P6b). The 3-segment rule is checked in the
// service (422 SMS_TOO_LONG, with the counts); the schema keeps the database's 480-character
// backstop.

const instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

/** POST /broadcasts and PUT /broadcasts/:id. The text is exactly what the admin typed (P6-M). */
export const broadcastInputSchema = z.object({
  body: z
    .string()
    .transform((v) => v.replace(/\r\n?/g, '\n'))
    .pipe(z.string().min(1).max(BROADCAST_LIMITS.bodyChars)),
  recipients: z.enum(BROADCAST_RECIPIENTS),
  /** Guardian recipients only; empty = every guardian. A STAFF broadcast takes none. */
  targets: z.array(noticeTargetSchema).max(BROADCAST_LIMITS.targets).default([]),
  noticeId: z
    .uuid()
    .nullish()
    .transform((v) => v ?? null),
});
export type BroadcastInput = z.output<typeof broadcastInputSchema>;
export type BroadcastInputBody = z.input<typeof broadcastInputSchema>;

/** POST /broadcasts/:id/send: the recipient count the admin confirmed in the preview. */
export const sendBroadcastSchema = z.object({
  expectedRecipients: z.number().int().min(0),
});

/** POST /broadcasts/:id/schedule. */
export const scheduleBroadcastSchema = z.object({
  scheduledAt: instant,
  expectedRecipients: z.number().int().min(0),
});
