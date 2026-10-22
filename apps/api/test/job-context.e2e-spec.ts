import { randomUUID } from 'node:crypto';
import { withTenant } from '@jantrik/db';
import { AttendanceSettingsService } from '../src/attendance/attendance-settings.service.js';
import { AuditService } from '../src/audit/audit.module.js';
import { RequestContext } from '../src/common/request-context.js';
import { TenantJobRunner } from '../src/tenancy/tenant-job-runner.service.js';
import { createHarness, createStudent, createTenant, type Harness } from './support/harness.js';

/** Background work without a person (the nightly fee dues run): audit and the SMS cap. */
describe('jobs without an actor', () => {
  let h: Harness;
  let tenantId: string;

  beforeAll(async () => {
    h = await createHarness();
    tenantId = (await createTenant(h, { modules: ['FEES'] })).id;
  });
  afterAll(() => h.close());

  it('writes audit rows with no actor inside a job', async () => {
    const entityId = randomUUID();
    await h.app
      .get(TenantJobRunner)
      .run(tenantId, () =>
        h.app
          .get(AuditService)
          .record({ entity: 'job_test', entityId, action: 'CREATE', newValues: { n: 1 } }),
      );
    const rows = await withTenant(h.prisma, tenantId, (tx) =>
      tx.auditLog.findMany({ where: { entityId } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId, actorUserId: null, entity: 'job_test' });
  });

  it('still refuses audit rows outside any request or job', async () => {
    await expect(
      h.app
        .get(AuditService)
        .record({ entity: 'job_test', entityId: randomUUID(), action: 'CREATE' }),
    ).rejects.toThrow();
  });

  it('knows the job tenant only inside the job', async () => {
    const context = h.app.get(RequestContext);
    expect(() => context.requireTenantId()).toThrow();
    await expect(
      h.app.get(TenantJobRunner).run(tenantId, async () => context.requireTenantId()),
    ).resolves.toBe(tenantId);
  });

  it('reads the daily SMS cap for other modules (automatic: 2 × active students)', async () => {
    await createStudent(h, tenantId, 'CAP-1');
    await createStudent(h, tenantId, 'CAP-2');
    const settings = h.app.get(AttendanceSettingsService);
    const runner = h.app.get(TenantJobRunner);
    await expect(runner.run(tenantId, () => settings.smsDailyCap())).resolves.toBe(4);

    await withTenant(h.prisma, tenantId, (tx) =>
      tx.attendanceSettings.update({ where: { tenantId }, data: { dailySmsCap: 50 } }),
    );
    await expect(runner.run(tenantId, () => settings.smsDailyCap())).resolves.toBe(50);
  });
});
