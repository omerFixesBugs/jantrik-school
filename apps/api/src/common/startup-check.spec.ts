import {
  STARTUP_CHECK_TIMEOUT_MS,
  STARTUP_RETRY_DELAYS_MS,
  runStartupCheck,
  startupErrorLabel,
  type StartupCheck,
} from './startup-check.js';

/** A check whose run answers each call in turn: a value, a failure, or never ('hang'). */
function check(...answers: (string | Error | 'hang')[]) {
  const warn = vi.fn();
  const log = vi.fn();
  const run = vi.fn();
  for (const a of answers) {
    run.mockImplementationOnce(() =>
      a === 'hang'
        ? new Promise(() => undefined)
        : a instanceof Error
          ? Promise.reject(a)
          : Promise.resolve(a),
    );
  }
  const c: StartupCheck<string> = {
    run,
    verdict: (answer) => (answer === 'ok' ? true : `wrong answer: ${answer}`),
    retryDelaysMs: [0, 0, 0],
    checkTimeoutMs: 50,
    logger: { warn, log },
    what: 'the test login (TEST_URL)',
    unchecked: 'The test does not start unchecked.',
    label: (error) => (error as Error).name,
  };
  return { c, run, warn, log };
}

const failure = (name: string) => Object.assign(new Error('secret detail'), { name });

describe('runStartupCheck', () => {
  it('starts when the first answer is accepted, without logging', async () => {
    const { c, log, warn } = check('ok');
    await expect(runStartupCheck(c)).resolves.toBeUndefined();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses at once with the verdict text when the answer is wrong, never asking again', async () => {
    const { c, run } = check('bad', 'ok');
    await expect(runStartupCheck(c)).rejects.toThrow('wrong answer: bad');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('asks again while the check fails, warning with the label only, then starts', async () => {
    const { c, run, warn, log } = check(failure('Unreachable'), failure('Unreachable'), 'ok');
    await expect(runStartupCheck(c)).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toBe(
      'Start-up check failed (Unreachable): the database may not be ready yet; checking again in 0 s',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret detail');
    expect(log).toHaveBeenCalledWith('Start-up check passed');
  });

  it('refuses to start unchecked when the check still fails after the last wait', async () => {
    const { c, run } = check(...Array<Error>(4).fill(failure('Unreachable')));
    await expect(runStartupCheck(c)).rejects.toThrow(
      'Could not check the test login (TEST_URL): Unreachable. The test does not start unchecked.',
    );
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('counts a check with no answer in time as failed, and asks again', async () => {
    const { c, run } = check('hang', 'ok');
    await expect(runStartupCheck(c)).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('refuses to start when no check ever answers, instead of hanging', async () => {
    const { c } = check('hang', 'hang', 'hang', 'hang');
    await expect(runStartupCheck({ ...c, label: startupErrorLabel })).rejects.toThrow(
      /StartupCheckTimeout\. The test does not start unchecked/,
    );
  });

  it('ignores a late failure of a check that already timed out', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { c, run } = check('ok');
      run.mockReset();
      run.mockImplementationOnce(
        () => new Promise((_, reject) => setTimeout(() => reject(failure('Late')), 100)),
      );
      run.mockImplementationOnce(() => Promise.resolve('ok'));
      await expect(runStartupCheck(c)).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('waits 1, 2, 4 and 8 s, then every 15 s: about 3 minutes in all, 10 s per check', () => {
    expect(STARTUP_RETRY_DELAYS_MS.slice(0, 5)).toEqual([1000, 2000, 4000, 8000, 15000]);
    const total = STARTUP_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(170_000);
    expect(total).toBeLessThanOrEqual(190_000);
    expect(STARTUP_CHECK_TIMEOUT_MS).toBe(10_000);
  });
});

describe('startupErrorLabel', () => {
  it("is the error's name and codes plus the adapter's kind, never its message", () => {
    const unreachable = Object.assign(new Error("Can't reach database server at db:5432"), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2010',
      meta: { driverAdapterError: { cause: { kind: 'DatabaseNotReachable' } } },
    });
    expect(startupErrorLabel(unreachable)).toBe(
      'PrismaClientKnownRequestError P2010 DatabaseNotReachable',
    );
  });
});
