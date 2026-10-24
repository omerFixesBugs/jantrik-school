import { Injectable } from '@nestjs/common';
import type { IsoDate, PunchFlag, PunchReview } from '@jantrik/shared';

/** A punch an admin has just reviewed. */
export interface ReviewedPunch {
  id: string;
  deviceUserId: string;
  localDate: IsoDate;
  flags: PunchFlag[];
  review: PunchReview;
  /** The decision it replaced (null when it was not reviewed before). */
  previousReview: PunchReview | null;
}

/**
 * What follows a punch review, inside the review's transaction. A review can change whether a
 * punch counts (`countsForAttendance`), so punch processing will rebuild the person's day here
 * (the student's DEVICE register record, the staff day). Until then it does nothing.
 */
@Injectable()
export class PunchReviewEffects {
  async afterReview(_punch: ReviewedPunch): Promise<void> {}
}
