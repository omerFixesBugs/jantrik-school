import type { Prisma } from '@jantrik/db';
import { dateFromDb, dueBalance, type DueBalance, type IsoDate } from '@jantrik/shared';

/** A due row's balance on a day (the shared rule, fed from the database row). */
export function balanceOf(d: Prisma.FeeDueGetPayload<object>, asOf: IsoDate): DueBalance {
  return dueBalance(
    {
      status: d.status,
      amountPaisa: d.amountPaisa,
      concessionPaisa: d.concessionPaisa,
      paidPrincipalPaisa: d.paidPrincipalPaisa,
      paidFinePaisa: d.paidFinePaisa,
      principalClearedOn: d.principalClearedOn ? dateFromDb(d.principalClearedOn) : null,
      dueDate: dateFromDb(d.dueDate),
      fine: { type: d.fineType, amountPaisa: d.fineAmountPaisa, capPaisa: d.fineCapPaisa },
      fineWaivedPaisa: d.fineWaivedPaisa,
      fineWaivedAll: d.fineWaivedAll,
    },
    asOf,
  );
}
