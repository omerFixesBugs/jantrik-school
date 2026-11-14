import { NoSmsProvider, type SmsProvider } from './sms.providers.js';

describe('SMS_PROVIDER=none (no gateway yet)', () => {
  it('fails every send, so the job is retried and recorded as failed, and prints nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const sms: SmsProvider = new NoSmsProvider();
    await expect(sms.send('+8801712345678', 'code 123456')).rejects.toThrow(
      'no SMS gateway is configured (SMS_PROVIDER=none)',
    );
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
