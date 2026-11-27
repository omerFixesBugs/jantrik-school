import { getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { withTenant } from '@jantrik/db';
import { newTranId } from '@jantrik/shared';
import type { Queue } from 'bullmq';
import { CONFIRM_JOB, PAYMENTS_QUEUE } from '../src/payments/payments.constants.js';
import { startFakeSslcommerz, type FakeSslcommerz } from './support/fake-sslcommerz.js';
import { createHarness, http, randomIp, type Harness } from './support/harness.js';
import {
  onlineSchool,
  payAtGateway,
  postIpn,
  postReturn,
  PUBLIC_API,
  PUBLIC_WEB,
  SSLCOMMERZ_IP,
  startPayment,
  type OnlineSchool,
} from './support/payments.js';

// The public return and IPN routes (sprint 1 P7a2, Task 15): the signal is stored through the
// definer function and a confirmation queued; nothing in it is trusted (S23). The worker is
// paused here, so the queued jobs can be looked at (confirmation is payments-settle's).

describe('online payments: the public signal routes', () => {
  let h: Harness;
  let fake: FakeSslcommerz;
  let s: OnlineSchool;
  let queue: Queue;
  /** The intent the tests signal about, and its tran_id. */
  let intentId: string;
  let tranId: string;

  const events = (where: Record<string, unknown> = {}) =>
    withTenant(h.prisma, s.tenantId, (tx) =>
      tx.paymentGatewayEvent.findMany({ where: { kind: { in: ['RETURN', 'IPN'] }, ...where } }),
    );
  /** This institute's confirm jobs (the queue is shared with the other test files). */
  const confirmJobs = async () =>
    (await queue.getJobs(['wait', 'waiting', 'delayed', 'prioritized'])).filter(
      (j) => j.name === CONFIRM_JOB && j.data.tenantId === s.tenantId,
    );

  beforeAll(async () => {
    fake = await startFakeSslcommerz();
    fake.sendIpn = false;
    h = await createHarness({
      payments: { sslcommerzBaseUrl: fake.url, apiPublicUrl: PUBLIC_API, webPublicUrl: PUBLIC_WEB },
    });
    s = await onlineSchool(h, fake);
    const view = await startPayment(h, s.tokens.guardian, s.students[0]!.id);
    intentId = view.id;
    tranId = view.tranId;
    queue = h.app.get<Queue>(getQueueToken(PAYMENTS_QUEUE));
    // Nothing is confirmed while these tests look at what was queued.
    await queue.pause();
  });

  afterAll(async () => {
    await queue.resume();
    await h.close();
    await fake.close();
  });

  it('a success return: 303 to the payment page, a RETURN event, a confirm job', async () => {
    const t = await payAtGateway(h, fake, s.tenantId, intentId);
    const res = await postReturn(h, s.slug, tranId, 'success', {
      tran_id: tranId,
      val_id: t.valId,
      status: 'VALID',
      amount: '1.00',
      card_no: '41111XXXXXX1111',
    });
    expect(res.status).toBe(303);
    expect(res.headers['location']).toBe(
      `${PUBLIC_WEB}/children/${s.students[0]!.id}/fees/pay/${intentId}?from=gateway`,
    );
    const [event] = await events({ kind: 'RETURN' });
    expect(event).toMatchObject({
      intentId,
      outcome: 'SUCCESS',
      tranId,
      valId: t.valId,
      sourceListed: false,
      // Stored as a hint, never trusted; never the card number.
      fields: { status: 'VALID', amount: '1.00' },
    });
    expect((await confirmJobs()).map((j) => j.data)).toEqual([{ tenantId: s.tenantId, intentId }]);
  });

  it('GET works like POST (the docs do not say which, P7a-N); fail and cancel too', async () => {
    const res = await http(h)
      .get(`/public/payments/sslcommerz/${s.slug}/return/${tranId}/cancel`)
      .query({ tran_id: tranId, status: 'CANCELLED' })
      .set('X-Forwarded-For', randomIp());
    expect(res.status).toBe(303);
    expect(res.headers['location']).toContain(`/fees/pay/${intentId}`);
    expect((await events({ kind: 'RETURN', outcome: 'CANCEL' })).length).toBe(1);
    expect((await postReturn(h, s.slug, tranId, 'fail', { status: 'FAILED' })).status).toBe(303);
    expect((await events({ kind: 'RETURN', outcome: 'FAIL' })).length).toBe(1);
  });

  it('a return for a tran_id this institute never made, or a bad path: 303 to the children, nothing stored', async () => {
    const before = (await events()).length;
    for (const [slug, tran, outcome] of [
      [s.slug, newTranId(), 'success'],
      [s.slug, 'NOT-OURS-123', 'success'],
      [s.slug, tranId, 'paid'],
      ['no-such-school', tranId, 'success'],
    ] as const) {
      const res = await http(h)
        .post(`/public/payments/sslcommerz/${slug}/return/${tran}/${outcome}`)
        .set('X-Forwarded-For', randomIp())
        .type('form')
        .send({ status: 'VALID' });
      expect(res.status, `${slug} ${tran} ${outcome}`).toBe(303);
      expect(res.headers['location']).toBe(`${PUBLIC_WEB}/children`);
    }
    expect(await events()).toHaveLength(before);
  });

  it('an IPN: 200 OK, an IPN event with whitelisted fields only, one confirm job for three alike', async () => {
    const t = await payAtGateway(h, fake, s.tenantId, intentId);
    const body = {
      tran_id: tranId,
      val_id: t.valId,
      status: 'VALID',
      amount: t.fields['amount']!,
      currency: 'BDT',
      bank_tran_id: t.fields['bank_tran_id']!,
      card_no: '01711XXXXXX',
      verify_sign: 'd41d8cd98f00b204e9800998ecf8427e',
      verify_key: 'amount,status',
      value_a: intentId,
      cus_name: 'Someone',
      store_id: s.store.storeId,
    };
    for (let i = 0; i < 3; i++) {
      const res = await postIpn(h, s.slug, body);
      expect(res.status).toBe(200);
      expect(res.text).toBe('OK');
    }
    const ipns = await events({ kind: 'IPN', valId: t.valId });
    expect(ipns).toHaveLength(3);
    expect(ipns[0]).toMatchObject({
      intentId,
      sourceListed: true,
      outcome: null,
      fields: {
        status: 'VALID',
        amount: t.fields['amount'],
        currency: 'BDT',
        bank_tran_id: t.fields['bank_tran_id'],
      },
    });
    expect(JSON.stringify(ipns)).not.toMatch(/01711XXXXXX|d41d8cd9|Someone|amount,status/);
    expect(JSON.stringify(ipns)).not.toContain(s.store.storeId);
    // One job per intent, however many signals (jobId confirm-<intentId>).
    expect(await confirmJobs()).toHaveLength(1);
  });

  it('an IPN for a tran_id the institute does not have: stored with no intent, an unmatched check queued', async () => {
    const other = newTranId();
    const res = await postIpn(h, s.slug, {
      tran_id: other,
      val_id: 'VALELSEWHERE01',
      status: 'VALID',
    });
    expect(res.status).toBe(200);
    const [event] = await events({ tranId: other });
    expect(event).toMatchObject({ kind: 'IPN', intentId: null, valId: 'VALELSEWHERE01' });
    const unmatched = (await queue.getJobs(['wait', 'waiting'])).filter(
      (j) => j.name === 'unmatched-check' && j.data.eventId === event!.id,
    );
    expect(unmatched).toHaveLength(1);
    // An unknown slug: OK, nothing anywhere.
    expect((await postIpn(h, 'no-such-school', { tran_id: tranId, status: 'VALID' })).text).toBe(
      'OK',
    );
  });

  it('a malformed IPN: 200 OK, nothing stored, no institute budget spent', async () => {
    const before = (await events()).length;
    for (const send of [
      () => postIpn(h, s.slug, { status: 'VALID' }, randomIp()), // no tran_id
      () => postIpn(h, s.slug, { tran_id: "JS' OR 1=1" }, randomIp()),
      () =>
        http(h)
          .post(`/public/payments/sslcommerz/${s.slug}/ipn`)
          .set('X-Forwarded-For', randomIp())
          .set('Content-Type', 'application/json')
          .send(JSON.stringify({ tran_id: tranId })),
      () =>
        http(h)
          .post(`/public/payments/sslcommerz/${s.slug}/ipn`)
          .set('X-Forwarded-For', randomIp())
          .type('form')
          .send({ tran_id: tranId, filler: 'x'.repeat(17 * 1024) }),
    ]) {
      const res = await send();
      expect(res.status).toBe(200);
      expect(res.text).toBe('OK');
    }
    expect(await events()).toHaveLength(before);
    expect(await h.redis.get(`rl:pay-ipn-tenant:${s.slug}`)).toBeNull();
  });

  it('limits (P7a-C): 30 a minute from an unlisted address, 120 an hour per institute; SSLCommerz always gets through', async () => {
    // A tran_id of its own each time, so no payment's own budget (below) is reached first.
    const ipn = (ip: string) => postIpn(h, s.slug, { tran_id: newTranId(), status: 'VALID' }, ip);
    const ip = randomIp();
    for (let i = 0; i < 30; i++) {
      expect((await ipn(ip)).status).toBe(200);
    }
    expect((await ipn(ip)).status).toBe(429);
    // The institute's budget for unlisted senders: 120 an hour (90 left after the 30 above).
    for (let i = 0; i < 90; i++) {
      expect((await ipn(randomIp())).status).toBe(200);
    }
    expect((await ipn(randomIp())).status).toBe(429);
    // SSLCommerz's own address is not held back by either.
    expect((await ipn(SSLCOMMERZ_IP)).status).toBe(200);
  });

  it('a 61st return in a minute from one address: still 303, nothing recorded (the page heals)', async () => {
    const ip = randomIp();
    // Returns for tran_ids this institute never made spend the address's budget too.
    for (let i = 0; i < 60; i++) {
      await postReturn(h, s.slug, newTranId(), 'success', { status: 'VALID' }, ip).expect(303);
    }
    const before = (await events({ kind: 'RETURN' })).length;
    const res = await postReturn(h, s.slug, tranId, 'success', { status: 'VALID' }, ip);
    expect(res.status).toBe(303);
    expect(res.headers['location']).toBe(`${PUBLIC_WEB}/children`);
    expect(await events({ kind: 'RETURN' })).toHaveLength(before);
  });

  it("a flood of returns from other addresses never keeps the payer's own signals out (P7a2-x23): no per-payment count before storing", async () => {
    // Anyone with the tran_id (every guardian of the child; it is in the return URL) sends
    // returns with made-up val_ids from many addresses. The bound lives in confirm, where the
    // gateway is asked (payments-settle); a signal is never refused on a count others can spend.
    // The worker is paused here: the payment stays CREATED, which is enough to name it.
    const view = await startPayment(h, s.tokens.guardian, s.students[1]!.id, { wait: false });
    for (let i = 0; i < 25; i++) {
      const valId = `VALFLOOD${String(i).padStart(4, '0')}`;
      const res = await postReturn(h, s.slug, view.tranId, 'success', { val_id: valId }, randomIp());
      expect(res.status).toBe(303);
      expect(res.headers['location']).toContain(`/fees/pay/${view.id}`);
    }
    // The payer's own browser, from an address of its own: recorded and sent to the payment.
    const genuine = await postReturn(
      h,
      s.slug,
      view.tranId,
      'success',
      { val_id: 'VALGENUINE0001' },
      randomIp(),
    );
    expect(genuine.headers['location']).toContain(`/fees/pay/${view.id}`);
    expect(
      (await events({ intentId: view.id, kind: 'RETURN', valId: 'VALGENUINE0001' })).length,
    ).toBe(1);
    // SSLCommerz's notification: stored too.
    expect(
      (await postIpn(h, s.slug, { tran_id: view.tranId, status: 'VALID' }, SSLCOMMERZ_IP)).status,
    ).toBe(200);
    expect(await events({ intentId: view.id, kind: 'RETURN' })).toHaveLength(26);
    expect(await events({ intentId: view.id, kind: 'IPN' })).toHaveLength(1);
  });

  it('nothing from a body reaches the logs', async () => {
    const logged: string[] = [];
    const levels = ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const;
    const spies = levels.map((level) =>
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => JSON.stringify(a)).join(' '));
      }),
    );
    try {
      const marker = 'BODYMARKER77';
      await postIpn(h, s.slug, { tran_id: tranId, val_id: marker, risk_title: marker });
      await postReturn(h, s.slug, tranId, 'success', { val_id: marker, error: marker });
      await postIpn(h, s.slug, { tran_id: marker, status: marker }, randomIp());
      expect(logged.join('\n')).not.toContain(marker);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
