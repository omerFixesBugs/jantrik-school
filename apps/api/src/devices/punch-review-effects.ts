import { Injectable } from '@nestjs/common';
import {
  countsForAttendance,
  type IsoDate,
  type PunchFlag,
  type PunchReview,
} from '@jantrik/shared';
import { PunchProcessingService } from './punch-processing.service.js';

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
 * What follows a punch review, inside the review's transaction (after the punch lock and the
 * punch row). Only a review that changes whether the punch counts (`countsForAttendance`) does
 * anything: an ACCEPT of a held punch, a REJECT, or an OK replacing either. The punch's outcome
 * follows and the person's day is rebuilt; no entry or exit SMS is sent.
 */
@Injectable()
export class PunchReviewEffects {
  constructor(private readonly processing: PunchProcessingService) {}

  async afterReview(punch: ReviewedPunch): Promise<void> {
    const counted = countsForAttendance({ flags: punch.flags, review: punch.previousReview });
    const counts = countsForAttendance({ flags: punch.flags, review: punch.review });
    if (counted !== counts) await this.processing.reviewed(punch.id);
  }
}
